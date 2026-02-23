/**
 * TransactionBuilder - Epoch-aware transaction building for deposits, withdrawals,
 * transfers, renewals, and epoch lifecycle operations.
 *
 * Epoch Architecture:
 * - Deposits go into the current active epoch's Merkle tree
 * - Withdrawals and transfers consume notes from active/frozen epochs
 * - Renewals migrate notes from expiring epochs to the current epoch
 * - Epoch lifecycle (rollover, finalize, GC) is permissionless
 */

import {
  Transaction,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
  Connection,
} from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Note,
  SpendingKeys,
  MerkleProof,
  EpochInfo,
  EpochState,
  GarbageCollectInfo,
  PoolConfig,
} from "./types";
import {
  ProverArtifacts,
  ProverOptions,
  proveWithdraw,
  proveTransfer,
  proveRenew,
} from "./prover";
import { EpochMerkleTree, EpochMerkleTreeManager } from "./merkle";
import { computeNullifier, serializeNote, encryptNote } from "./crypto";
import {
  MERKLE_CONFIG,
  PDA_SEEDS,
  EPOCH_TIMING,
  PROVER_ARTIFACTS,
} from "./config";

/**
 * Result of building a transaction that includes rent recovery information
 */
export interface TransactionWithGCInfo {
  transaction: Transaction;
  gcInfo?: GarbageCollectInfo;
}

/**
 * Epoch-aware transaction builder for the shielded pool
 */
export class TransactionBuilder {
  private program: Program;
  private poolConfigPda: PublicKey;
  private connection: Connection;

  constructor(
    program: Program,
    poolConfigPda: PublicKey,
    connection: Connection,
  ) {
    this.program = program;
    this.poolConfigPda = poolConfigPda;
    this.connection = connection;
  }

  // ============================================================
  // EPOCH LIFECYCLE OPERATIONS (Permissionless)
  // ============================================================

