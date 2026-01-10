#!/usr/bin/env node
/**
 * Simple test to verify SDK builds and exports correctly
 */

const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

async function main() {
  console.log("Testing SDK build...");

  // Test imports
  const SDK = require("./dist");
  console.log("✓ SDK imported");

  // Check exports
  const exports = [
    "ShieldedPoolClient",
    "KeyManager",
    "NoteManager",
    "MerkleTreeSync",
  ];

  for (const name of exports) {
    if (!SDK[name]) {
      throw new Error(`Missing export: ${name}`);
    }
    console.log(`✓ ${name} exported`);
  }

  // Test crypto functions
  const crypto = require("./dist/crypto");
  console.log("✓ Crypto module imported");

  if (!crypto.computeCommitment) {
    throw new Error("Missing computeCommitment function");
  }
  console.log("✓ computeCommitment available");

  if (!crypto.computeNullifier) {
    throw new Error("Missing computeNullifier function");
  }
  console.log("✓ computeNullifier available");

  // Test async crypto
  const value = 1000000n;
  const owner = new Uint8Array(32).fill(1);
  const randomness = new Uint8Array(32).fill(2);

  const commitment = await crypto.computeCommitment(value, owner, randomness);
  if (commitment.length !== 32) {
    throw new Error(`Invalid commitment length: ${commitment.length}`);
  }
  console.log("✓ computeCommitment produces 32-byte output");

  const nullifierKey = new Uint8Array(32).fill(3);
  const nullifier = await crypto.computeNullifier(commitment, nullifierKey);
  if (nullifier.length !== 32) {
    throw new Error(`Invalid nullifier length: ${nullifier.length}`);
  }
  console.log("✓ computeNullifier produces 32-byte output");

  console.log("\n✓ All SDK build tests passed!");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ Test failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
