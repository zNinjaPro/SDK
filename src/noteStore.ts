/**
 * Note persistence layer for the shielded pool SDK.
 *
 * Provides encrypted-at-rest storage of UTXO notes so wallet state
 * survives process restarts without requiring a full chain rescan.
 *
 * File format:  nonce(24 bytes) || NaCl secretbox ciphertext
 * Encryption:   XSalsa20-Poly1305 via tweetnacl, keyed by the 32-byte viewing key
 */

import * as fs from "fs";
import * as path from "path";
import * as nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { Note } from "./types";
import { randomBytes } from "./crypto";
import { getLogger } from "./logger";

// ─── Serialized types (JSON-safe) ───────────────────────────────

export interface SerializedNote {
  value: string; // bigint as decimal string
  token: string; // PublicKey as base58
  owner: string; // Uint8Array as hex
  blinding: string; // hex
  commitment: string; // hex
  nullifier: string; // hex
  randomness: string; // hex
  leafIndex?: number;
  epoch?: string; // bigint as decimal string
  spent?: boolean;
  expired?: boolean;
  memo?: string;
}

export interface NoteStoreData {
  version: number; // Schema version for future migrations
  updatedAt: string; // ISO timestamp
  currentEpoch: string; // bigint as decimal string
  notes: SerializedNote[];
  pendingNotes: SerializedNote[];
}

// ─── NoteStore interface ────────────────────────────────────────

export interface NoteStore {
  /** Load all persisted state. Returns null if no data exists or on any error. */
  load(): Promise<NoteStoreData | null>;

  /** Persist full note state (confirmed + pending). */
  save(data: NoteStoreData): Promise<void>;

  /** Delete all persisted data. */
  clear(): Promise<void>;
}

// ─── Conversion helpers (exported for testing) ──────────────────

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString("hex");
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/**
 * Serialize a Note into a JSON-safe representation.
 */
export function serializeNoteForStorage(note: Note): SerializedNote {
  const s: SerializedNote = {
    value: note.value.toString(),
    token: note.token.toBase58(),
    owner: toHex(note.owner),
    blinding: toHex(note.blinding),
    commitment: toHex(note.commitment),
    nullifier: toHex(note.nullifier),
    randomness: toHex(note.randomness),
  };
  if (note.leafIndex !== undefined) s.leafIndex = note.leafIndex;
  if (note.epoch !== undefined) s.epoch = note.epoch.toString();
  if (note.spent !== undefined) s.spent = note.spent;
  if (note.expired !== undefined) s.expired = note.expired;
  if (note.memo !== undefined) s.memo = note.memo;
  return s;
}

/**
 * Deserialize a JSON-safe representation back into a Note.
 */
export function deserializeNoteFromStorage(s: SerializedNote): Note {
  const note: Note = {
    value: BigInt(s.value),
    token: new PublicKey(s.token),
    owner: fromHex(s.owner),
    blinding: fromHex(s.blinding),
    commitment: fromHex(s.commitment),
    nullifier: fromHex(s.nullifier),
    randomness: fromHex(s.randomness),
  };
  if (s.leafIndex !== undefined) note.leafIndex = s.leafIndex;
  if (s.epoch !== undefined) note.epoch = BigInt(s.epoch);
  if (s.spent !== undefined) note.spent = s.spent;
  if (s.expired !== undefined) note.expired = s.expired;
  if (s.memo !== undefined) note.memo = s.memo;
  return note;
}

/**
 * Build a NoteStoreData snapshot from live NoteManager state.
 */
export function serializeStoreData(
  notes: Note[],
  pendingNotes: Note[],
  currentEpoch: bigint,
): NoteStoreData {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    currentEpoch: currentEpoch.toString(),
    notes: notes.map(serializeNoteForStorage),
    pendingNotes: pendingNotes.map(serializeNoteForStorage),
  };
}

/**
 * Reconstruct live state from a NoteStoreData snapshot.
 */
export function deserializeStoreData(data: NoteStoreData): {
  notes: Note[];
  pendingNotes: Note[];
  currentEpoch: bigint;
} {
  return {
    notes: data.notes.map(deserializeNoteFromStorage),
    pendingNotes: data.pendingNotes.map(deserializeNoteFromStorage),
    currentEpoch: BigInt(data.currentEpoch),
  };
}

// ─── EncryptedFileStore ─────────────────────────────────────────

/** Maximum time (ms) to wait for a stale lock before forcing acquisition. */
const LOCK_STALE_MS = 5_000;
/** Interval (ms) between lock acquisition retries. */
const LOCK_RETRY_MS = 50;
/** Maximum total wait time (ms) before giving up on lock acquisition. */
const LOCK_TIMEOUT_MS = 10_000;

/**
 * Persists notes to an encrypted file on disk.
 *
 * - Encryption: NaCl secretbox (XSalsa20-Poly1305) with the 32-byte viewing key
 * - File format: nonce(24 bytes) || ciphertext(variable)
 * - Atomic writes via temp file + rename to prevent corruption
 * - Concurrent-access safe: advisory lock via `.lock` directory (mkdir is atomic)
 * - File permissions: 0o600 (owner read/write only)
 */
