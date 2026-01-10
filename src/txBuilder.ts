/**
 * TransactionBuilder - Builds transactions for deposits, withdrawals, and transfers
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
import { Note, SpendingKeys, MerkleProof, NULLIFIER_CHUNK_SIZE } from "./types";
import {
  ProverArtifacts,
  ProverOptions,
  proveWithdraw,
  proveTransfer,
} from "./prover";
import { MerkleTreeSync } from "./merkle";
import { computeNullifier, serializeNote, encryptNote } from "./crypto";

export class TransactionBuilder {
  private program: Program;
  private poolConfig: PublicKey;
  private connection: Connection;

  constructor(program: Program, poolConfig: PublicKey, connection: Connection) {
    this.program = program;
    this.poolConfig = poolConfig;
    this.connection = connection;
  }

  /**
   * Build a deposit transaction
   */
  async buildDeposit(
    depositor: PublicKey,
    outputNote: Note,
    merkleTree: MerkleTreeSync
  ): Promise<Transaction> {
    const tx = new Transaction();

    // Fetch PoolConfig to get mint
    const poolConfigData = await (this.program.account as any).poolConfig.fetch(
      this.poolConfig
    );
    const mint: PublicKey = poolConfigData.mint;

    // Derive on-chain PDAs (must match program seeds)
    const [poolTree] = PublicKey.findProgramAddressSync(
      [Buffer.from("tree"), mint.toBuffer()],
      this.program.programId
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()],
      this.program.programId
    );

    // Associated token accounts (using standard SPL Token program)
    const userTokenAccount = getAssociatedTokenAddressSync(
      mint,
      depositor,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Check if vault token account exists, if not create it
    const connection = this.program.provider.connection;
    const vaultAccountInfo = await connection.getAccountInfo(vaultTokenAccount);
    if (!vaultAccountInfo) {
      const { createAssociatedTokenAccountInstruction } = await import(
        "@solana/spl-token"
      );
      const createAtaIx = createAssociatedTokenAccountInstruction(
        depositor,
        vaultTokenAccount,
        vaultAuthority,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      tx.add(createAtaIx);
    }

    // Ensure user token account exists for the depositor
    const userAccountInfo = await connection.getAccountInfo(userTokenAccount);
    if (!userAccountInfo) {
      const { createAssociatedTokenAccountInstruction } = await import(
        "@solana/spl-token"
      );
      const createUserAtaIx = createAssociatedTokenAccountInstruction(
        depositor,
        userTokenAccount,
        depositor,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      tx.add(createUserAtaIx);
    }

    // Next leaf index & chunk
    const nextLeafIndex = await merkleTree.getNextIndex();
    const chunkIndex = Math.floor(nextLeafIndex / 256);
    const [leafChunk] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("leaf"),
        mint.toBuffer(),
        new BN(chunkIndex).toArrayLike(Buffer, "be", 4),
      ],
      this.program.programId
    );

    // Check if leaf chunk exists, if not initialize it
    const leafChunkInfo = await connection.getAccountInfo(leafChunk);
    if (!leafChunkInfo) {
      const initLeafChunkIx = await (this.program.methods as any)
        .initializeLeafChunk(chunkIndex)
        .accounts({
          mint: mint,
          payer: depositor,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(initLeafChunkIx);
    }

    // Encrypt note payload
    const serialized = serializeNote(
      outputNote.value,
      outputNote.token.toBytes(),
      outputNote.owner,
      outputNote.randomness,
      outputNote.memo
    );
    const encrypted = encryptNote(serialized, outputNote.owner);

    // Build deposit instruction aligning account names with program
    const commitmentBytes = Buffer.from(outputNote.commitment);
    if (commitmentBytes.length !== 32) {
      throw new Error(
        `commitment must be 32 bytes, got ${commitmentBytes.length}`
      );
    }
    const encryptedPayload = Buffer.concat([
      Buffer.from(encrypted.nonce),
      Buffer.from(encrypted.encrypted),
    ]);
    const tagBytes = Buffer.alloc(16, 0);

    const methodBuilder = (this.program.methods as any).depositShielded(
      new BN(outputNote.value.toString()),
      Array.from(commitmentBytes),
      encryptedPayload,
      Array.from(tagBytes)
    );

    const ix = await methodBuilder
      .accounts({
        poolConfig: this.poolConfig,
        poolTree: poolTree,
        mint: mint,
        userTokenAccount: userTokenAccount,
        vaultTokenAccount: vaultTokenAccount,
        user: depositor,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: leafChunk, isWritable: true, isSigner: false },
      ])
      .instruction();

    tx.add(ix);
    return tx;
  }

  /**
   * Build a withdrawal transaction
   */
  async buildWithdraw(
    inputNote: Note,
    withdrawAmount: bigint,
    recipient: PublicKey,
    spendingKeys: SpendingKeys,
    merkleTree: MerkleTreeSync,
    proverArtifacts?: ProverArtifacts,
    proverOptions?: ProverOptions
  ): Promise<Transaction> {
    console.log("🔧 buildWithdraw called");
    console.log("   Input note leaf index:", inputNote.leafIndex);
    const tx = new Transaction();
    const connection = this.program.provider.connection as Connection;

    console.log("🌲 Getting merkle proof...");
    const merkleProof = await merkleTree.getProof(inputNote.leafIndex || 0);
    console.log("✅ Got merkle proof, getting root...");
    const merkleRoot = merkleTree.getRoot();
    console.log("✅ Got merkle root");

    console.log("   Computing nullifier...");
    console.log("   Commitment length:", inputNote.commitment.length);
    console.log("   NullifierKey length:", spendingKeys.nullifierKey.length);
    const nullifier = await computeNullifier(
      inputNote.commitment,
      spendingKeys.nullifierKey
    );
    console.log("   Nullifier computed, length:", nullifier.length);

    const poolConfigData = await (this.program.account as any).poolConfig.fetch(
      this.poolConfig
    );
    const mint = poolConfigData.mint;
    const vaultAuthority = poolConfigData.vaultAuthority;
    const chunkSize =
      Number(poolConfigData.nullifierChunkSize ?? NULLIFIER_CHUNK_SIZE) ||
      NULLIFIER_CHUNK_SIZE;

    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [vaultAuthority.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    );

    const [poolTree] = PublicKey.findProgramAddressSync(
      [Buffer.from("tree"), mint.toBuffer()],
      this.program.programId
    );

    const { address: nullifierChunk, index: nullifierChunkIndex } =
      this.deriveNullifierChunk(nullifier, chunkSize);
    const [withdrawVerifier] = this.deriveVerifierConfig("withdraw");

    const [userTokenAccount] = PublicKey.findProgramAddressSync(
      [recipient.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    );

    console.log("📍 Calling proveWithdraw...");
    console.log("   Note value:", inputNote.value.toString());
    console.log("   Merkle proof siblings:", merkleProof.siblings.length);
    console.log("   Leaf index:", merkleProof.leafIndex);

    const { PROVER_ARTIFACTS } = await import("./config");
    const defaultArtifacts = PROVER_ARTIFACTS.withdraw;
    const { proof, publicInputs } = await proveWithdraw(
      proverArtifacts || defaultArtifacts,
      {
        note: inputNote,
        spendingKeys,
        merkleProof,
        merkleRoot: merkleRoot,
        recipient,
        amount: withdrawAmount,
        poolConfig: this.poolConfig,
      },
      proverOptions
    );

    console.log("✅ Proof generated successfully");
    console.log(
      "🔎 Withdraw publicInputs (prover formatted):",
      publicInputs.map(
        (pi) => Buffer.from(pi).toString("hex").slice(0, 16) + "..."
      )
    );

    const proofBytes = Buffer.concat([
      Buffer.from(proof.a),
      Buffer.from(proof.b),
      Buffer.from(proof.c),
    ]);

    // Ensure nullifier chunk account exists so program can mark spends
    const chunkInfo = await connection.getAccountInfo(nullifierChunk);
    if (!chunkInfo) {
      const initNullifierIx = await (this.program.methods as any)
        .initializeNullifierChunk(
          Array.from(this.poolConfig.toBuffer()),
          nullifierChunkIndex
        )
        .accounts({
          nullifierChunk,
          payer: recipient,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(initNullifierIx);
    }

    const nIn = 1;
    const ix = await (this.program.methods as any)
      .withdrawShielded(
        proofBytes,
        publicInputs,
        new BN(withdrawAmount.toString()),
        nIn
      )
      .accounts({
        poolConfig: this.poolConfig,
        poolTree: poolTree,
        vaultAuthority: vaultAuthority,
        mint: mint,
        vaultTokenAccount: vaultTokenAccount,
        userTokenAccount: userTokenAccount,
        user: recipient,
        tokenProgram: TOKEN_PROGRAM_ID,
        verifierConfig: withdrawVerifier,
      })
      .remainingAccounts([
        {
          pubkey: nullifierChunk,
          isWritable: true,
          isSigner: false,
        },
      ])
      .instruction();

    tx.add(ix);
    return tx;
  }

  /**
   * Build a shielded transfer transaction
   */
  async buildTransfer(
    inputNotes: Note[],
    outputNotes: Note[],
    spendingKeys: SpendingKeys,
    merkleTree: MerkleTreeSync,
    proverArtifacts?: ProverArtifacts
  ): Promise<Transaction> {
    const tx = new Transaction();
    // Pairing verification is heavy; request a higher CU limit up front
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    const setupTx = new Transaction();
    const provider: any = this.program.provider;
    const user: PublicKey | undefined =
      provider?.wallet?.publicKey ?? provider?.publicKey;

    if (!user) {
      throw new Error("Program provider is missing a wallet public key");
    }

    while (inputNotes.length < 2) {
      inputNotes.push(this.createDummyNote());
    }
    while (outputNotes.length < 2) {
      outputNotes.push(this.createDummyNote());
    }

    const inputTuple: [Note, Note] = [inputNotes[0], inputNotes[1]];
    const outputTuple: [Note, Note] = [outputNotes[0], outputNotes[1]];

    const proof1 = await merkleTree.getProof(inputTuple[0].leafIndex || 0);
    const proof2 = await merkleTree.getProof(inputTuple[1].leafIndex || 0);

    const nullifier1 = await computeNullifier(
      inputTuple[0].commitment,
      spendingKeys.nullifierKey
    );
    const nullifier2 = await computeNullifier(
      inputTuple[1].commitment,
      spendingKeys.nullifierKey
    );

    const poolConfigData = await (this.program.account as any).poolConfig.fetch(
      this.poolConfig
    );
    const mint: PublicKey = poolConfigData.mint;
    const chunkSize =
      Number(poolConfigData.nullifierChunkSize ?? NULLIFIER_CHUNK_SIZE) ||
      NULLIFIER_CHUNK_SIZE;

    const [poolTree] = PublicKey.findProgramAddressSync(
      [Buffer.from("tree"), mint.toBuffer()],
      this.program.programId
    );

    const nextIndex = await merkleTree.getNextIndex();
    const [leafChunk1] = this.deriveLeafChunk(nextIndex, mint);
    const [leafChunk2] = this.deriveLeafChunk(nextIndex + 1, mint);
    const [transferVerifier] = this.deriveVerifierConfig("transfer");

    const merkleRoot = merkleTree.getRoot();

    const serialized1 = serializeNote(
      outputTuple[0].value,
      outputTuple[0].token.toBytes(),
      outputTuple[0].owner,
      outputTuple[0].randomness,
      outputTuple[0].memo
    );
    const serialized2 = serializeNote(
      outputTuple[1].value,
      outputTuple[1].token.toBytes(),
      outputTuple[1].owner,
      outputTuple[1].randomness,
      outputTuple[1].memo
    );
    const encrypted1 = encryptNote(serialized1, outputTuple[0].owner);
    const encrypted2 = encryptNote(serialized2, outputTuple[1].owner);

    const merkleProofTuple: [MerkleProof, MerkleProof] = [proof1, proof2];
    const { PROVER_ARTIFACTS } = await import("./config");
    const defaultTransferArtifacts = PROVER_ARTIFACTS.transfer;
    const { proof, publicInputs } = await proveTransfer(
      proverArtifacts || defaultTransferArtifacts,
      {
        inputNotes: inputTuple,
        spendingKeys,
        outputNotes: outputTuple,
        merkleProofs: merkleProofTuple,
        merkleRoot: merkleRoot,
        txAnchor: merkleRoot, // simple, non-zero anchor bound to state
        poolConfig: this.poolConfig,
      }
    );

    // Transfer circuit expects: root | nullifier1 | nullifier2 | commitment1 | commitment2 | tx_anchor | pool_id | chain_id
    const transferPublicInputs = publicInputs;

    const connection = this.program.provider.connection as Connection;

    const { address: nullifierChunk1Addr, index: nullifierChunkIndex1 } =
      this.deriveNullifierChunk(nullifier1, chunkSize);
    const { address: nullifierChunk2Addr, index: nullifierChunkIndex2 } =
      this.deriveNullifierChunk(nullifier2, chunkSize);

    const nullifierChunks = [
      { address: nullifierChunk1Addr, index: nullifierChunkIndex1 },
      { address: nullifierChunk2Addr, index: nullifierChunkIndex2 },
    ];

    const seenNullifierChunks = new Set<string>();
    for (const { address, index } of nullifierChunks) {
      const key = address.toBase58();
      if (seenNullifierChunks.has(key)) continue;
      seenNullifierChunks.add(key);

      const chunkInfo = await connection.getAccountInfo(address);
      if (!chunkInfo) {
        const initNullifierIx = await (this.program.methods as any)
          .initializeNullifierChunk(
            Array.from(this.poolConfig.toBuffer()),
            index
          )
          .accounts({
            nullifierChunk: address,
            payer: user,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        setupTx.add(initNullifierIx);
      }
    }

    const leafChunkIndex1 = Math.floor(nextIndex / 256);
    const leafChunkIndex2 = Math.floor((nextIndex + 1) / 256);
    const leafChunks = [
      { address: leafChunk1, index: leafChunkIndex1 },
      { address: leafChunk2, index: leafChunkIndex2 },
    ];

    // Ensure leaf chunks exist for outputs (avoid duplicate init when indices match)
    const seenLeafChunk = new Set<string>();
    for (const { address, index } of leafChunks) {
      const key = address.toBase58();
      if (seenLeafChunk.has(key)) continue;
      seenLeafChunk.add(key);
      const leafInfo = await connection.getAccountInfo(address);
      if (!leafInfo) {
        const initLeafChunkIx = await (this.program.methods as any)
          .initializeLeafChunk(index)
          .accounts({
            leafChunk: address,
            mint,
            payer: user,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        setupTx.add(initLeafChunkIx);
      }
    }

    if (setupTx.instructions.length > 0) {
      try {
        await (this.program.provider as any).sendAndConfirm(setupTx, []);
      } catch (err: any) {
        const msg = err?.toString?.() || "";
        const alreadyInUse = msg.includes("already in use");
        if (!alreadyInUse) {
          throw err;
        }
        console.warn("Initialize chunk skipped (already exists)");
      }
    }

    const proofBytes = Buffer.concat([
      Buffer.from(proof.a),
      Buffer.from(proof.b),
      Buffer.from(proof.c),
    ]);

    const encryptedNotesOut = [
      Buffer.from(encrypted1.nonce),
      Buffer.from(encrypted2.nonce),
    ];

    const tagsOut = [Buffer.alloc(16, 0), Buffer.alloc(16, 0)];
    const nIn = 2;
    const nOut = 2;

    const ix = await (this.program.methods as any)
      .shieldedTransfer(
        proofBytes,
        transferPublicInputs,
        encryptedNotesOut,
        tagsOut.map((buf) => Array.from(buf)),
        nIn,
        nOut
      )
      .accounts({
        poolConfig: this.poolConfig,
        poolTree: poolTree,
        user,
        verifierConfig: transferVerifier,
      })
      .remainingAccounts([
        { pubkey: nullifierChunk1Addr, isWritable: true, isSigner: false },
        { pubkey: nullifierChunk2Addr, isWritable: true, isSigner: false },
        { pubkey: leafChunk1, isWritable: true, isSigner: false },
        { pubkey: leafChunk2, isWritable: true, isSigner: false },
      ])
      .instruction();

    tx.add(ix);
    return tx;
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
    };
  }

  /**
   * Derive nullifier chunk PDA
   */
  private deriveNullifierChunk(
    nullifier: Uint8Array,
    chunkSize: number
  ): { address: PublicKey; bump: number; index: number } {
    console.log("   Nullifier length:", nullifier.length, "bytes");
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error(
        `Invalid nullifier chunk size: ${chunkSize}. Must be positive integer.`
      );
    }

    const buf = Buffer.from(nullifier);
    if (buf.length < 4) {
      throw new Error(
        `Nullifier too short: ${buf.length} bytes, need at least 4`
      );
    }

    const rawIndex = buf.readUInt32BE(0);
    const maxChunks = Math.max(1, Math.floor(0xffffffff / chunkSize));
    const chunkIndex = rawIndex % maxChunks;
    const [address, bump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("nullifier"),
        this.poolConfig.toBuffer(),
        new BN(chunkIndex).toArrayLike(Buffer, "be", 4),
      ],
      this.program.programId
    );

    return { address, bump, index: chunkIndex };
  }

  /**
   * Derive leaf chunk PDA
   */
  private deriveLeafChunk(
    leafIndex: number,
    mint: PublicKey
  ): [PublicKey, number] {
    const chunkIndex = Math.floor(leafIndex / 256);
    if (!mint) {
      throw new Error("mint is required for leaf chunk PDA derivation");
    }
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("leaf"),
        mint.toBuffer(),
        new BN(chunkIndex).toArrayLike(Buffer, "be", 4),
      ],
      this.program.programId
    );
  }

  /**
   * Derive verifier config PDA for a specific circuit
   */
  private deriveVerifierConfig(
    circuit: "withdraw" | "transfer"
  ): [PublicKey, number] {
    const circuitSeed =
      circuit === "withdraw"
        ? Buffer.from("withdraw")
        : Buffer.from("transfer");

    return PublicKey.findProgramAddressSync(
      [Buffer.from("verifier"), this.poolConfig.toBuffer(), circuitSeed],
      this.program.programId
    );
  }
}
