#!/usr/bin/env ts-node
/**
 * Test SDK's own verifyProof to see if it matches
 */

import { MerkleTree } from "./src/merkle";
import { poseidonHash } from "./src/crypto";

async function main() {
  console.log("🔍 Testing SDK's verifyProof\n");

  // Initialize Poseidon first
  await poseidonHash([new Uint8Array(32)]);
  console.log("✅ Poseidon initialized\n");

  const tree = new MerkleTree();

  // Create a simple commitment (32 bytes)
  const commitment = new Uint8Array(32);
  commitment[0] = 1;
  commitment[1] = 2;
  commitment[2] = 3;

  console.log("Inserting leaf...");
  const { leafIndex, root } = tree.insert(commitment);
  console.log("  Leaf index:", leafIndex);
  console.log(
    "  Root (hex):",
    Buffer.from(root).toString("hex").slice(0, 40) + "..."
  );

  console.log("\nGetting proof...");
  const proof = tree.getProof(leafIndex);
  console.log(
    "  Proof root (hex):",
    Buffer.from(proof.root).toString("hex").slice(0, 40) + "..."
  );

  console.log("\nRunning SDK's verifyProof...");
  const isValid = MerkleTree.verifyProof(proof);
  console.log("  Result:", isValid ? "✅ VALID" : "❌ INVALID");

  if (!isValid) {
    console.log("\n❌ SDK's own verifyProof fails - this is the bug!");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
