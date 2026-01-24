/**
 * Epoch-aware Note (UTXO) management for shielded pool
 *
 * Features:
 * - Tracks notes by epoch for expiration management
 * - Provides epoch-segmented balance calculations
 * - Detects notes needing renewal before expiration
 * - Computes epoch-aware nullifiers (4 inputs)
 */

import { PublicKey } from "@solana/web3.js";
import {
  Note,
  SpendingKeys,
  BalanceInfo,
  EpochInfo,
  EpochState,
} from "./types";
import {
  computeCommitment,
  computeNullifier,
  randomBytes,
  serializeNote,
  deserializeNote,
  encryptNote,
  decryptNote,
} from "./crypto";
import { EPOCH_TIMING } from "./config";

/**
 * Warning threshold for expiring notes (2 epochs before expiration)
 */
const RENEWAL_WARNING_EPOCHS = 2n;

/**
 * Manages note collection with epoch awareness, selection, and balance tracking
 */
export class NoteManager {
  private notes: Note[] = [];
  private pendingNotes: Note[] = [];
  private spendingKeys?: SpendingKeys;
  private currentEpoch: bigint = 0n;
  private epochExpirySlots: bigint;

  constructor(spendingKeys?: SpendingKeys, epochExpirySlots?: bigint) {
    this.spendingKeys = spendingKeys;
    this.epochExpirySlots =
      epochExpirySlots ?? EPOCH_TIMING.DEFAULT_EXPIRY_SLOTS;
  }

  /**
   * Update the current epoch (called when syncing with chain)
   */
  setCurrentEpoch(epoch: bigint): void {
    this.currentEpoch = epoch;
  }

  /**
   * Get the current epoch
   */
  getCurrentEpoch(): bigint {
    return this.currentEpoch;
  }

  /**
   * Add a confirmed note to the collection
   */
  addNote(note: Note): void {
    const existing = this.notes.find((n) =>
      arraysEqual(n.commitment, note.commitment),
    );
    if (existing) {
      // Update epoch and leafIndex if not set
      if (existing.epoch === undefined && note.epoch !== undefined) {
        existing.epoch = note.epoch;
      }
      if (existing.leafIndex === undefined && note.leafIndex !== undefined) {
        existing.leafIndex = note.leafIndex;
      }
      return;
    }

    this.notes.push(note);
    // Remove from pending if it exists
    this.pendingNotes = this.pendingNotes.filter(
      (n) => !arraysEqual(n.commitment, note.commitment),
    );
  }

  /**
   * Add a pending (unconfirmed) note
   */
  addPendingNote(note: Note): void {
    if (
      this.pendingNotes.some((n) => arraysEqual(n.commitment, note.commitment))
    ) {
      return;
    }
    this.pendingNotes.push(note);
  }

  /**
   * Get all pending notes
   */
  getPendingNotes(): Note[] {
    return this.pendingNotes.slice();
  }

  /**
   * Calculate total pending balance
   */
  calculatePendingBalance(): bigint {
    return this.pendingNotes.reduce((sum, note) => sum + note.value, 0n);
  }

  /**
   * Get all notes (excluding spent)
   */
  getNotes(): Note[] {
    return this.notes.filter((n) => !n.spent);
  }

  /**
   * Get notes by epoch
   */
  getNotesByEpoch(epoch: bigint): Note[] {
    return this.notes.filter((n) => !n.spent && n.epoch === epoch);
  }

  /**
   * Get notes that are expiring (within warning threshold)
   */
  getExpiringNotes(): Note[] {
    const expiryThreshold = this.currentEpoch + RENEWAL_WARNING_EPOCHS;
    return this.notes.filter((n) => {
      if (n.spent) return false;
      const noteEpoch = n.epoch ?? 0n;
      // Note expires if its epoch + expiry period is approaching
      return noteEpoch <= expiryThreshold && noteEpoch < this.currentEpoch;
    });
  }

