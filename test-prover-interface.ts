/**
 * Demo: Proof generation with updated SDK prover
 *
 * This demonstrates the updated prover interface matching the actual
 * withdraw.circom circuit structure.
 */

import { proveWithdraw, WithdrawInputs } from "./src/prover";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

async function demo() {
  console.log("🔍 Testing updated prover interface...\n");

  // Load circuit artifacts
  const circuitsPath = path.join(__dirname, "circuits");
  const artifacts = {
    wasmPath: path.join(circuitsPath, "withdraw.wasm"),
    zkeyPath: path.join(circuitsPath, "withdraw_final.zkey"),
  };

  // Check artifacts exist
  if (!fs.existsSync(artifacts.wasmPath)) {
    console.log("❌ Circuit artifacts not found");
    console.log("   Run: cd ../circuits && ./copy-to-sdk.sh");
    return;
  }

  // Create test inputs matching withdraw circuit
  const inputs: WithdrawInputs = {
    note: {
      value: 1000000n,
      token: PublicKey.default,
      owner: new Uint8Array(32).fill(1),
      randomness: new Uint8Array(32).fill(2),
      commitment: new Uint8Array(32).fill(3),
      nullifier: new Uint8Array(32),
      memo: "",
    },
    spendingKeys: {
      spendingKey: new Uint8Array(32).fill(4),
      nullifierKey: new Uint8Array(32).fill(5),
      viewingKey: new Uint8Array(32),
    },
    merkleProof: {
      root: new Uint8Array(32).fill(6),
      leafIndex: 0,
      siblings: Array(20).fill(new Uint8Array(32).fill(7)),
    },
    merkleRoot: new Uint8Array(32).fill(6),
    recipient: PublicKey.default,
    amount: 1000000n,
  };

  console.log("📝 Generating proof with test inputs...");
  console.log(`   Note value: ${inputs.note.value}`);
  console.log(`   Amount: ${inputs.amount}`);
  console.log(`   Merkle depth: ${inputs.merkleProof.siblings.length}`);

  const startTime = Date.now();

  try {
    const { proof, publicInputs } = await proveWithdraw(artifacts, inputs);

    const duration = Date.now() - startTime;
    console.log(`\n✅ Proof generated in ${duration}ms`);
    console.log(`\n📦 Proof structure:`);
    console.log(`   pi_a: ${proof.a.length} bytes`);
    console.log(`   pi_b: ${proof.b.length} bytes`);
    console.log(`   pi_c: ${proof.c.length} bytes`);
    console.log(
      `   Total: ${proof.a.length + proof.b.length + proof.c.length} bytes`
    );

    console.log(`\n🔢 Public inputs: ${publicInputs.length} elements`);
    publicInputs.forEach((input, i) => {
      const hex = Buffer.from(input).toString("hex");
      console.log(`   [${i}]: ${hex.slice(0, 16)}... (${input.length} bytes)`);
    });

    console.log("\n✅ Prover interface working correctly!");
    console.log("   Ready for integration with transaction builder");
  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

demo().catch(console.error);