export class EncryptedFileStore implements NoteStore {
  private filePath: string;
  private encryptionKey: Uint8Array;
  private lockPath: string;

  constructor(filePath: string, encryptionKey: Uint8Array) {
    if (encryptionKey.length !== 32) {
      throw new Error("Encryption key must be 32 bytes");
    }
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.lockPath = filePath + ".lock";
  }

  // ── Advisory locking via atomic mkdir ──────────────────────────

  /**
   * Acquire an advisory lock. mkdir is atomic on all major OSes.
   * If a lock is stale (older than LOCK_STALE_MS), it is force-removed.
   */
  private async acquireLock(): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(this.lockPath); // atomic — fails if directory already exists
        // Write PID for stale-lock detection
        try {
          fs.writeFileSync(
            path.join(this.lockPath, "pid"),
            String(process.pid),
            { mode: 0o600 },
          );
        } catch {
          // Non-critical — lock is still held
        }
        return;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        // Lock exists — check if stale
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            // Stale lock — force remove and retry immediately
            this.forceReleaseLock();
            continue;
          }
        } catch {
          // stat failed — lock may have been released between our check
          continue;
        }
        // Wait and retry
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
    throw new Error(
      `EncryptedFileStore: timed out acquiring lock on ${this.lockPath} after ${LOCK_TIMEOUT_MS}ms`,
    );
  }

  /** Release the advisory lock. */
  private releaseLock(): void {
    try {
      // Remove PID file first, then directory
      const pidPath = path.join(this.lockPath, "pid");
      if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
      fs.rmdirSync(this.lockPath);
    } catch {
      // Ignore — lock may have already been released or force-removed
    }
  }

  /** Force-remove a stale lock. */
  private forceReleaseLock(): void {
    try {
      getLogger().warn("EncryptedFileStore: removing stale lock", {
        lockPath: this.lockPath,
      });
      const pidPath = path.join(this.lockPath, "pid");
      if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
      fs.rmdirSync(this.lockPath);
    } catch {
      // Ignore
    }
  }

  /** Run a callback while holding the advisory lock. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await fn();
    } finally {
      this.releaseLock();
    }
  }

  async load(): Promise<NoteStoreData | null> {
    return this.withLock(async () => {
      try {
        if (!fs.existsSync(this.filePath)) return null;

        const raw = fs.readFileSync(this.filePath);
        if (raw.length < 24) return null; // Too short for nonce

        const nonce = new Uint8Array(raw.subarray(0, 24));
        const ciphertext = new Uint8Array(raw.subarray(24));

        const plaintext = nacl.secretbox.open(
          ciphertext,
          nonce,
          this.encryptionKey,
        );
        if (!plaintext) return null; // Wrong key or corrupt

        const json = new TextDecoder().decode(plaintext);
        const data: NoteStoreData = JSON.parse(json);

        // Validate schema version
        if (data.version !== 1) return null;

        getLogger().debug("EncryptedFileStore: loaded", {
          notes: data.notes.length,
          pending: data.pendingNotes.length,
        });
        return data;
      } catch {
        // Corrupt file, parse error, etc. — treat as missing
        return null;
      }
    });
  }

  async save(data: NoteStoreData): Promise<void> {
    return this.withLock(async () => {
      // Ensure parent directory exists
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });

      const json = JSON.stringify(data);
      const plaintext = new TextEncoder().encode(json);

      const nonce = randomBytes(24);
      const ciphertext = nacl.secretbox(plaintext, nonce, this.encryptionKey);

      // Build nonce || ciphertext
      const output = new Uint8Array(nonce.length + ciphertext.length);
      output.set(nonce, 0);
      output.set(ciphertext, nonce.length);

      // Atomic write: write to temp with restrictive permissions, then rename
      const tmpPath = this.filePath + ".tmp";
      fs.writeFileSync(tmpPath, output, { mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
      getLogger().debug("EncryptedFileStore: saved", { bytes: output.length });
    });
  }

  async clear(): Promise<void> {
    return this.withLock(async () => {
      try {
        if (fs.existsSync(this.filePath)) {
          fs.unlinkSync(this.filePath);
        }
        // Also clean up any leftover temp file
        const tmpPath = this.filePath + ".tmp";
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore ENOENT
      }
    });
  }
}

// ─── InMemoryStore (for testing) ────────────────────────────────

/**
 * In-memory NoteStore implementation for unit tests.
 * No disk I/O — stores data as a deep clone in memory.
 */
export class InMemoryStore implements NoteStore {
  private data: NoteStoreData | null = null;

  async load(): Promise<NoteStoreData | null> {
    if (!this.data) return null;
    // Deep clone to prevent external mutation
    return JSON.parse(JSON.stringify(this.data));
  }

  async save(data: NoteStoreData): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data));
  }

  async clear(): Promise<void> {
    this.data = null;
  }
}
