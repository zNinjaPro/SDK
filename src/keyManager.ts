/**
 * Key management for shielded pool operations
 * Derives spending, viewing, and nullifier keys from a master seed
 */

import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import * as nacl from 'tweetnacl';
import { SpendingKeys } from './types';
import { sha256 } from './crypto';

/** Derivation path for shielded pool keys */
const DERIVATION_PATH = "m/44'/501'/0'/0'";

/**
 * Manages cryptographic keys for shielded operations
 */
export class KeyManager {
  private keys: SpendingKeys;

  private constructor(keys: SpendingKeys) {
    this.keys = keys;
  }

  /**
   * Generate new random keys
   */
  static generate(): KeyManager {
    const mnemonic = bip39.generateMnemonic(128); // 12 words
    return KeyManager.fromMnemonic(mnemonic);
  }

  /**
   * Restore keys from BIP39 mnemonic
   */
  static fromMnemonic(mnemonic: string): KeyManager {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic, ''); // No passphrase
    const derivedSeed = derivePath(DERIVATION_PATH, seed.toString('hex')).key;

    return KeyManager.fromSeed(derivedSeed);
  }

  /**
   * Restore keys from raw seed (32 bytes)
   */
  static fromSeed(seed: Uint8Array): KeyManager {
    if (seed.length !== 32) {
      throw new Error('Seed must be 32 bytes');
    }

    // Derive specialized keys using domain separation
    const spendingKey = sha256(Buffer.concat([Buffer.from('spending'), Buffer.from(seed)]));
    const viewingKey = sha256(Buffer.concat([Buffer.from('viewing'), Buffer.from(seed)]));
    const nullifierKey = sha256(Buffer.concat([Buffer.from('nullifier'), Buffer.from(seed)]));

    // Derive shielded address from spending key
    const shieldedAddress = sha256(Buffer.concat([Buffer.from('address'), Buffer.from(spendingKey)]));

    const keys: SpendingKeys = {
      seed,
      spendingKey,
      viewingKey,
      nullifierKey,
      shieldedAddress,
    };

    return new KeyManager(keys);
  }

  /**
   * Get spending key (signs transactions)
   */
  getSpendingKey(): Uint8Array {
    return this.keys.spendingKey;
  }

  /**
   * Get viewing key (decrypts notes)
   */
  getViewingKey(): Uint8Array {
    return this.keys.viewingKey;
  }

  /**
   * Get nullifier key (generates nullifiers)
   */
  getNullifierKey(): Uint8Array {
    return this.keys.nullifierKey;
  }

  /**
   * Get shielded address (public identifier)
   */
  getShieldedAddress(): Uint8Array {
    return this.keys.shieldedAddress;
  }

  /**
   * Get shielded address as base58 string
   */
  getShieldedAddressString(): string {
    const bs58 = require('bs58');
    return bs58.encode(this.keys.shieldedAddress);
  }

  /**
   * Export all keys (WARNING: sensitive data)
   */
  exportKeys(): SpendingKeys {
    return { ...this.keys };
  }

  /**
   * Create a Solana keypair for transaction signing
   * This is separate from shielded operations
   */
  deriveTransactionKeypair(): Keypair {
    return Keypair.fromSeed(this.keys.seed);
  }

  /**
   * Validate a shielded address string
   */
  static validateShieldedAddress(address: string): boolean {
    const bs58 = require('bs58');
    try {
      const decoded = bs58.decode(address);
      return decoded.length === 32;
    } catch {
      return false;
    }
  }

  /**
   * Decode a shielded address from base58
   */
  static decodeShieldedAddress(address: string): Uint8Array {
    const bs58 = require('bs58');
    const decoded = bs58.decode(address);
    if (decoded.length !== 32) {
      throw new Error('Invalid shielded address');
    }
    return decoded;
  }
}