  /**
   * Build a transaction to rollover to a new epoch.
   * This freezes the current epoch and creates a new active epoch.
   * Can be called by anyone once conditions are met.
   */
  async buildRolloverEpoch(
    caller: PublicKey,
    newEpoch: bigint,
  ): Promise<Transaction> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));

    const epochBytes = this.epochToBytes(newEpoch);
    const currentEpoch = newEpoch - 1n;
    const currentEpochBytes = this.epochToBytes(currentEpoch);

    // Derive PDAs for current and new epoch trees
    const [currentEpochTree] = this.deriveEpochTree(currentEpoch);
    const [newEpochTree] = this.deriveEpochTree(newEpoch);

    const ix = await (this.program.methods as any)
      .rolloverEpoch(new BN(newEpoch.toString()))
      .accounts({
        poolConfig: this.poolConfigPda,
        currentEpochTree,
        newEpochTree,
        caller,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    tx.add(ix);
    return tx;
  }

  /**
   * Build a transaction to finalize an epoch after its freeze period.
   * This computes the final Merkle root and marks the epoch as finalized.
   */
  async buildFinalizeEpoch(
    caller: PublicKey,
    epoch: bigint,
  ): Promise<Transaction> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

    const [epochTree] = this.deriveEpochTree(epoch);

    const ix = await (this.program.methods as any)
      .finalizeEpoch(new BN(epoch.toString()))
      .accounts({
        poolConfig: this.poolConfigPda,
        epochTree,
        caller,
      })
      .instruction();

    tx.add(ix);
    return tx;
  }

  /**
   * Build a transaction to garbage collect an expired epoch.
   * Returns rent to the caller from closed accounts.
   */
  async buildGarbageCollect(
    caller: PublicKey,
    epoch: bigint,
  ): Promise<TransactionWithGCInfo> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));

    const [epochTree] = this.deriveEpochTree(epoch);

    // Estimate rent recovery
    const epochTreeInfo = await this.connection.getAccountInfo(epochTree);
    const estimatedRentRecovery = epochTreeInfo?.lamports ?? 0;

    // Find all leaf chunks for this epoch that can be GC'd
    const leafChunks = await this.findEpochLeafChunks(epoch);
    let totalRentRecovery = estimatedRentRecovery;

    for (const chunkInfo of leafChunks) {
      totalRentRecovery += chunkInfo.lamports;
    }

    const ix = await (this.program.methods as any)
      .gcEpochTree(new BN(epoch.toString()))
      .accounts({
        poolConfig: this.poolConfigPda,
        epochTree,
        collector: caller,
      })
      .instruction();

    // GC leaf chunks via separate instructions
    for (const chunkInfo of leafChunks) {
      const leafIx = await (this.program.methods as any)
        .gcLeafChunk(new BN(epoch.toString()), chunkInfo.chunkIndex)
        .accounts({
          poolConfig: this.poolConfigPda,
          leafChunk: chunkInfo.pubkey,
          collector: caller,
        })
        .instruction();
      tx.add(leafIx);
    }

    tx.add(ix);

    return {
      transaction: tx,
      gcInfo: {
        epochsAvailable: [epoch],
        estimatedRentRecovery: BigInt(totalRentRecovery),
        accountsToClose: 1 + leafChunks.length,
      },
    };
  }

  // ============================================================
  // DEPOSIT
  // ============================================================

  /**
   * Build a deposit transaction into the current active epoch
   */
  async buildDeposit(
    depositor: PublicKey,
    outputNote: Note,
    epochTree: EpochMerkleTree,
  ): Promise<Transaction> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

    // Fetch pool config to get mint and current epoch
    const poolConfigData = await this.fetchPoolConfig();
    const mint = new PublicKey(poolConfigData.mint);
    const currentEpoch = BigInt(poolConfigData.currentEpoch.toString());

    // Validate we're depositing to the active epoch
    if (epochTree.epoch !== currentEpoch) {
      throw new Error(
        `Cannot deposit to epoch ${epochTree.epoch}, current active epoch is ${currentEpoch}`,
      );
    }

    // Derive PDAs
    const [epochTreePda] = this.deriveEpochTree(currentEpoch);
    const [vaultAuthority] = this.deriveVaultAuthority(mint);

    // Get next leaf index in this epoch's tree
    const nextLeafIndex = epochTree.getNextIndex();
    const [leafChunk] = this.deriveEpochLeafChunk(currentEpoch, nextLeafIndex);

    // Token accounts
    const userTokenAccount = getAssociatedTokenAddressSync(
      mint,
      depositor,
      false,
    );
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
    );

    // Serialize and encrypt note
    const serialized = serializeNote(
      outputNote.value,
      outputNote.token.toBytes(),
      outputNote.owner,
      outputNote.randomness,
      outputNote.memo,
    );
    const encrypted = encryptNote(serialized, outputNote.owner);

    // Ensure leaf chunk exists
    const leafChunkInfo = await this.connection.getAccountInfo(leafChunk);
    if (!leafChunkInfo) {
      const initLeafChunkIx = await (this.program.methods as any)
        .initializeEpochLeafChunk(
          new BN(currentEpoch.toString()),
          Math.floor(nextLeafIndex / MERKLE_CONFIG.LEAVES_PER_CHUNK),
        )
        .accounts({
          leafChunk,
          epochTree: epochTreePda,
          poolConfig: this.poolConfigPda,
          payer: depositor,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(initLeafChunkIx);
    }

    // Build deposit instruction
    const depositAmount = new BN(outputNote.value.toString());

    const ix = await (this.program.methods as any)
      .depositV2(
        depositAmount,
        Array.from(outputNote.commitment),
        Array.from(encrypted.encrypted),
        Array.from(encrypted.nonce),
      )
      .accounts({
        poolConfig: this.poolConfigPda,
        epochTree: epochTreePda,
        leafChunk,
        vaultAuthority,
        mint,
        vaultTokenAccount,
        userTokenAccount,
        user: depositor,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    tx.add(ix);
    return tx;
  }

  // ============================================================
  // WITHDRAW
  // ============================================================

  /**
   * Build a withdrawal transaction spending a note from a specific epoch
   */
  async buildWithdraw(
    inputNote: Note,
    spendingKeys: SpendingKeys,
    recipient: PublicKey,
    withdrawAmount: bigint,
    epochTree: EpochMerkleTree,
    proverArtifacts?: ProverArtifacts,
    proverOptions?: ProverOptions,
  ): Promise<Transaction> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));

    // Validate note epoch matches tree
    if (inputNote.epoch !== epochTree.epoch) {
      throw new Error(
        `Note epoch ${inputNote.epoch} does not match tree epoch ${epochTree.epoch}`,
      );
    }

    const epoch = epochTree.epoch;
    const leafIndex = inputNote.leafIndex ?? 0;

    // Fetch pool config
    const poolConfigData = await this.fetchPoolConfig();
    const mint = new PublicKey(poolConfigData.mint);

    // Validate epoch is spendable (active or frozen, not finalized/expired)
    await this.validateEpochSpendable(epoch);

    // Derive PDAs
    const [epochTreePda] = this.deriveEpochTree(epoch);
    const [vaultAuthority] = this.deriveVaultAuthority(mint);
    const [withdrawVerifier] = this.deriveVerifierConfig("withdraw");

    // Compute epoch-aware nullifier
    const nullifier = await computeNullifier(
      inputNote.commitment,
      spendingKeys.nullifierKey,
      epoch,
      leafIndex,
    );

    // Derive NullifierMarker PDA (O(1) lookup)
    const [nullifierMarker] = this.deriveNullifierMarker(epoch, nullifier);

    // Check if nullifier already exists (double-spend check)
    const nullifierInfo = await this.connection.getAccountInfo(nullifierMarker);
    if (nullifierInfo) {
      throw new Error("Note has already been spent (nullifier exists)");
    }

    // Get Merkle proof
    const merkleProof = epochTree.getProof(leafIndex);
    const merkleRoot = epochTree.getRoot();

    // Token accounts
    const userTokenAccount = getAssociatedTokenAddressSync(
      mint,
      recipient,
      false,
    );
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
    );

    // Generate proof

    const artifacts = proverArtifacts || PROVER_ARTIFACTS.withdraw;
    const { proof, publicInputs } = await proveWithdraw(
      artifacts,
      {
        note: inputNote,
        spendingKeys,
        merkleProof,
        merkleRoot,
        recipient,
        amount: withdrawAmount,
        poolConfig: this.poolConfigPda,
        epoch,
        leafIndex,
      },
      proverOptions,
    );


    const proofBytes = Buffer.concat([
      Buffer.from(proof.a),
      Buffer.from(proof.b),
      Buffer.from(proof.c),
    ]);

    // Build withdraw instruction
    const ix = await (this.program.methods as any)
      .withdrawV2(
        proofBytes,
        publicInputs,
        new BN(withdrawAmount.toString()),
        new BN(epoch.toString()),
        leafIndex,
      )
      .accounts({
        poolConfig: this.poolConfigPda,
        epochTree: epochTreePda,
        nullifierMarker,
        vaultAuthority,
        mint,
        vaultTokenAccount,
        userTokenAccount,
        user: recipient,
        tokenProgram: TOKEN_PROGRAM_ID,
        verifierConfig: withdrawVerifier,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    tx.add(ix);
    return tx;
  }

  // ============================================================
  // TRANSFER
  // ============================================================

  /**
   * Build a shielded transfer transaction.
   * Input notes can come from different epochs; outputs go to current epoch.
   */
  async buildTransfer(
    inputNotes: Note[],
    outputNotes: Note[],
    spendingKeys: SpendingKeys,
    epochManager: EpochMerkleTreeManager,
    proverArtifacts?: ProverArtifacts,
    proverOptions?: ProverOptions,
  ): Promise<Transaction> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));

    // Pad to 2 inputs/outputs
    while (inputNotes.length < 2) {
      inputNotes.push(this.createDummyNote());
    }
    while (outputNotes.length < 2) {
      outputNotes.push(this.createDummyNote());
    }

    const inputTuple: [Note, Note] = [inputNotes[0], inputNotes[1]];
    const outputTuple: [Note, Note] = [outputNotes[0], outputNotes[1]];

    // Fetch pool config
    const poolConfigData = await this.fetchPoolConfig();
    const mint = new PublicKey(poolConfigData.mint);
    const currentEpoch = BigInt(poolConfigData.currentEpoch.toString());

    // Get current epoch tree for outputs
    const currentTree = epochManager.getTree(currentEpoch);
    if (!currentTree) {
      throw new Error(`No tree available for current epoch ${currentEpoch}`);
    }

    const provider: any = this.program.provider;
    const user: PublicKey = provider?.wallet?.publicKey ?? provider?.publicKey;
    if (!user) {
      throw new Error("Program provider is missing a wallet public key");
    }

    // Get Merkle proofs and compute nullifiers for each input
    const inputEpochs = inputTuple.map((n) => n.epoch ?? 0n);
    const inputLeafIndices = inputTuple.map((n) => n.leafIndex ?? 0);

    // Validate input epochs are spendable
    for (const epoch of inputEpochs) {
      if (epoch !== 0n) {
        await this.validateEpochSpendable(epoch);
      }
    }

    // Get trees for input notes
    const inputTree1 =
      epochManager.getTree(inputEpochs[0]) ??
      epochManager.getTree(currentEpoch)!;
    const inputTree2 =
      epochManager.getTree(inputEpochs[1]) ??
      epochManager.getTree(currentEpoch)!;

    const proof1 = inputTree1.getProof(inputLeafIndices[0]);
    const proof2 = inputTree2.getProof(inputLeafIndices[1]);

    // Compute epoch-aware nullifiers
    const nullifier1 = await computeNullifier(
      inputTuple[0].commitment,
      spendingKeys.nullifierKey,
      inputEpochs[0],
      inputLeafIndices[0],
    );
    const nullifier2 = await computeNullifier(
      inputTuple[1].commitment,
      spendingKeys.nullifierKey,
      inputEpochs[1],
      inputLeafIndices[1],
    );

    // Derive PDAs
    const [currentEpochTreePda] = this.deriveEpochTree(currentEpoch);
    const [transferVerifier] = this.deriveVerifierConfig("transfer");
    const [nullifierMarker1] = this.deriveNullifierMarker(
      inputEpochs[0],
      nullifier1,
    );
    const [nullifierMarker2] = this.deriveNullifierMarker(
      inputEpochs[1],
      nullifier2,
    );

    // Check for double-spend
    const nullifier1Info =
      await this.connection.getAccountInfo(nullifierMarker1);
    const nullifier2Info =
      await this.connection.getAccountInfo(nullifierMarker2);
    if (nullifier1Info || nullifier2Info) {
      throw new Error("One or more input notes have already been spent");
    }

    // Output leaf chunks
    const nextIndex = currentTree.getNextIndex();
    const [leafChunk1] = this.deriveEpochLeafChunk(currentEpoch, nextIndex);
    const [leafChunk2] = this.deriveEpochLeafChunk(currentEpoch, nextIndex + 1);

    // Serialize and encrypt output notes
    const serialized1 = serializeNote(
      outputTuple[0].value,
      outputTuple[0].token.toBytes(),
      outputTuple[0].owner,
      outputTuple[0].randomness,
      outputTuple[0].memo,
    );
    const serialized2 = serializeNote(
      outputTuple[1].value,
      outputTuple[1].token.toBytes(),
      outputTuple[1].owner,
      outputTuple[1].randomness,
      outputTuple[1].memo,
    );
    const encrypted1 = encryptNote(serialized1, outputTuple[0].owner);
    const encrypted2 = encryptNote(serialized2, outputTuple[1].owner);

    // Generate proof
    const merkleProofTuple: [MerkleProof, MerkleProof] = [proof1, proof2];
    const merkleRoot = inputTree1.getRoot();

    const artifacts = proverArtifacts || PROVER_ARTIFACTS.transfer;
    const { proof, publicInputs } = await proveTransfer(
      artifacts,
      {
        inputNotes: inputTuple,
        spendingKeys,
        outputNotes: outputTuple,
        merkleProofs: merkleProofTuple,
        merkleRoot,
        txAnchor: merkleRoot,
        poolConfig: this.poolConfigPda,
        epoch: currentEpoch,
        inputLeafIndices: [inputLeafIndices[0], inputLeafIndices[1]],
      },
      proverOptions,
    );


    const proofBytes = Buffer.concat([
      Buffer.from(proof.a),
      Buffer.from(proof.b),
      Buffer.from(proof.c),
    ]);

    // Ensure leaf chunks exist
    const setupTx = new Transaction();
    const leafChunks = [
      {
        address: leafChunk1,
        index: Math.floor(nextIndex / MERKLE_CONFIG.LEAVES_PER_CHUNK),
      },
      {
        address: leafChunk2,
        index: Math.floor((nextIndex + 1) / MERKLE_CONFIG.LEAVES_PER_CHUNK),
      },
    ];

    const seenChunks = new Set<string>();
    for (const { address, index } of leafChunks) {
      const key = address.toBase58();
      if (seenChunks.has(key)) continue;
      seenChunks.add(key);

      const chunkInfo = await this.connection.getAccountInfo(address);
      if (!chunkInfo) {
        const initIx = await (this.program.methods as any)
          .initializeEpochLeafChunk(new BN(currentEpoch.toString()), index)
          .accounts({
            leafChunk: address,
            epochTree: currentEpochTreePda,
            poolConfig: this.poolConfigPda,
            payer: user,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        setupTx.add(initIx);
      }
    }

    if (setupTx.instructions.length > 0) {
      try {
        await (this.program.provider as any).sendAndConfirm(setupTx, []);
      } catch (err: any) {
        const msg = err?.toString?.() || "";
        if (!msg.includes("already in use")) {
          throw err;
        }
      }
    }

    // Encrypted outputs
    const encryptedNotesOut = [
      Buffer.from(encrypted1.nonce),
      Buffer.from(encrypted2.nonce),
    ];
    const tagsOut = [Buffer.alloc(16, 0), Buffer.alloc(16, 0)];

    // Build transfer instruction
    const ix = await (this.program.methods as any)
      .transferV2(
        proofBytes,
        publicInputs,
        encryptedNotesOut,
        tagsOut.map((buf) => Array.from(buf)),
        new BN(currentEpoch.toString()),
        [new BN(inputEpochs[0].toString()), new BN(inputEpochs[1].toString())],
        inputLeafIndices,
      )
      .accounts({
        poolConfig: this.poolConfigPda,
        epochTree: currentEpochTreePda,
        user,
        verifierConfig: transferVerifier,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        // Nullifier markers for inputs
        { pubkey: nullifierMarker1, isWritable: true, isSigner: false },
        { pubkey: nullifierMarker2, isWritable: true, isSigner: false },
        // Leaf chunks for outputs
        { pubkey: leafChunk1, isWritable: true, isSigner: false },
        { pubkey: leafChunk2, isWritable: true, isSigner: false },
      ])
      .instruction();

    tx.add(ix);
    return tx;
  }

  // ============================================================
  // RENEW (Epoch Migration)
  // ============================================================

  /**
   * Build a renew transaction to migrate a note from an old epoch to the current epoch.
   * This is essential for preventing notes from expiring.
   */
  async buildRenew(
    oldNote: Note,
    newNote: Note,
    spendingKeys: SpendingKeys,
    epochManager: EpochMerkleTreeManager,
    proverArtifacts?: ProverArtifacts,
    proverOptions?: ProverOptions,
  ): Promise<Transaction> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));

    // Fetch pool config
    const poolConfigData = await this.fetchPoolConfig();
    const mint = new PublicKey(poolConfigData.mint);
    const currentEpoch = BigInt(poolConfigData.currentEpoch.toString());

    const oldEpoch = oldNote.epoch ?? 0n;
    const oldLeafIndex = oldNote.leafIndex ?? 0;

    // Validate old note epoch
    if (oldEpoch >= currentEpoch) {
      throw new Error("Renew is only needed for notes in older epochs");
    }
    await this.validateEpochSpendable(oldEpoch);

    // Get trees
    const oldTree = epochManager.getTree(oldEpoch);
    const currentTree = epochManager.getTree(currentEpoch);
    if (!oldTree || !currentTree) {
      throw new Error("Required epoch trees not available");
    }

    const provider: any = this.program.provider;
    const user: PublicKey = provider?.wallet?.publicKey ?? provider?.publicKey;
    if (!user) {
      throw new Error("Program provider is missing a wallet public key");
    }

    // Compute nullifier for old note
    const nullifier = await computeNullifier(
      oldNote.commitment,
      spendingKeys.nullifierKey,
      oldEpoch,
      oldLeafIndex,
    );

    // Derive PDAs
    const [oldEpochTreePda] = this.deriveEpochTree(oldEpoch);
    const [currentEpochTreePda] = this.deriveEpochTree(currentEpoch);
    const [renewVerifier] = this.deriveVerifierConfig("renew");
    const [nullifierMarker] = this.deriveNullifierMarker(oldEpoch, nullifier);

    // Check for double-spend
    const nullifierInfo = await this.connection.getAccountInfo(nullifierMarker);
    if (nullifierInfo) {
      throw new Error("Note has already been spent or renewed");
    }

    // Get Merkle proof for old note
    const merkleProof = oldTree.getProof(oldLeafIndex);
    const merkleRoot = oldTree.getRoot();

    // Output leaf chunk
    const nextIndex = currentTree.getNextIndex();
    const [leafChunk] = this.deriveEpochLeafChunk(currentEpoch, nextIndex);

    // Serialize and encrypt new note
    const serialized = serializeNote(
      newNote.value,
      newNote.token.toBytes(),
      newNote.owner,
      newNote.randomness,
      newNote.memo,
    );
    const encrypted = encryptNote(serialized, newNote.owner);

    // Generate proof

    const artifacts = proverArtifacts || PROVER_ARTIFACTS.renew;
    const { proof, publicInputs } = await proveRenew(
      artifacts,
      {
        oldNote,
        newNote,
        spendingKeys,
        merkleProof,
        merkleRoot,
        poolConfig: this.poolConfigPda,
        oldEpoch,
        newEpoch: currentEpoch,
        oldLeafIndex,
      },
      proverOptions,
    );


    const proofBytes = Buffer.concat([
      Buffer.from(proof.a),
      Buffer.from(proof.b),
      Buffer.from(proof.c),
    ]);

    // Ensure leaf chunk exists
    const leafChunkInfo = await this.connection.getAccountInfo(leafChunk);
    if (!leafChunkInfo) {
      const initIx = await (this.program.methods as any)
        .initializeEpochLeafChunk(
          new BN(currentEpoch.toString()),
          Math.floor(nextIndex / MERKLE_CONFIG.LEAVES_PER_CHUNK),
        )
        .accounts({
          leafChunk,
          epochTree: currentEpochTreePda,
          poolConfig: this.poolConfigPda,
          payer: user,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(initIx);
    }

    // Build renew instruction
    const ix = await (this.program.methods as any)
      .renewNote(
        proofBytes,
        publicInputs,
        Array.from(newNote.commitment),
        Array.from(encrypted.encrypted),
        Array.from(encrypted.nonce),
        new BN(oldEpoch.toString()),
        oldLeafIndex,
      )
      .accounts({
        poolConfig: this.poolConfigPda,
        oldEpochTree: oldEpochTreePda,
        newEpochTree: currentEpochTreePda,
        nullifierMarker,
        leafChunk,
        user,
        verifierConfig: renewVerifier,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    tx.add(ix);
    return tx;
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Fetch and parse pool configuration
   */
  private async fetchPoolConfig(): Promise<any> {
    return (this.program.account as any).poolConfig.fetch(this.poolConfigPda);
  }

  /**
   * Validate that an epoch is still spendable (not expired)
   */
  private async validateEpochSpendable(epoch: bigint): Promise<void> {
    const [epochTree] = this.deriveEpochTree(epoch);
    const epochData = await (this.program.account as any).epochTree.fetch(
      epochTree,
    );

    if (epochData.state === 3) {
      // Expired
      throw new Error(`Epoch ${epoch} has expired and is no longer spendable`);
    }
  }

  /**
   * Find all leaf chunk PDAs for an epoch
   */
  private async findEpochLeafChunks(
    epoch: bigint,
  ): Promise<{ pubkey: PublicKey; lamports: number; chunkIndex: number }[]> {
    const results: {
      pubkey: PublicKey;
      lamports: number;
      chunkIndex: number;
    }[] = [];
    const epochBytes = this.epochToBytes(epoch);

    // Search for leaf chunk accounts with the epoch prefix
    // In practice, we'd use getProgramAccounts with memcmp filter
    // For now, iterate through possible chunk indices
    for (let i = 0; i < 20; i++) {
      const [leafChunk] = PublicKey.findProgramAddressSync(
        [
          Buffer.from(PDA_SEEDS.LEAVES),
          this.poolConfigPda.toBuffer(),
          epochBytes,
          new BN(i).toArrayLike(Buffer, "le", 4),
        ],
        this.program.programId,
      );

      const info = await this.connection.getAccountInfo(leafChunk);
      if (info) {
        results.push({
          pubkey: leafChunk,
          lamports: info.lamports,
          chunkIndex: i,
        });
      } else {
        break; // Assume contiguous chunk indices
      }
    }

    return results;
  }

  /**
   * Create a dummy note for padding
   */
  private createDummyNote(): Note {
    return {
      value: 0n,
      token: PublicKey.default,
      owner: new Uint8Array(32),
      blinding: new Uint8Array(32),
      commitment: new Uint8Array(32),
      nullifier: new Uint8Array(32),
      randomness: new Uint8Array(32),
      spent: false,
      epoch: 0n,
      leafIndex: 0,
    };
  }

  /**
   * Convert epoch to 8-byte little-endian buffer
   */
  private epochToBytes(epoch: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(epoch);
    return buf;
  }

  // ============================================================
  // PDA DERIVATION HELPERS
  // ============================================================

  /**
   * Derive EpochTree PDA for a specific epoch
   */
  private deriveEpochTree(epoch: bigint): [PublicKey, number] {
    const epochBytes = this.epochToBytes(epoch);
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(PDA_SEEDS.EPOCH_TREE),
        this.poolConfigPda.toBuffer(),
        epochBytes,
      ],
      this.program.programId,
    );
  }

  /**
   * Derive EpochLeafChunk PDA for a specific epoch and leaf index
   */
  private deriveEpochLeafChunk(
    epoch: bigint,
    leafIndex: number,
  ): [PublicKey, number] {
    const epochBytes = this.epochToBytes(epoch);
    const chunkIndex = Math.floor(leafIndex / MERKLE_CONFIG.LEAVES_PER_CHUNK);
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(PDA_SEEDS.LEAVES),
        this.poolConfigPda.toBuffer(),
        epochBytes,
        new BN(chunkIndex).toArrayLike(Buffer, "le", 4),
      ],
      this.program.programId,
    );
  }

  /**
   * Derive NullifierMarker PDA for O(1) double-spend checking
   */
  private deriveNullifierMarker(
    epoch: bigint,
    nullifier: Uint8Array,
  ): [PublicKey, number] {
    const epochBytes = this.epochToBytes(epoch);
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(PDA_SEEDS.NULLIFIER),
        this.poolConfigPda.toBuffer(),
        epochBytes,
        Buffer.from(nullifier),
      ],
      this.program.programId,
    );
  }

  /**
   * Derive vault authority PDA
   */
  private deriveVaultAuthority(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()],
      this.program.programId,
    );
  }

  /**
   * Derive verifier config PDA for a specific circuit
   */
  private deriveVerifierConfig(
    circuit: "withdraw" | "transfer" | "renew",
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(PDA_SEEDS.VERIFIER),
        this.poolConfigPda.toBuffer(),
        Buffer.from(circuit),
      ],
      this.program.programId,
    );
  }
}
