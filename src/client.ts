/**
 * Epoch-aware ShieldedPoolClient class
 * Provides high-level API for interacting with the shielded pool
 *
 * Features:
 * - Automatic epoch management
 * - Note renewal before expiration
 * - Epoch lifecycle operations (rollover, finalize, GC)
 * - Balance breakdown by epoch status
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { KeyManager } from "./keyManager";
import { NoteManager } from "./noteManager";
import { EpochMerkleTree, EpochMerkleTreeManager } from "./merkle";
import { UTXOScanner } from "./scanner";
import { TransactionBuilder } from "./txBuilder";
import {
  Note,
  SpendingKeys,
  PoolConfig as PoolConfigType,
  BalanceInfo,
  EpochInfo,
  EpochState,
  GarbageCollectInfo,
} from "./types";
import { PROVER_ARTIFACTS, EPOCH_TIMING } from "./config";
import { poseidonHash } from "./crypto";

export interface ShieldedPoolClientConfig {
  connection: Connection;
  programId: PublicKey;
  poolConfig: PublicKey;
  payer?: Keypair;
  idl?: Idl;
  artifactsBaseDir?: string; // optional base dir for proving artifacts
  merkleOrder?: "top-down" | "bottom-up"; // control merkle path ordering for circuits
  testMode?: boolean; // when true, skip scanner/rescan and include pending in balances
}
import { loadArtifacts } from "./prover";

export class ShieldedPoolClient {
  private connection: Connection;
  private provider: AnchorProvider;
  private program: Program;
  private programId: PublicKey;
  private poolConfig: PublicKey;
  private payer?: Keypair;
  private config: ShieldedPoolClientConfig;

  private keyManager: KeyManager;
  private noteManager: NoteManager;
  private epochManager: EpochMerkleTreeManager;
  private scanner: UTXOScanner;
  private txBuilder: TransactionBuilder;
  private lastOutputNotes?: Note[];

  private spendingKeys?: SpendingKeys;
  private isInitialized: boolean = false;
  private currentEpoch: bigint = 0n;

  constructor(config: ShieldedPoolClientConfig) {
    this.config = config;
    this.connection = config.connection;
    this.programId = config.programId;
    this.poolConfig = config.poolConfig;
    this.payer = config.payer;

    // Create provider
    this.provider = new AnchorProvider(
      this.connection,
      {
        publicKey: this.payer?.publicKey || PublicKey.default,
        signTransaction: async (tx) => {
          if (!this.payer) throw new Error("No payer configured");
          if ("partialSign" in tx) {
            tx.partialSign(this.payer);
          }
          return tx;
        },
        signAllTransactions: async (txs) => {
          if (!this.payer) throw new Error("No payer configured");
          return txs.map((tx) => {
            if ("partialSign" in tx) {
              tx.partialSign(this.payer!);
            }
            return tx;
          });
        },
      },
      { commitment: "confirmed" },
    );

    // Load or use provided IDL
    if (config.idl) {
      this.program = new Program(config.idl, this.provider);
    } else {
      throw new Error("IDL must be provided");
    }

    // Initialize components (will be fully set up after init())
    this.keyManager = KeyManager.generate(); // Placeholder
    this.noteManager = new NoteManager();
    this.epochManager = new EpochMerkleTreeManager(
      this.connection,
      this.program,
      this.poolConfig,
    );
    this.scanner = new UTXOScanner(
      this.connection,
      this.program,
      this.poolConfig,
    );
    this.txBuilder = new TransactionBuilder(
      this.program,
      this.poolConfig,
      this.connection,
    );
  }

  /**
   * Create a new client with a random mnemonic
   */
  static async create(
    config: ShieldedPoolClientConfig,
  ): Promise<ShieldedPoolClient> {
    const client = new ShieldedPoolClient(config);
    client.keyManager = KeyManager.generate();
    await client.init();
    return client;
  }

  /**
   * Create a client from an existing mnemonic
   */
  static async fromMnemonic(
    config: ShieldedPoolClientConfig,
    mnemonic: string,
  ): Promise<ShieldedPoolClient> {
    const client = new ShieldedPoolClient(config);
    client.keyManager = KeyManager.fromMnemonic(mnemonic);
    await client.init();
    return client;
  }

  /**
   * Create a client from a seed
   */
  static async fromSeed(
    config: ShieldedPoolClientConfig,
    seed: Buffer,
  ): Promise<ShieldedPoolClient> {
    const client = new ShieldedPoolClient(config);
    client.keyManager = KeyManager.fromSeed(new Uint8Array(seed));
    await client.init();
    return client;
  }

  /**
   * Initialize the client after keys are set up
   */
  private async init(): Promise<void> {
    if (this.isInitialized) return;

    // Initialize Poseidon for merkle tree hashing (call once to load library)
    await poseidonHash([new Uint8Array(32)]);
    console.log("✅ Poseidon initialized");

    // Get spending keys
    this.spendingKeys = {
      seed: new Uint8Array(32), // Not exposed from KeyManager
      spendingKey: this.keyManager.getSpendingKey(),
      viewingKey: this.keyManager.getViewingKey(),
      nullifierKey: this.keyManager.getNullifierKey(),
      shieldedAddress: this.keyManager.getShieldedAddress(),
    };

    // Configure note manager with keys
    this.noteManager = new NoteManager(this.spendingKeys);

    // Sync epoch manager from chain; in testMode tolerate missing poolConfig
    try {
      await this.epochManager.sync();
      this.currentEpoch = this.epochManager.getCurrentEpoch();
      this.noteManager.setCurrentEpoch(this.currentEpoch);
    } catch (e) {
      if (this.config?.testMode) {
        console.warn(
          "⚠️ Epoch sync skipped in testMode:",
          (e as Error).message,
        );
      } else {
        throw e;
      }
    }

    // Start scanner unless in test mode
    if (!this.config?.testMode) {
      await this.scanner.start(this.spendingKeys.viewingKey, this.noteManager);

      // Register epoch change callback
      this.scanner.onEpochChange((epoch, state) => {
        if (state === EpochState.Active) {
          this.currentEpoch = epoch;
          this.noteManager.setCurrentEpoch(epoch);
        }
      });
    }

    this.isInitialized = true;
  }

  /**
   * Get the shielded address
   */
  getShieldedAddress(): string {
    const addr = this.keyManager.getShieldedAddress();
    return bs58.encode(addr);
  }

  /**
   * Get all spending keys (for backup)
   */
  getKeys(): SpendingKeys | undefined {
    return this.spendingKeys;
  }

  /**
   * Get the current shielded balance (spendable only)
   */
  async getBalance(): Promise<bigint> {
    this.ensureInitialized();
    const confirmed = this.noteManager.calculateBalance();
    if (this.config?.testMode) {
      return confirmed + this.noteManager.calculatePendingBalance();
    }
    return confirmed;
  }

  /**
   * Get detailed balance breakdown by epoch status
   */
  async getBalanceInfo(): Promise<BalanceInfo> {
    this.ensureInitialized();
    return this.noteManager.calculateBalanceInfo();
  }

  /**
   * Get current epoch information
   */
  async getEpochInfo(): Promise<EpochInfo> {
    this.ensureInitialized();
    const info = await this.epochManager.getEpochInfo(this.currentEpoch);
    if (!info) {
      throw new Error(`Epoch ${this.currentEpoch} not found`);
    }
    return info;
  }

  /**
   * Get the current epoch number
   */
  getCurrentEpoch(): bigint {
    return this.currentEpoch;
  }

  /**
   * Check if any notes need renewal (expiring soon)
   */
  async checkExpiringNotes(): Promise<{
    count: number;
    value: bigint;
    notes: Note[];
  }> {
    this.ensureInitialized();
    const expiringNotes = this.noteManager.getExpiringNotes();
    const value = expiringNotes.reduce((sum, n) => sum + n.value, 0n);
    return { count: expiringNotes.length, value, notes: expiringNotes };
  }

  /**
   * Get all unspent notes
   */
  getUnspentNotes(): Note[] {
    this.ensureInitialized();
    return this.noteManager.getNotes();
  }

  /**
   * Return the last transfer outputs (for testing/debugging)
   */
  getLastOutputNotes(): Note[] | undefined {
    return this.lastOutputNotes?.map((n) => ({ ...n }));
  }

  /**
   * Deposit tokens into the shielded pool (current epoch)
   */
  async deposit(amount: bigint): Promise<string> {
    this.ensureInitialized();

    if (!this.payer) {
      throw new Error("Payer required for deposit");
    }

    // Create a new output note for current epoch
    const outputNote = await this.noteManager.createNote(
      amount,
      this.keyManager.getSpendingKey(),
    );

    // Get current epoch tree
    const currentTree = this.epochManager.getTree(this.currentEpoch);
    if (!currentTree) {
      throw new Error(
        `No tree available for current epoch ${this.currentEpoch}`,
      );
    }

    // Build deposit transaction
    const tx = await this.txBuilder.buildDeposit(
      this.payer.publicKey,
      outputNote,
      currentTree,
    );

    // Sign and send
    const signature = await this.provider.sendAndConfirm(tx, [this.payer]);

    // Add note to manager (will be confirmed by scanner)
    this.noteManager.addPendingNote(outputNote);

    // In normal mode, rescan to promote pending note; in test mode, directly promote to confirmed
    if (!this.config?.testMode) {
      await this.scanner.rescanSignature(signature);
      // Refresh epoch manager to include new leaf
      await this.epochManager.sync();
    } else {
      // In test mode, immediately promote pending to confirmed
      const poolConfigAccount = await (
        this.program.account as any
      ).poolConfig.fetch(this.poolConfig);
      const epochTree = await this.fetchCurrentEpochTree();
      const leafIndex = Number(epochTree.nextIndex) - 1;
      outputNote.leafIndex = leafIndex;
      outputNote.epoch = this.currentEpoch;
      this.noteManager.addNote(outputNote);
      await this.epochManager.sync();
    }

    // Debug: Check what notes we have
    const allNotes = this.noteManager.getNotes();
    console.log("📋 Notes after deposit:");
    allNotes.forEach((n, i) => {
      console.log(
        `   Note ${i}: value=${n.value}, epoch=${n.epoch}, leafIndex=${n.leafIndex}`,
      );
    });

    return signature;
  }

  /**
   * Wait until balance reaches at least minBalance, or timeout.
   */
  async waitForBalance(
    minBalance: bigint,
    timeoutMs: number = 30000,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const bal = await this.getBalance();
      if (bal >= minBalance) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /**
   * Withdraw tokens from the shielded pool
   */
  async withdraw(amount: bigint, recipient: PublicKey): Promise<string> {
    this.ensureInitialized();

    // Always sync before proving to avoid stale roots
    await this.epochManager.sync();

    if (!this.spendingKeys) {
      throw new Error("Spending keys not initialized");
    }

    // Select a single note to spend (withdraw circuit uses single input)
    let inputNotes: Note[];
    try {
      inputNotes = this.noteManager.selectNotes(amount, 1);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Insufficient note count")
      ) {
        throw new Error(
          "Insufficient spendable notes for withdrawal. Deposit or wait for notes to confirm.",
        );
      }
      throw error;
    }
    if (inputNotes.length === 0) {
      throw new Error("Insufficient balance for withdrawal");
    }

    // Use the first note that covers the amount
    const inputNote = inputNotes[0];
    if (inputNote.leafIndex === undefined || inputNote.epoch === undefined) {
      throw new Error(
        "Input note missing epoch or leaf index; resync and retry",
      );
    }

    console.log("📝 Selected note for withdrawal:");
    console.log("   Value:", inputNote.value.toString());
    console.log("   Epoch:", inputNote.epoch.toString());
    console.log("   LeafIndex:", inputNote.leafIndex);

    // Get the epoch tree for the input note
    const epochTree = this.epochManager.getTree(inputNote.epoch);
    if (!epochTree) {
      throw new Error(`No tree available for epoch ${inputNote.epoch}`);
    }

    // Resolve prover artifacts
    const withdrawArtifacts = await this.configuredArtifacts("withdraw");

    // Build withdraw transaction
    const tx = await this.txBuilder.buildWithdraw(
      inputNote,
      this.spendingKeys,
      recipient,
      amount,
      epochTree,
      withdrawArtifacts,
      { merkleOrder: this.config?.merkleOrder || "bottom-up" },
    );

    // Sign and send
    const signature = await this.provider.sendAndConfirm(
      tx,
      this.payer ? [this.payer] : [],
    );

    // Mark input note as spent
    this.noteManager.markSpent(inputNote.commitment);

    return signature;
  }

  /**
   * Transfer tokens within the shielded pool
   */
  async transfer(amount: bigint, recipientAddress: string): Promise<string> {
    this.ensureInitialized();

    if (!this.spendingKeys) {
      throw new Error("Spending keys not initialized");
    }

    // Always sync before proving to avoid stale roots
    await this.epochManager.sync();

    // Decode recipient address to get their spending key
    const recipientSpendingKey =
      KeyManager.decodeShieldedAddress(recipientAddress);

    // Select notes to spend (require two inputs for transfer circuit)
    let inputNotes: Note[];
    try {
      inputNotes = this.noteManager.selectNotes(amount, 2);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Insufficient note count")
      ) {
        throw new Error(
          "Shielded transfers require at least two spendable notes. Create another note (e.g. deposit again or split a note) before transferring.",
        );
      }
      throw error;
    }
    const inputAmount = inputNotes.reduce((sum, note) => sum + note.value, 0n);

    // All inputs must carry epoch and leaf index for merkle proofs
    const missingInfo = inputNotes.find(
      (n) => n.leafIndex === undefined || n.epoch === undefined,
    );
    if (missingInfo) {
      throw new Error(
        "Input note missing epoch or leaf index; resync and retry",
      );
    }

    // Calculate change
    const change = inputAmount - amount;

    // Create output notes (go to current epoch)
    const outputNotes: Note[] = [];
    let changeNote: Note | undefined;

    // Note to recipient
    const recipientNote = await this.noteManager.createNote(
      amount,
      recipientSpendingKey,
    );
    outputNotes.push(recipientNote);

    // Change note to self if needed
    if (change > 0n) {
      changeNote = await this.noteManager.createNote(
        change,
        this.spendingKeys.spendingKey,
      );
      outputNotes.push(changeNote);
    }
    const transferArtifacts = await this.configuredArtifacts("transfer");

    // Keep a snapshot for tests/off-chain delivery
    this.lastOutputNotes = outputNotes.map((n) => ({ ...n }));

    // Build transfer transaction using epoch manager
    const tx = await this.txBuilder.buildTransfer(
      inputNotes,
      outputNotes,
      this.spendingKeys,
      this.epochManager,
      transferArtifacts,
    );

    // Sign and send
    const signature = await this.provider.sendAndConfirm(
      tx,
      this.payer ? [this.payer] : [],
    );

    // Mark input notes as spent
    for (const note of inputNotes) {
      this.noteManager.markSpent(note.commitment);
    }

    // Add output notes (change only - recipient's note won't be ours)
    if (change > 0n && changeNote) {
      this.noteManager.addPendingNote(changeNote);

      // In test mode, immediately promote change note to confirmed
      if (this.config?.testMode) {
        const epochTree = await this.fetchCurrentEpochTree();
        const nextIndex = Number(epochTree.nextIndex);
        changeNote.epoch = this.currentEpoch;
        changeNote.leafIndex = nextIndex - 1;
        this.noteManager.addNote(changeNote);
      }
    }

    if (!this.config?.testMode) {
      await this.scanner.rescanSignature(signature);
      await this.epochManager.sync();

      // If we produced a change note, recompute its nullifier with real epoch/leafIndex
      if (change > 0n && changeNote) {
        await this.noteManager.recomputeNullifier(changeNote);
      }
    }

    return signature;
  }

  // ============================================================
  // EPOCH LIFECYCLE OPERATIONS
  // ============================================================

  /**
   * Renew notes that are expiring (migrate to current epoch)
   * Returns number of notes renewed and their total value
   */
  async renewExpiringNotes(maxNotes: number = 10): Promise<{
    renewed: number;
    value: bigint;
    signatures: string[];
  }> {
    this.ensureInitialized();

    if (!this.spendingKeys) {
      throw new Error("Spending keys not initialized");
    }

    const notesToRenew = this.noteManager.selectNotesForRenewal(maxNotes);
    if (notesToRenew.length === 0) {
      return { renewed: 0, value: 0n, signatures: [] };
    }

    const signatures: string[] = [];
    let totalValue = 0n;

    const renewArtifacts = await this.configuredArtifacts("renew");

    for (const oldNote of notesToRenew) {
      try {
        // Create new note with same value for current epoch
        const newNote = await this.noteManager.createNote(
          oldNote.value,
          this.spendingKeys.spendingKey,
        );
        newNote.epoch = this.currentEpoch;

        // Build renew transaction
        const tx = await this.txBuilder.buildRenew(
          oldNote,
          newNote,
          this.spendingKeys,
          this.epochManager,
          renewArtifacts,
        );

        // Send transaction
        const signature = await this.provider.sendAndConfirm(
          tx,
          this.payer ? [this.payer] : [],
        );

        // Mark old note as spent, add new note
        this.noteManager.markSpent(oldNote.commitment);
        this.noteManager.addPendingNote(newNote);

        if (!this.config?.testMode) {
          await this.scanner.rescanSignature(signature);
        }

        signatures.push(signature);
        totalValue += oldNote.value;
      } catch (error) {
        console.error(`Failed to renew note:`, error);
      }
    }

    await this.epochManager.sync();
    return { renewed: signatures.length, value: totalValue, signatures };
  }

  /**
   * Trigger epoch rollover (permissionless)
   * Returns the new epoch number
   */
  async rolloverEpoch(): Promise<bigint> {
    this.ensureInitialized();

    if (!this.payer) {
      throw new Error("Payer required for epoch rollover");
    }

    const newEpoch = this.currentEpoch + 1n;
    const tx = await this.txBuilder.buildRolloverEpoch(
      this.payer.publicKey,
      newEpoch,
    );

    await this.provider.sendAndConfirm(tx, [this.payer]);

    // Update local state
    this.currentEpoch = newEpoch;
    this.noteManager.setCurrentEpoch(newEpoch);
    await this.epochManager.sync();

    return newEpoch;
  }

  /**
   * Finalize an epoch (permissionless)
   */
  async finalizeEpoch(epoch: bigint): Promise<string> {
    this.ensureInitialized();

    if (!this.payer) {
      throw new Error("Payer required for epoch finalization");
    }

    const tx = await this.txBuilder.buildFinalizeEpoch(
      this.payer.publicKey,
      epoch,
    );

    const signature = await this.provider.sendAndConfirm(tx, [this.payer]);
    await this.epochManager.sync();

    return signature;
  }

  /**
   * Garbage collect an expired epoch (permissionless, earns rent)
   */
  async garbageCollect(epoch: bigint): Promise<GarbageCollectInfo> {
    this.ensureInitialized();

    if (!this.payer) {
      throw new Error("Payer required for garbage collection");
    }

    const { transaction, gcInfo } = await this.txBuilder.buildGarbageCollect(
      this.payer.publicKey,
      epoch,
    );

    await this.provider.sendAndConfirm(transaction, [this.payer]);

    return gcInfo!;
  }

  /**
   * Find expired epochs that can be garbage collected
   */
  async findGarbageCollectableEpochs(): Promise<GarbageCollectInfo> {
    this.ensureInitialized();

    // This would query the chain for expired epochs
    // For now, return empty info
    return {
      epochsAvailable: [],
      estimatedRentRecovery: 0n,
      accountsToClose: 0,
    };
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Fetch current epoch tree data from chain
   */
  private async fetchCurrentEpochTree(): Promise<any> {
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(this.currentEpoch);

    const [epochTreePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("epoch_tree"), this.poolConfig.toBuffer(), epochBytes],
      this.programId,
    );

    return (this.program.account as any).epochTree.fetch(epochTreePda);
  }

  /**
   * Gracefully stop background tasks (scanner subscriptions, etc.)
   */
  async stop(): Promise<void> {
    try {
      await this.scanner.stop();
    } catch (err) {
      console.warn("ShieldedPoolClient.stop(): scanner stop failed", err);
    }
  }

  /**
   * Ensure client is initialized before operations
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error(
        "Client not initialized. Call init() first or use static create methods.",
      );
    }
  }

  /**
   * Resolve prover artifacts for a given circuit, honoring optional baseDir overrides.
   */
  private async configuredArtifacts(kind: "withdraw" | "transfer" | "renew") {
    const baseDir = (this as any).config?.artifactsBaseDir;
    const defaults = PROVER_ARTIFACTS[kind];

    if (baseDir) {
      try {
        const path = require("path");
        const artifacts = await loadArtifacts({
          wasm: path.join(baseDir, `${kind}.wasm`),
          zkey: path.join(baseDir, `${kind}_final.zkey`),
        });
        return artifacts;
      } catch (e) {
        console.warn(
          `Artifacts load failed from baseDir ${baseDir}:`,
          (e as Error).message,
          "- falling back to defaults",
        );
        return defaults;
      }
    }
    return defaults;
  }
}
