/**
 * UTXOScanner - Epoch-aware scanning for chain events and note state updates
 *
 * Scans for:
 * - DepositEvent (with epoch info)
 * - WithdrawEvent (with nullifier tracking)
 * - TransferEvent (with epoch-scoped nullifiers and outputs)
 * - RenewEvent (epoch migration)
 * - EpochRolloverEvent
 * - EpochFinalizedEvent
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { NoteManager } from "./noteManager";
import { Note, EpochState } from "./types";
import { decryptNote, deserializeNote } from "./crypto";
import crypto from "crypto";

/**
 * Callback for epoch state changes
 */
export type EpochCallback = (epoch: bigint, state: EpochState) => void;

export class UTXOScanner {
  private connection: Connection;
  private program: Program;
  private poolConfig: PublicKey;
  private isRunning: boolean = false;
  private subscriptionId?: number;
  private viewingKey?: Uint8Array;
  private noteManager?: NoteManager;
  private epochCallbacks: EpochCallback[] = [];
  private historyScanLimit: number;

  constructor(
    connection: Connection,
    program: Program,
    poolConfig: PublicKey,
    options?: { historyScanLimit?: number },
  ) {
    this.connection = connection;
    this.program = program;
    this.poolConfig = poolConfig;
    this.historyScanLimit = options?.historyScanLimit ?? 100;
  }

  /** Get the current history scan limit */
  getHistoryScanLimit(): number {
    return this.historyScanLimit;
  }

  /** Set the history scan limit */
  setHistoryScanLimit(limit: number): void {
    this.historyScanLimit = limit;
  }

  /** Register a callback for epoch state changes */
  onEpochChange(callback: EpochCallback): void {
    this.epochCallbacks.push(callback);
  }