  /**
   * Get notes that have expired and cannot be spent
   */
  getExpiredNotes(): Note[] {
    // Calculate how many epochs back is considered expired
    // (expiry is measured in slots, but we check epoch numbers)
    const expiryEpochs =
      this.epochExpirySlots / EPOCH_TIMING.DEFAULT_DURATION_SLOTS;
    const expiredBefore = this.currentEpoch - expiryEpochs;

    return this.notes.filter((n) => {
      if (n.spent) return false;
      const noteEpoch = n.epoch ?? 0n;
      return noteEpoch < expiredBefore;
    });
  }

  /**
   * Mark a note as spent by commitment
   */
  markSpent(commitment: Uint8Array): void {
    for (const note of this.notes) {
      if (arraysEqual(note.commitment, commitment)) {
        note.spent = true;
        break;
      }
    }
  }

  /**
   * Mark notes as spent by nullifier (epoch-aware)
   */
  markSpentByNullifier(nullifier: Buffer | Uint8Array, epoch?: bigint): void {
    if (!this.spendingKeys) return;

    const nullifierArray = new Uint8Array(nullifier);
    for (const note of this.notes) {
      if (note.spent) continue;

      // If epoch is specified, only check notes from that epoch
      if (epoch !== undefined && note.epoch !== epoch) continue;

      if (arraysEqual(note.nullifier, nullifierArray)) {
        note.spent = true;
        break;
      }
    }
  }

  /**
   * Create a new note with the given parameters (epoch-aware)
   * Note: epoch and leafIndex will be set when the note is confirmed on-chain
   */
  async createNote(
    value: bigint,
    owner: Uint8Array,
    token?: PublicKey,
  ): Promise<Note> {
    const randomness = randomBytes(32);
    console.log(
      "🔨 Creating note: value=",
      value.toString(),
      ", owner_len=",
      owner.length,
    );
    const commitment = await computeCommitment(value, owner, randomness);
    console.log("🔨 Commitment computed, length=", commitment.length);
    console.log(
      "🔨 Commitment (hex):",
      Buffer.from(commitment).toString("hex").slice(0, 64),
    );

    // Note: Nullifier will be recomputed with epoch and leafIndex once confirmed
    // For now, compute a placeholder with current epoch and index 0
    let nullifier: Uint8Array = new Uint8Array(32);
    if (this.spendingKeys) {
      nullifier = await computeNullifier(
        commitment,
        this.spendingKeys.nullifierKey,
        this.currentEpoch,
        0, // placeholder until confirmed
      );
    }

    return {
      value,
      token: token ?? PublicKey.default,
      owner,
      blinding: randomness,
      randomness,
      commitment,
      nullifier,
      spent: false,
      epoch: this.currentEpoch, // tentative, updated on confirmation
      leafIndex: undefined, // set on confirmation
    };
  }

  /**
   * Recompute nullifier for a note after confirmation (with real epoch/leafIndex)
   */
  async recomputeNullifier(note: Note): Promise<void> {
    if (!this.spendingKeys) return;
    if (note.epoch === undefined || note.leafIndex === undefined) return;

    note.nullifier = await computeNullifier(
      note.commitment,
      this.spendingKeys.nullifierKey,
      note.epoch,
      note.leafIndex,
    );
  }

  /**
   * Select notes for spending (greedy algorithm)
   * Prioritizes notes from older epochs to encourage renewal
   */
  selectNotes(amount: bigint, minNotes: number = 1): Note[] {
    if (minNotes < 1) {
      throw new Error("minNotes must be at least 1");
    }

    const seenCommitments = new Set<string>();
    const unspent = this.notes
      .filter((n) => !n.spent)
      .filter((n) => {
        const key = Buffer.from(n.commitment).toString("hex");
        if (seenCommitments.has(key)) return false;
        seenCommitments.add(key);
        return true;
      })
      // Sort by epoch ascending (older first), then by value descending
      .sort((a, b) => {
        const epochDiff = Number((a.epoch ?? 0n) - (b.epoch ?? 0n));
        if (epochDiff !== 0) return epochDiff;
        return Number(b.value - a.value);
      });

    const selected: Note[] = [];
    let sum = 0n;

    for (const note of unspent) {
      selected.push(note);
      sum += note.value;
      if (sum >= amount && selected.length >= minNotes) {
        return selected;
      }
    }

    if (sum < amount) {
      throw new Error(`Insufficient balance: have ${sum}, need ${amount}`);
    }

    throw new Error(
      `Insufficient note count: need at least ${minNotes}, have ${selected.length}`,
    );
  }

