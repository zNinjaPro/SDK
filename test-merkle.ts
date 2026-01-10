#!/usr/bin/env ts-node
/**
 * Test merkle proof verification to debug circuit failure
 */

import { MerkleTree } from "./src/merkle";
import { poseidonHash } from "./src/crypto";

async function main() {
  console.log("🌲 Testing Merkle Proof Generation\n");

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
  console.log("  Siblings count:", proof.siblings.length);
  console.log(
    "  First sibling (hex):",
    Buffer.from(proof.siblings[0]).toString("hex").slice(0, 40) + "..."
  );
  console.log(
    "  Last sibling (hex):",
    Buffer.from(proof.siblings[proof.siblings.length - 1])
      .toString("hex")
      .slice(0, 40) + "..."
  );

  console.log("\nManual verification:");
  let currentHash: Uint8Array = commitment;
  let index = leafIndex;

  for (let i = 0; i < proof.siblings.length; i++) {
    const sibling = proof.siblings[i];
    const isLeft = index % 2 === 0;

    console.log(`  Level ${i}: index=${index}, isLeft=${isLeft}`);

    if (isLeft) {
      currentHash = new Uint8Array(await poseidonHash([currentHash, sibling]));
      console.log(`    Hash(current, sibling)`);
    } else {
      currentHash = new Uint8Array(await poseidonHash([sibling, currentHash]));
      console.log(`    Hash(sibling, current)`);
    }

    console.log(
      `    Result: ${Buffer.from(currentHash).toString("hex").slice(0, 40)}...`
    );
    index = Math.floor(index / 2);
  }

  console.log(
    "\n  Final hash:",
    Buffer.from(currentHash).toString("hex").slice(0, 40) + "..."
  );
  console.log(
    "  Expected root:",
    Buffer.from(proof.root).toString("hex").slice(0, 40) + "..."
  );
  console.log(
    "  Match:",
    Buffer.from(currentHash).toString("hex") ===
      Buffer.from(proof.root).toString("hex")
      ? "✅"
      : "❌"
  );
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
