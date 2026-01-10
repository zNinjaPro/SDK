/**
 * Note (UTXO) management for shielded pool
 */

import { PublicKey } from "@solana/web3.js";
import { Note, SpendingKeys } from "./types";
import {
  computeCommitment,
  computeNullifier,
  randomBytes,
  serializeNote,
  deserializeNote,
  encryptNote,
  decryptNote,
} from "./crypto";

/**
 * Manages note collection, selection, and balance tracking
 */
export class NoteManager {
  private notes: Note[] = [];
  private pendingNotes: Note[] = [];
  private spendingKeys?: SpendingKeys;

  constructor(spendingKeys?: SpendingKeys) {
    this.spendingKeys = spendingKeys;
  }

  /**
   * Add a confirmed note to the collection
   */
  addNote(note: Note): void {
    const existing = this.notes.find((n) =>
      arraysEqual(n.commitment, note.commitment)
    );
    if (existing) {
      if (existing.leafIndex === undefined && note.leafIndex !== undefined) {
        existing.leafIndex = note.leafIndex;
      }
      return;
    }

    this.notes.push(note);
    // Remove from pending if it exists
    this.pendingNotes = this.pendingNotes.filter(
      (n) => !arraysEqual(n.commitment, note.commitment)
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
   * Mark notes as spent by nullifier
   */
  markSpentByNullifier(nullifier: Buffer | Uint8Array): void {
    if (!this.spendingKeys) return;

    const nullifierArray = new Uint8Array(nullifier);
    for (const note of this.notes) {
      if (note.spent) continue;
      if (arraysEqual(note.nullifier, nullifierArray)) {
        note.spent = true;
        break;
      }
    }
  }

  /**
   * Create a new note with the given parameters
   */
  async createNote(value: bigint, owner: Uint8Array): Promise<Note> {
    const randomness = randomBytes(32);
    console.log(
      "🔨 Creating note: value=",
      value.toString(),
      ", owner_len=",
      owner.length
    );
    const commitment = await computeCommitment(value, owner, randomness);
    console.log("🔨 Commitment computed, length=", commitment.length);
    console.log(
      "🔨 Commitment (hex):",
      Buffer.from(commitment).toString("hex").slice(0, 64)
    );

    let nullifier: any = new Uint8Array(32);
    if (this.spendingKeys) {
      nullifier = await computeNullifier(
        commitment,
        this.spendingKeys.nullifierKey
      );
    }

    return {
      value,
      token: PublicKey.default, // Will be set when deposited
      owner,
      blinding: randomness,
      randomness,
      commitment,
      nullifier,
      spent: false,
    };
  }

  /**
   * Select notes for spending (greedy algorithm)
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
      `Insufficient note count: need at least ${minNotes}, have ${selected.length}`
    );
  }

  /**
   * Calculate total unspent balance
   */
  calculateBalance(): bigint {
    return this.notes
      .filter((n) => !n.spent)
      .reduce((sum, note) => sum + note.value, 0n);
  }

  // Static utility methods below
  /**
   * Create a new note
   */
  static async createNote(
    value: bigint,
    token: PublicKey,
    owner: Uint8Array,
    memo?: string
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
      nullifier: new Uint8Array(32) as any, // Will be computed with nullifier key
      spent: false,
    };
  }

  /**
   * Compute commitment for a note
   */
  static async computeCommitment(note: Note): Promise<Uint8Array> {
    return await computeCommitment(note.value, note.owner, note.randomness);
  }

  /**
   * Compute nullifier for a note
   */
  static async computeNullifier(
    note: Note,
    nullifierKey: Uint8Array
  ): Promise<Uint8Array> {
    const commitment =
      note.commitment || (await NoteManager.computeCommitment(note));
    return await computeNullifier(commitment, nullifierKey);
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
      note.memo
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
    leafIndex?: number
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
        nullifier: new Uint8Array(32), // Will be computed with nullifier key
        leafIndex,
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
    minNotes: number = 1
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
      `Insufficient note count: need at least ${minNotes}, have ${selected.length}`
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
   * Mark notes as spent based on nullifier set
   */
  static async markSpent(
    notes: Note[],
    spentNullifiers: Uint8Array[],
    nullifierKey: Uint8Array
  ): Promise<void> {
    for (const note of notes) {
      if (note.spent) continue;

      const nullifier = await NoteManager.computeNullifier(note, nullifierKey);

      for (const spentNullifier of spentNullifiers) {
        if (arraysEqual(nullifier, spentNullifier)) {
          note.spent = true;
          break;
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