  /**
   * Select notes specifically for renewal (oldest epochs first)
   */
  selectNotesForRenewal(maxNotes: number = 10): Note[] {
    const expiringNotes = this.getExpiringNotes();
    return expiringNotes
      .sort((a, b) => Number((a.epoch ?? 0n) - (b.epoch ?? 0n)))
      .slice(0, maxNotes);
  }

  /**
   * Calculate total unspent balance
   */
  calculateBalance(): bigint {
    return this.notes
      .filter((n) => !n.spent)
      .reduce((sum, note) => sum + note.value, 0n);
  }

  /**
   * Calculate detailed balance breakdown by epoch status
   */
  calculateBalanceInfo(): BalanceInfo {
    const unspent = this.notes.filter((n) => !n.spent);
    const expiredNotes = this.getExpiredNotes();
    const expiringNotes = this.getExpiringNotes();

    // Spendable = current epoch + recent epochs (not expiring/expired)
    const expiredSet = new Set(
      expiredNotes.map((n) => Buffer.from(n.commitment).toString("hex")),
    );
    const expiringSet = new Set(
      expiringNotes.map((n) => Buffer.from(n.commitment).toString("hex")),
    );

    let spendable = 0n;
    let pending = this.calculatePendingBalance();
    let expiring = 0n;
    let expired = 0n;

    for (const note of unspent) {
      const key = Buffer.from(note.commitment).toString("hex");
      if (expiredSet.has(key)) {
        expired += note.value;
      } else if (expiringSet.has(key)) {
        expiring += note.value;
      } else {
        spendable += note.value;
      }
    }

    const total = spendable + pending + expiring;

    return {
      total,
      spendable,
      pending,
      expiring,
      expired,
      noteCount: unspent.length,
      expiringNoteCount: expiringNotes.length,
      expiredNoteCount: expiredNotes.length,
    };
  }

  // Static utility methods below
  /**
   * Create a new note (static version, epoch set on confirmation)
   */
  static async createNote(
    value: bigint,
    token: PublicKey,
    owner: Uint8Array,
    memo?: string,
    epoch?: bigint,
  ): Promise<Note> {
    const blinding = randomBytes(32);
    const randomness = randomBytes(32);

    const commitment = await computeCommitment(value, owner, randomness);

    return {
      value,
      token,
      owner,
      blinding,
      randomness,
      memo,
      commitment,
      nullifier: new Uint8Array(32), // Will be computed with nullifier key + epoch + leafIndex
      spent: false,
      epoch, // tentative
      leafIndex: undefined,
    };
  }

  /**
   * Compute commitment for a note
   */
  static async computeCommitment(note: Note): Promise<Uint8Array> {
    return await computeCommitment(note.value, note.owner, note.randomness);
  }

  /**
   * Compute nullifier for a note (epoch-aware, 4 inputs)
   */
  static async computeNullifier(
    note: Note,
    nullifierKey: Uint8Array,
  ): Promise<Uint8Array> {
    const commitment =
      note.commitment || (await NoteManager.computeCommitment(note));
    const epoch = note.epoch ?? 0n;
    const leafIndex = note.leafIndex ?? 0;
    return await computeNullifier(commitment, nullifierKey, epoch, leafIndex);
  }

