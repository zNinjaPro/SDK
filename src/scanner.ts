/**
 * UTXOScanner - Scans chain for relevant events and updates note state
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { NoteManager } from "./noteManager";
import { Note } from "./types";
import { decryptNote } from "./crypto";
import crypto from "crypto";

export class UTXOScanner {
  private connection: Connection;
  private program: Program;
  private poolConfig: PublicKey;
  private isRunning: boolean = false;
  private subscriptionId?: number;
  private viewingKey?: Uint8Array;
  private noteManager?: NoteManager;

  constructor(connection: Connection, program: Program, poolConfig: PublicKey) {
    this.connection = connection;
    this.program = program;
    this.poolConfig = poolConfig;
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
    } catch (e) {
      console.warn("[Scanner] Rescan failed for", signature, e);
    }
  }

  // Anchor event discriminators: sha256("event:Name").slice(0,8)
  private static DEPOSIT_EVENT_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:DepositEventV1")
    .digest()
    .subarray(0, 8);
  private static WITHDRAW_EVENT_DISCRIMINATOR = crypto
    .createHash("sha256")
    .update("event:WithdrawEventV1")
    .digest()
    .subarray(0, 8);
  private static TRANSFER_EVENT_DISCRIMINATOR = crypto
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
      "confirmed"
    );

    // Scan historical events in background (don't await)
    this.scanHistory().catch((error) => {
      console.error("Error scanning history:", error);
    });
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
   * Scan historical events to catch up
   */
  private async scanHistory(): Promise<void> {
    // Get recent transactions for this pool
    const signatures = await this.connection.getSignaturesForAddress(
      this.poolConfig,
      { limit: 100 }
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
      } catch (error) {
        console.error(`Error processing transaction ${sig.signature}:`, error);
      }
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
      if (arraysEqual(discriminator, UTXOScanner.DEPOSIT_EVENT_DISCRIMINATOR)) {
        await this.handleDepositEvent(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.WITHDRAW_EVENT_DISCRIMINATOR)
      ) {
        await this.handleWithdrawEvent(eventData);
      } else if (
        arraysEqual(discriminator, UTXOScanner.TRANSFER_EVENT_DISCRIMINATOR)
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
    console.log(
      "🔍 Scanner: Extracted commitment from event, length:",
      commitment.length
    );
    const leafIndexOffset = cmOffset + 32;
    const leafIndexLE = data.subarray(leafIndexOffset, leafIndexOffset + 8);
    const leafIndex = Number(leafIndexLE.readBigUInt64LE());
    console.log("🔍 Scanner: leafIndex =", leafIndex);
    const encLenOffset = leafIndexOffset + 8 + 32 + 32 + 16; // skip new_root + tx_anchor + tag
    if (data.length < encLenOffset + 4) return;
    const encLen = data.readUInt32LE(encLenOffset);
    const encStart = encLenOffset + 4;
    const encEnd = encStart + encLen;
    if (data.length < encEnd) return;
    const encryptedNote = data.subarray(encStart, encEnd);

    // Promote pending note matching commitment
    const pending = (this.noteManager as any).pendingNotes as
      | Note[]
      | undefined;
    if (pending) {
      console.log("🔍 Scanner: Found", pending.length, "pending notes");
      if (pending.length > 0) {
        console.log(
          "   Pending[0] commitment length:",
          pending[0].commitment.length
        );
      }
      const idx = pending.findIndex((n) =>
        arraysEqual(n.commitment, commitment)
      );
      if (idx !== -1) {
        console.log("✅ Scanner: Found matching pending note at index", idx);
        const note = pending[idx];
        note.leafIndex = leafIndex;
        this.noteManager.addNote(note);
        return;
      }
      // No matching pending note; leave pending untouched to avoid corrupting leafIndex/commitment mapping
      console.log(
        "⚠️ Scanner: No matching commitment; leaving pending notes unchanged"
      );
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
      const pending = (this.noteManager as any).pendingNotes as
        | Note[]
        | undefined;
      if (pending) {
        for (const cm of commitments) {
          const idx = pending.findIndex((n) => arraysEqual(n.commitment, cm));
          if (idx !== -1) {
            const note = pending[idx];
            this.noteManager!.addNote(note);
          }
        }
      }
    } catch (error) {
      // Ignore
    }
  }

  /**
   * Try to decrypt a note with our viewing key
   */
  private async tryDecryptNote(
    commitment: Buffer,
    encryptedNote: Buffer
  ): Promise<Note | null> {
    if (!this.viewingKey) return null;

    try {
      const nonce = encryptedNote.slice(0, 24);
      const encrypted = encryptedNote.slice(24);
      const decrypted = decryptNote(encrypted, nonce, this.viewingKey);
      if (!decrypted) return null;

      const note = { commitment: Array.from(commitment) } as any; // Simplified for scanning

      // Verify commitment matches
      // (simplified - in production should recompute commitment)

      return {
        ...note,
        commitment: Array.from(commitment),
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