  /** Rescan a specific confirmed transaction by signature (used to promote pending notes emitted in same tx) */
  async rescanSignature(signature: string): Promise<void> {
    if (!this.viewingKey || !this.noteManager) return;
    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx && tx.meta && tx.meta.logMessages) {
        await this.processTxLogs(tx.meta.logMessages);
      }
    } catch (e) {}
  }

  // Anchor event discriminators: sha256("event:Name").slice(0,8)
  // V2 epoch-aware events
  private static DEPOSIT_EVENT_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:DepositEvent")
    .digest()
    .subarray(0, 8);
  private static WITHDRAW_EVENT_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:WithdrawEvent")
    .digest()
    .subarray(0, 8);
  private static TRANSFER_EVENT_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:TransferEvent")
    .digest()
    .subarray(0, 8);
  private static RENEW_EVENT_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:RenewEvent")
    .digest()
    .subarray(0, 8);
  private static EPOCH_ROLLOVER_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:EpochRolloverEvent")
    .digest()
    .subarray(0, 8);
  private static EPOCH_FINALIZED_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:EpochFinalizedEvent")
    .digest()
    .subarray(0, 8);

  // Legacy V1 events for backwards compatibility during migration
  private static DEPOSIT_V1_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:DepositEventV1")
    .digest()
    .subarray(0, 8);
  private static WITHDRAW_V1_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:WithdrawEventV1")
    .digest()
    .subarray(0, 8);
  private static TRANSFER_V1_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:ShieldedTransferEventV1")
    .digest()
    .subarray(0, 8);

  /**
   * Start scanning for events
   */
  async start(viewingKey: Uint8Array, noteManager: NoteManager): Promise<void> {
    if (this.isRunning) {
      throw new Error("Scanner already running");
    }

    this.viewingKey = viewingKey;
    this.noteManager = noteManager;
    this.isRunning = true;

    // Subscribe to program logs
    this.subscriptionId = this.connection.onLogs(
      this.program.programId,
      async (logs) => {
        await this.processLogs(logs);
      },
      "confirmed",
    );

    // Scan historical events in background (don't await)
    this.scanHistory().catch((error) => {});
  }

  /**
   * Stop scanning
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    if (this.subscriptionId !== undefined) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
    }

    this.isRunning = false;
  }

  /**
   * Scan historical events to catch up.
   * Can be called externally for wallet recovery.
   */
  async scanHistory(): Promise<void> {
    // Get recent transactions for this pool
    const signatures = await this.connection.getSignaturesForAddress(
      this.poolConfig,
      { limit: this.historyScanLimit },
    );

    for (const sig of signatures) {
      try {
        const tx = await this.connection.getTransaction(sig.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });

        if (tx && tx.meta) {
          await this.processTxLogs(tx.meta.logMessages || []);
        }
      } catch (error) {}
    }
  }

  /**
   * Process logs from a subscription
   */
  private async processLogs(logs: any): Promise<void> {
    if (logs.logs) {
      await this.processTxLogs(logs.logs);
    }
  }

  /**
   * Process transaction logs to extract events
   */
  private async processTxLogs(logs: string[]): Promise<void> {
    if (!this.viewingKey || !this.noteManager) return;

    for (const log of logs) {
      if (!log.includes("Program data:")) continue;
      const dataMatch = log.match(/Program data: ([A-Za-z0-9+/=]+)/);
      if (!dataMatch) continue;
      let eventData: Buffer;
      try {
        eventData = Buffer.from(dataMatch[1], "base64");
      } catch {
        continue;
      }
      if (eventData.length < 8) continue;
      const discriminator = eventData.subarray(0, 8);

      // V2 epoch-aware events
      if (arraysEqual(discriminator, UTXOScanner.DEPOSIT_EVENT_DISCRIMINATOR)) {
        await this.handleDepositEventV2(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.WITHDRAW_EVENT_DISCRIMINATOR)
      ) {
        await this.handleWithdrawEventV2(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.TRANSFER_EVENT_DISCRIMINATOR)
      ) {
        await this.handleTransferEventV2(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.RENEW_EVENT_DISCRIMINATOR)
      ) {
        await this.handleRenewEvent(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.EPOCH_ROLLOVER_DISCRIMINATOR)
      ) {
        await this.handleEpochRolloverEvent(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.EPOCH_FINALIZED_DISCRIMINATOR)
      ) {
        await this.handleEpochFinalizedEvent(eventData);
      }
      // Legacy V1 events (for historical data)
      else if (
        arraysEqual(discriminator, UTXOScanner.DEPOSIT_V1_DISCRIMINATOR)
      ) {
        await this.handleDepositEvent(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.WITHDRAW_V1_DISCRIMINATOR)
      ) {
        await this.handleWithdrawEvent(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.TRANSFER_V1_DISCRIMINATOR)
      ) {
        await this.handleTransferEvent(eventData);
      }
    }
  }

  /**
   * Handle deposit events
   */
  private async handleDepositEvent(data: Buffer): Promise<void> {
    if (!this.noteManager) return;
    // Layout after discriminator:
    // version(1) pool_id(32) chain_id(32) cm(32) leaf_index(u64) new_root(32) tx_anchor(32) tag(16) enc_note(Vec<u8>)
    const minimum = 8 + 1 + 32 + 32 + 32 + 8 + 32 + 32 + 16 + 4; // discriminator + fixed + vec len
    if (data.length < minimum) return;
    const cmOffset = 8 + 1 + 32 + 32;
    const commitment = data.subarray(cmOffset, cmOffset + 32);
    const leafIndexOffset = cmOffset + 32;
    const leafIndexLE = data.subarray(leafIndexOffset, leafIndexOffset + 8);
    const leafIndex = Number(leafIndexLE.readBigUInt64LE());
    const encLenOffset = leafIndexOffset + 8 + 32 + 32 + 16; // skip new_root + tx_anchor + tag
    if (data.length < encLenOffset + 4) return;
    const encLen = data.readUInt32LE(encLenOffset);
    const encStart = encLenOffset + 4;
    const encEnd = encStart + encLen;
    if (data.length < encEnd) return;
    const encryptedNote = data.subarray(encStart, encEnd);

    // Promote pending note matching commitment
    const pending = this.noteManager ? this.noteManager.getPendingNotes() : [];
    if (pending.length > 0) {
      if (pending.length > 0) {
      }
      const idx = pending.findIndex((n) =>
        arraysEqual(n.commitment, commitment),
      );
      if (idx !== -1) {
        const note = pending[idx];
        note.leafIndex = leafIndex;
        this.noteManager.addNote(note);
        return;
      }
      // No matching pending note; leave pending untouched to avoid corrupting leafIndex/commitment mapping
      return;
    }

    // Attempt decryption fallback
    if (this.viewingKey) {
      const decrypted = await this.tryDecryptNote(commitment, encryptedNote);
      if (decrypted) {
        decrypted.leafIndex = leafIndex;
        this.noteManager.addNote(decrypted);
      }
    }
  }

  /**
   * Handle withdraw events
   */
  private async handleWithdrawEvent(data: Buffer): Promise<void> {
    try {
      // Layout (after discriminator + version + ids): version(1) pool_id(32) chain_id(32) root_prev(32) new_root(32) tx_anchor(32) n_in(u8) nf_in(Vec<[u8;32]>) ...
      const baseOffset = 8 + 1 + 32 + 32 + 32 + 32 + 32; // disc + fixed fields till tx_anchor
      if (data.length < baseOffset + 1) return;
      const nIn = data.readUInt8(baseOffset);
      let cursor = baseOffset + 1;
      if (data.length < cursor + 4) return;
      const nfLen = data.readUInt32LE(cursor); // should equal nIn
      cursor += 4;
      for (let i = 0; i < nfLen; i++) {
        const start = cursor + i * 32;
        const end = start + 32;
        if (end > data.length) break;
        const nullifier = data.subarray(start, end);
        this.noteManager!.markSpentByNullifier(nullifier);
      }
    } catch (error) {
      // Ignore
    }
  }

  /**
   * Handle shielded transfer events
   */
  private async handleTransferEvent(data: Buffer): Promise<void> {
    try {
      // Layout (after discriminator + version + ids): version(1) pool_id(32) chain_id(32) root_prev(32) new_root(32) tx_anchor(32) n_in(u8) n_out(u8)
      // nf_in(Vec<[u8;32]>) cm_out(Vec<[u8;32]>) ... Simplified: mark spent nullifiers, promote pending outputs.
      const baseOffset = 8 + 1 + 32 + 32 + 32 + 32 + 32; // disc + fixed till tx_anchor
      if (data.length < baseOffset + 2) return;
      const nIn = data.readUInt8(baseOffset);
      const nOut = data.readUInt8(baseOffset + 1);
      let cursor = baseOffset + 2;
      if (data.length < cursor + 4) return;
      const nfLen = data.readUInt32LE(cursor);
      cursor += 4;
      for (let i = 0; i < nfLen; i++) {
        const start = cursor + i * 32;
        const end = start + 32;
        if (end > data.length) break;
        this.noteManager!.markSpentByNullifier(data.subarray(start, end));
      }
      cursor += nfLen * 32;
      if (data.length < cursor + 4) return;
      const cmLen = data.readUInt32LE(cursor); // should equal nOut
      cursor += 4;
      const commitments: Uint8Array[] = [];
      for (let i = 0; i < cmLen; i++) {
        const start = cursor + i * 32;
        const end = start + 32;
        if (end > data.length) break;
        commitments.push(new Uint8Array(data.subarray(start, end)));
      }
      const pending = this.noteManager
        ? this.noteManager.getPendingNotes()
        : [];
      for (const cm of commitments) {
        const idx = pending.findIndex((n) => arraysEqual(n.commitment, cm));
        if (idx !== -1) {
          const note = pending[idx];
          this.noteManager!.addNote(note);
        }
      }
    } catch (error) {
      // Ignore
    }
  }

  // ============================================================
  // V2 EPOCH-AWARE EVENT HANDLERS
  // ============================================================

  /**
   * Handle V2 deposit events with epoch information
   * Layout: discriminator(8) | epoch(u64) | pool_id(32) | cm(32) | leaf_index(u64) | new_root(32) | enc_note(Vec<u8>)
   */
  private async handleDepositEventV2(data: Buffer): Promise<void> {
    if (!this.noteManager) return;

    const minimum = 8 + 8 + 32 + 32 + 8 + 32 + 4; // discriminator + epoch + pool + cm + idx + root + vec_len
    if (data.length < minimum) return;

    let cursor = 8; // skip discriminator

    // Extract epoch
    const epoch = data.readBigUInt64LE(cursor);
    cursor += 8;

    // Skip pool_id
    cursor += 32;

    // Extract commitment
    const commitment = data.subarray(cursor, cursor + 32);
    cursor += 32;

    // Extract leaf index
    const leafIndex = Number(data.readBigUInt64LE(cursor));
    cursor += 8;

    // Skip new_root
    cursor += 32;

    // Extract encrypted note
    if (data.length < cursor + 4) return;
    const encLen = data.readUInt32LE(cursor);
    cursor += 4;
    if (data.length < cursor + encLen) return;
    const encryptedNote = data.subarray(cursor, cursor + encLen);

    // Promote pending note matching commitment
    const pending = this.noteManager ? this.noteManager.getPendingNotes() : [];
    if (pending.length > 0) {
      const idx = pending.findIndex((n) =>
        arraysEqual(n.commitment, commitment),
      );
      if (idx !== -1) {
        const note = pending[idx];
        note.epoch = epoch;
        note.leafIndex = leafIndex;
        this.noteManager.addNote(note);
        return;
      }
    }

    // Attempt decryption fallback
    if (this.viewingKey) {
      const decrypted = await this.tryDecryptNote(commitment, encryptedNote);
      if (decrypted) {
        decrypted.epoch = epoch;
        decrypted.leafIndex = leafIndex;
        this.noteManager.addNote(decrypted);
      }
    }
  }

  /**
   * Handle V2 withdraw events with epoch-scoped nullifiers
   * Layout: discriminator(8) | epoch(u64) | pool_id(32) | nullifier(32) | amount(u64) | recipient(32)
   */
  private async handleWithdrawEventV2(data: Buffer): Promise<void> {
    if (!this.noteManager) return;

    const minimum = 8 + 8 + 32 + 32 + 8 + 32;
    if (data.length < minimum) return;

    let cursor = 8; // skip discriminator

    const epoch = data.readBigUInt64LE(cursor);
    cursor += 8;

    // Skip pool_id
    cursor += 32;

    // Extract nullifier
    const nullifier = data.subarray(cursor, cursor + 32);

    this.noteManager.markSpentByNullifier(nullifier, epoch);
  }

  /**
   * Handle V2 transfer events with epoch-scoped nullifiers and outputs
   * Layout: discriminator(8) | output_epoch(u64) | pool_id(32) | nullifiers(Vec<[u8;32]>) |
   *         input_epochs(Vec<u64>) | commitments(Vec<[u8;32]>) | leaf_indices(Vec<u64>)
   */
  private async handleTransferEventV2(data: Buffer): Promise<void> {
    if (!this.noteManager) return;

    const minimum = 8 + 8 + 32 + 4; // discriminator + output_epoch + pool + vec_len
    if (data.length < minimum) return;

    let cursor = 8; // skip discriminator

    const outputEpoch = data.readBigUInt64LE(cursor);
    cursor += 8;

    // Skip pool_id
    cursor += 32;

    // Read nullifiers vector
    if (data.length < cursor + 4) return;
    const nfLen = data.readUInt32LE(cursor);
    cursor += 4;

    const nullifiers: Uint8Array[] = [];
    for (let i = 0; i < nfLen; i++) {
      if (cursor + 32 > data.length) return;
      nullifiers.push(new Uint8Array(data.subarray(cursor, cursor + 32)));
      cursor += 32;
    }

    // Read input epochs vector
    if (data.length < cursor + 4) return;
    const epochLen = data.readUInt32LE(cursor);
    cursor += 4;

    const inputEpochs: bigint[] = [];
    for (let i = 0; i < epochLen; i++) {
      if (cursor + 8 > data.length) return;
      inputEpochs.push(data.readBigUInt64LE(cursor));
      cursor += 8;
    }

    // Mark nullifiers as spent with their respective epochs
    for (let i = 0; i < nullifiers.length; i++) {
      const nfEpoch = i < inputEpochs.length ? inputEpochs[i] : 0n;
      this.noteManager.markSpentByNullifier(nullifiers[i], nfEpoch);
    }

    // Read output commitments
    if (data.length < cursor + 4) return;
    const cmLen = data.readUInt32LE(cursor);
    cursor += 4;

    const commitments: Uint8Array[] = [];
    for (let i = 0; i < cmLen; i++) {
      if (cursor + 32 > data.length) return;
      commitments.push(new Uint8Array(data.subarray(cursor, cursor + 32)));
      cursor += 32;
    }

    // Read leaf indices
    if (data.length < cursor + 4) return;
    const idxLen = data.readUInt32LE(cursor);
    cursor += 4;

    const leafIndices: number[] = [];
    for (let i = 0; i < idxLen; i++) {
      if (cursor + 8 > data.length) return;
      leafIndices.push(Number(data.readBigUInt64LE(cursor)));
      cursor += 8;
    }

    // Promote pending notes
    const pending = this.noteManager ? this.noteManager.getPendingNotes() : [];
    for (let i = 0; i < commitments.length; i++) {
      const cm = commitments[i];
      const idx = pending.findIndex((n) => arraysEqual(n.commitment, cm));
      if (idx !== -1) {
        const note = pending[idx];
        note.epoch = outputEpoch;
        note.leafIndex = i < leafIndices.length ? leafIndices[i] : 0;
        this.noteManager.addNote(note);
      }
    }
  }

  /**
   * Handle renew events (epoch migration)
   * Layout: discriminator(8) | old_epoch(u64) | new_epoch(u64) | pool_id(32) |
   *         old_nullifier(32) | new_commitment(32) | new_leaf_index(u64)
   */
  private async handleRenewEvent(data: Buffer): Promise<void> {
    if (!this.noteManager) return;

    const minimum = 8 + 8 + 8 + 32 + 32 + 32 + 8;
    if (data.length < minimum) return;

    let cursor = 8; // skip discriminator

    const oldEpoch = data.readBigUInt64LE(cursor);
    cursor += 8;

    const newEpoch = data.readBigUInt64LE(cursor);
    cursor += 8;

    // Skip pool_id
    cursor += 32;

    // Extract old nullifier (marks old note as spent)
    const oldNullifier = data.subarray(cursor, cursor + 32);
    cursor += 32;

    // Extract new commitment
    const newCommitment = data.subarray(cursor, cursor + 32);
    cursor += 32;

    // Extract new leaf index
    const newLeafIndex = Number(data.readBigUInt64LE(cursor));

    // Mark old note as spent
    this.noteManager.markSpentByNullifier(oldNullifier, oldEpoch);

    // Promote pending new note
    const pending = this.noteManager ? this.noteManager.getPendingNotes() : [];
    if (pending.length > 0) {
      const idx = pending.findIndex((n) =>
        arraysEqual(n.commitment, newCommitment),
      );
      if (idx !== -1) {
        const note = pending[idx];
        note.epoch = newEpoch;
        note.leafIndex = newLeafIndex;
        this.noteManager.addNote(note);
      }
    }
  }

  /**
   * Handle epoch rollover events
   * Layout: discriminator(8) | old_epoch(u64) | new_epoch(u64) | slot(u64)
   */
  private async handleEpochRolloverEvent(data: Buffer): Promise<void> {
    const minimum = 8 + 8 + 8 + 8;
    if (data.length < minimum) return;

    let cursor = 8;
    const oldEpoch = data.readBigUInt64LE(cursor);
    cursor += 8;
    const newEpoch = data.readBigUInt64LE(cursor);

    // Notify callbacks
    for (const cb of this.epochCallbacks) {
      try {
        cb(oldEpoch, EpochState.Frozen);
        cb(newEpoch, EpochState.Active);
      } catch (e) {}
    }
  }

  /**
   * Handle epoch finalized events
   * Layout: discriminator(8) | epoch(u64) | final_root(32) | slot(u64)
   */
  private async handleEpochFinalizedEvent(data: Buffer): Promise<void> {
    const minimum = 8 + 8 + 32 + 8;
    if (data.length < minimum) return;

    let cursor = 8;
    const epoch = data.readBigUInt64LE(cursor);

    // Notify callbacks
    for (const cb of this.epochCallbacks) {
      try {
        cb(epoch, EpochState.Finalized);
      } catch (e) {}
    }
  }

  /**
   * Try to decrypt a note with our viewing key
   */
  private async tryDecryptNote(
    commitment: Buffer,
    encryptedNote: Buffer,
  ): Promise<Note | null> {
    if (!this.viewingKey) return null;

    try {
      const nonce = encryptedNote.slice(0, 24);
      const encrypted = encryptedNote.slice(24);
      const decrypted = decryptNote(encrypted, nonce, this.viewingKey);
      if (!decrypted) return null;

      // Parse the decrypted note data: value(32) || token(32) || owner(32) || blinding(32) || memo_len(2) || memo
      const { value, token, owner, blinding, memo } =
        deserializeNote(decrypted);

      return {
        value,
        token: new PublicKey(token),
        owner,
        blinding,
        memo,
        commitment: new Uint8Array(commitment),
        nullifier: new Uint8Array(32), // Computed later when epoch/leafIndex are known
        randomness: blinding, // Blinding is the randomness
      };
    } catch (error) {
      // Decryption failed - not our note
      return null;
    }
  }
}

function arraysEqual(a: Uint8Array | Buffer, b: Uint8Array | Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