  /**
   * Encrypt a note for on-chain storage
   */
  static encryptNote(note: Note, viewingKey: Uint8Array): Uint8Array {
    const serialized = serializeNote(
      note.value,
      note.token.toBytes(),
      note.owner,
      note.blinding,
      note.memo,
    );

    const { encrypted, nonce } = encryptNote(serialized, viewingKey);

    // Prepend nonce to encrypted data
    return new Uint8Array([...nonce, ...encrypted]);
  }

  /**
   * Attempt to decrypt a note (returns null if not owner)
   */
  static async decryptNote(
    encryptedData: Uint8Array,
    viewingKey: Uint8Array,
    token: PublicKey,
    leafIndex?: number,
    epoch?: bigint,
  ): Promise<Note | null> {
    if (encryptedData.length < 24) {
      return null;
    }

    // Extract nonce (first 24 bytes)
    const nonce = encryptedData.slice(0, 24);
    const encrypted = encryptedData.slice(24);

    const decrypted = decryptNote(encrypted, nonce, viewingKey);
    if (!decrypted) {
      return null;
    }

    try {
      const {
        value,
        token: tokenBytes,
        owner,
        blinding,
        memo,
      } = deserializeNote(decrypted);

      // Verify token matches
      const expectedToken = new PublicKey(tokenBytes);
      if (!expectedToken.equals(token)) {
        return null;
      }

      const randomness = blinding; // Reuse blinding as randomness for compatibility
      const commitment = await computeCommitment(value, owner, randomness);

      return {
        value,
        token,
        owner,
        blinding,
        randomness,
        memo,
        commitment,
        nullifier: new Uint8Array(32), // Will be computed with nullifier key + epoch + leafIndex
        leafIndex,
        epoch,
        spent: false,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if a note belongs to a specific owner
   */
  static ownsNote(note: Note, shieldedAddress: Uint8Array): boolean {
    if (note.owner.length !== shieldedAddress.length) {
      return false;
    }

    for (let i = 0; i < note.owner.length; i++) {
      if (note.owner[i] !== shieldedAddress[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Select notes for spending (greedy algorithm)
   */
  static selectNotes(
    notes: Note[],
    amount: bigint,
    minNotes: number = 1,
  ): Note[] {
    if (minNotes < 1) {
      throw new Error("minNotes must be at least 1");
    }

    const seenCommitments = new Set<string>();
    const unspent = notes
      .filter((n) => !n.spent)
      .filter((n) => {
        const key = Buffer.from(n.commitment).toString("hex");
        if (seenCommitments.has(key)) return false;
        seenCommitments.add(key);
        return true;
      })
      .sort((a, b) => Number(b.value - a.value));

    const selected: Note[] = [];
    let sum = 0n;

    for (const note of unspent) {
      selected.push(note);
      sum += note.value;
      if (sum >= amount && selected.length >= minNotes) {
        return selected;
      }
    }

    if (sum < amount) {
      throw new Error(`Insufficient balance: have ${sum}, need ${amount}`);
    }

    throw new Error(
      `Insufficient note count: need at least ${minNotes}, have ${selected.length}`,
    );
  }

  /**
   * Calculate total balance from notes
   */
  static calculateBalance(notes: Note[]): bigint {
    return notes
      .filter((n) => !n.spent)
      .reduce((sum, note) => sum + note.value, 0n);
  }

  /**
   * Mark notes as spent based on nullifier set (epoch-aware)
   */
  static async markSpent(
    notes: Note[],
    spentNullifiers: Array<{ nullifier: Uint8Array; epoch?: bigint }>,
    nullifierKey: Uint8Array,
  ): Promise<void> {
    for (const note of notes) {
      if (note.spent) continue;

      const nullifier = await NoteManager.computeNullifier(note, nullifierKey);

      for (const spent of spentNullifiers) {
        // Match nullifier and optionally epoch
        if (arraysEqual(nullifier, spent.nullifier)) {
          if (spent.epoch === undefined || spent.epoch === note.epoch) {
            note.spent = true;
            break;
          }
        }
      }
    }
  }
}

/**
 * Compare two byte arrays for equality
 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
