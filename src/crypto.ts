/**
 * Cryptographic utilities for shielded pool operations
 */

import { createHash, randomBytes as cryptoRandomBytes } from "crypto";
import { poseidonHashBytes } from "./poseidon/solanaPoseidon";
import * as nacl from "tweetnacl";

/**
 * SHA-256 hash function
 */
export function sha256(data: Buffer | Uint8Array): Uint8Array {
  const hash = createHash("sha256");
  hash.update(data);
  return new Uint8Array(hash.digest());
}

/**
 * Generate random bytes
 */
export function randomBytes(length: number): Uint8Array {
  return cryptoRandomBytes(length);
}

/**
 * Compute Poseidon hash (placeholder - will use circomlibjs)
 * For now, use SHA-256 as a temporary hash
 */
export async function poseidonHash(inputs: Uint8Array[]): Promise<Uint8Array> {
  return poseidonHashBytes(inputs);
}

/**
 * Ensure Poseidon instance is initialized (idempotent)
 */
export async function ensurePoseidon(): Promise<void> {
  return;
}

/**
 * Synchronous Poseidon hash (assumes Poseidon is already loaded)
 * Used for merkle tree operations where async is not practical
 */
export function poseidonHashSync(inputs: Uint8Array[]): Uint8Array {
  return poseidonHashBytes(inputs);
}

/**
 * Compute commitment: Hash(value || owner || randomness)
 */
export async function computeCommitment(
  value: bigint,
  owner: Uint8Array,
  randomness: Uint8Array
): Promise<Uint8Array> {
  // Encode value as 32-byte big-endian
  const valueBuf = Buffer.alloc(32);
  const valueHex = value.toString(16).padStart(64, "0");
  valueBuf.write(valueHex, "hex");

  return await poseidonHash([valueBuf, owner, randomness]);
}

/**
 * Compute nullifier: Hash(commitment || nullifierKey)
 */
export async function computeNullifier(
  commitment: Uint8Array,
  nullifierKey: Uint8Array
): Promise<Uint8Array> {
  return await poseidonHash([commitment, nullifierKey]);
}

/**
 * Encrypt note data using ChaCha20-Poly1305
 */
export function encryptNote(
  noteData: Uint8Array,
  viewingKey: Uint8Array
): { encrypted: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(noteData, nonce, viewingKey);

  return {
    encrypted: new Uint8Array(encrypted),
    nonce,
  };
}

/**
 * Decrypt note data
 */
export function decryptNote(
  encryptedData: Uint8Array,
  nonce: Uint8Array,
  viewingKey: Uint8Array
): Uint8Array | null {
  const decrypted = nacl.secretbox.open(encryptedData, nonce, viewingKey);

  if (!decrypted) {
    return null;
  }

  return new Uint8Array(decrypted);
}

/**
 * Serialize note for encryption
 */
export function serializeNote(
  value: bigint,
  token: Uint8Array,
  owner: Uint8Array,
  blinding: Uint8Array,
  memo?: string
): Uint8Array {
  // Format: value (32) || token (32) || owner (32) || blinding (32) || memo_len (2) || memo
  const valueBuf = Buffer.alloc(32);
  const valueHex = value.toString(16).padStart(64, "0");
  valueBuf.write(valueHex, "hex");

  const memoBytes = memo ? Buffer.from(memo, "utf8") : Buffer.alloc(0);
  const memoLen = Buffer.alloc(2);
  memoLen.writeUInt16LE(memoBytes.length);

  return new Uint8Array(
    Buffer.concat([valueBuf, token, owner, blinding, memoLen, memoBytes])
  );
}

/**
 * Deserialize note from bytes
 */
export function deserializeNote(data: Uint8Array): {
  value: bigint;
  token: Uint8Array;
  owner: Uint8Array;
  blinding: Uint8Array;
  memo?: string;
} {
  if (data.length < 130) {
    throw new Error("Invalid note data length");
  }

  const buf = Buffer.from(data);
  const value = BigInt("0x" + buf.subarray(0, 32).toString("hex"));
  const token = new Uint8Array(buf.subarray(32, 64));
  const owner = new Uint8Array(buf.subarray(64, 96));
  const blinding = new Uint8Array(buf.subarray(96, 128));

  const memoLen = buf.readUInt16LE(128);
  const memo =
    memoLen > 0 ? buf.subarray(130, 130 + memoLen).toString("utf8") : undefined;

  return { value, token, owner, blinding, memo };
}

/**
 * Convert bigint to 32-byte big-endian
 */
export function bigintToBytes32(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/**
 * Convert 32-byte big-endian to bigint
 */
export function bytes32ToBigint(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error("Input must be 32 bytes");
  }
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

/**
 * Check if value is in BN254 field
 */
export function isInField(value: bigint): boolean {
  const BN254_FIELD_SIZE = BigInt(
    "21888242871839275222246405745257275088548364400416034343698204186575808495617"
  );
  return value >= 0n && value < BN254_FIELD_SIZE;
}
