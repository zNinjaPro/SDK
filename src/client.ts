/**
 * Main ShieldedPoolClient class
 * Provides high-level API for interacting with the shielded pool
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
import { MerkleTreeSync } from "./merkle";
import { UTXOScanner } from "./scanner";
import { TransactionBuilder } from "./txBuilder";
import { Note, SpendingKeys, PoolConfig as PoolConfigType } from "./types";
import { PROVER_ARTIFACTS } from "./config";
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
  private merkleTree: MerkleTreeSync;
  private scanner: UTXOScanner;
  private txBuilder: TransactionBuilder;
  private lastOutputNotes?: Note[];

  private spendingKeys?: SpendingKeys;
  private isInitialized: boolean = false;

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
      { commitment: "confirmed" }
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
    this.merkleTree = new MerkleTreeSync(
      this.connection,
      this.program,
      this.poolConfig
    );
    this.scanner = new UTXOScanner(
      this.connection,
      this.program,
      this.poolConfig
    );
    this.txBuilder = new TransactionBuilder(
      this.program,
      this.poolConfig,
      this.connection
    );
  }

  /**
   * Create a new client with a random mnemonic
   */
  static async create(
    config: ShieldedPoolClientConfig
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
    mnemonic: string
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
    seed: Buffer
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

    // Sync merkle tree from chain; in testMode tolerate missing poolConfig
    try {
      await this.merkleTree.sync();
    } catch (e) {
      if (this.config?.testMode) {
        console.warn(
          "⚠️ Merkle sync skipped in testMode:",
          (e as Error).message
        );
      } else {
        throw e;
      }
    }

    // Start scanner unless in test mode
    if (!this.config?.testMode) {
      await this.scanner.start(this.spendingKeys.viewingKey, this.noteManager);
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
   * Get the current shielded balance
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
   * Deposit tokens into the shielded pool
   */
  async deposit(amount: bigint): Promise<string> {
    this.ensureInitialized();

    if (!this.payer) {
      throw new Error("Payer required for deposit");
    }

    // Create a new output note
    const outputNote = await this.noteManager.createNote(
      amount,
      this.keyManager.getSpendingKey()
    );

    // Build deposit transaction
    const tx = await this.txBuilder.buildDeposit(
      this.payer.publicKey,
      outputNote,
      this.merkleTree
    );

    // Sign and send
    const signature = await this.provider.sendAndConfirm(tx, [this.payer]);

    // Add note to manager (will be confirmed by scanner)
    this.noteManager.addPendingNote(outputNote);

    // In normal mode, rescan to promote pending note; in test mode, directly promote to confirmed
    if (!this.config?.testMode) {
      await this.scanner.rescanSignature(signature);
      // Refresh merkle tree to include new leaf
      await this.merkleTree.sync();
    } else {
      // In test mode, immediately promote pending to confirmed
      // We need to fetch the leafIndex from the chain
      const poolConfigAccount = await (
        this.program.account as any
      ).poolConfig.fetch(this.poolConfig);
      const mint = poolConfigAccount.mint;
      const [poolTreePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("tree"), mint.toBuffer()],
        this.programId
      );
      const poolTree = await (this.program.account as any).poolTree.fetch(
        poolTreePDA
      );
      const leafIndex = Number(poolTree.nextIndex) - 1; // Just deposited, so it's the previous index
      outputNote.leafIndex = leafIndex;
      this.noteManager.addNote(outputNote);
      // Also sync merkle tree to include the new leaf
      await this.merkleTree.sync();
    }

    // Debug: Check what notes we have
    const allNotes = this.noteManager.getNotes();
    console.log("📋 Notes after deposit:");
    allNotes.forEach((n, i) => {
      console.log(
        `   Note ${i}: value=${n.value}, commitment_len=${n.commitment.length}, leafIndex=${n.leafIndex}`
      );
    });

    return signature;
  }

  /**
   * Wait until balance reaches at least minBalance, or timeout.
   */
  async waitForBalance(
    minBalance: bigint,
    timeoutMs: number = 30000
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

    // Always sync before proving to avoid stale roots, even in testMode.
    await this.merkleTree.sync();

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
          "Insufficient spendable notes for withdrawal. Deposit or wait for notes to confirm."
        );
      }
      throw error;
    }
    if (inputNotes.length === 0) {
      throw new Error("Insufficient balance for withdrawal");
    }

    // Use the first note that covers the amount
    const inputNote = inputNotes[0];
    if (inputNote.leafIndex === undefined) {
      throw new Error("Input note missing leaf index; resync and retry");
    }
    console.log("📝 Selected note for withdrawal:");
    console.log("   Value:", inputNote.value.toString());
    console.log("   Commitment length:", inputNote.commitment.length);
    console.log(
      "   Commitment (hex):",
      Buffer.from(inputNote.commitment).toString("hex").slice(0, 64)
    );
    // Resolve prover artifacts (allow override via baseDir, else defaults)
    const withdrawArtifacts = await this.configuredArtifacts("withdraw");

    // Build withdraw transaction (no change notes in current implementation)
    const tx = await this.txBuilder.buildWithdraw(
      inputNote,
      amount,
      recipient,
      this.spendingKeys,
      this.merkleTree,
      withdrawArtifacts,
      { merkleOrder: this.config?.merkleOrder || "bottom-up" }
    );

    // Sign and send
    const signature = await this.provider.sendAndConfirm(
      tx,
      this.payer ? [this.payer] : []
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

    // Always sync before proving to avoid stale roots, even in testMode.
    await this.merkleTree.sync();

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
          "Shielded transfers require at least two spendable notes. Create another note (e.g. deposit again or split a note) before transferring."
        );
      }
      throw error;
    }
    const inputAmount = inputNotes.reduce((sum, note) => sum + note.value, 0n);

    // All inputs must carry a leaf index for merkle proofs
    const missingLeaf = inputNotes.find((n) => n.leafIndex === undefined);
    if (missingLeaf) {
      throw new Error("Input note missing leaf index; resync and retry");
    }

    // Calculate change
    const change = inputAmount - amount;

    // Create output notes
    const outputNotes: Note[] = [];
    let changeNote: Note | undefined;

    // Note to recipient
    const recipientNote = await this.noteManager.createNote(
      amount,
      recipientSpendingKey
    );
    outputNotes.push(recipientNote);

    // Change note to self if needed
    if (change > 0n) {
      changeNote = await this.noteManager.createNote(
        change,
        this.spendingKeys.spendingKey
      );
      outputNotes.push(changeNote);
    }
    const transferArtifacts = await this.configuredArtifacts("transfer");

    // Keep a snapshot for tests/off-chain delivery
    this.lastOutputNotes = outputNotes.map((n) => ({ ...n }));

    // Build transfer transaction
    const tx = await this.txBuilder.buildTransfer(
      inputNotes,
      outputNotes,
      this.spendingKeys,
      this.merkleTree,
      transferArtifacts
    );

    // Sign and send
    const signature = await this.provider.sendAndConfirm(
      tx,
      this.payer ? [this.payer] : []
    );

    // Mark input notes as spent
    for (const note of inputNotes) {
      this.noteManager.markSpent(note.commitment);
    }

    // Add output notes (change only - recipient's note won't be ours)
    if (change > 0n) {
      this.noteManager.addPendingNote(outputNotes[1]); // Change note

      // In test mode, immediately promote change note to confirmed
      if (this.config?.testMode) {
        const poolConfigAccount = await (
          this.program.account as any
        ).poolConfig.fetch(this.poolConfig);
        const mint = poolConfigAccount.mint;
        const [poolTreePDA] = PublicKey.findProgramAddressSync(
          [Buffer.from("tree"), mint.toBuffer()],
          this.programId
        );
        const poolTree = await (this.program.account as any).poolTree.fetch(
          poolTreePDA
        );
        // Transfer creates output notes, so they get sequential leafIndexes starting from nextIndex
        const nextIndex = Number(poolTree.nextIndex);
        // Recipient note is first, change note is second
        const changeNote = outputNotes[1];
        changeNote.leafIndex = nextIndex - 1; // Change note gets the last index
        this.noteManager.addNote(changeNote);
      }
    }

    if (!this.config?.testMode) {
      await this.scanner.rescanSignature(signature);
      await this.merkleTree.sync();

      // If we produced a change note, assign its leaf index based on the latest tree state.
      if (change > 0n && changeNote && changeNote.leafIndex === undefined) {
        const foundIndex = this.merkleTree.findLeafIndex(changeNote.commitment);
        const nextIndex = await this.merkleTree.getNextIndex();
        changeNote.leafIndex =
          foundIndex !== undefined ? foundIndex : nextIndex - 1; // fallback to last leaf if not found
        this.noteManager.addNote(changeNote);
      }
    }

    // In non-test mode, let the scanner promote the change note with the correct leaf index.

    return signature;
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
        "Client not initialized. Call init() first or use static create methods."
      );
    }
  }

  /**
   * Resolve prover artifacts for a given circuit, honoring optional baseDir overrides.
   */
  private async configuredArtifacts(kind: "withdraw" | "transfer") {
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
          "- falling back to defaults"
        );
        return defaults;
      }
    }
    return defaults;
  }
}
