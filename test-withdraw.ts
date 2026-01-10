#!/usr/bin/env ts-node
/**
 * Quick test to verify withdraw circuit integration
 */

import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import { ShieldedPoolClient } from "./src/client";
import { PROVER_ARTIFACTS } from "./src/config";
import * as fs from "fs";
import idl from "./src/idl.json";

async function main() {
  console.log("🔍 Verifying withdraw circuit artifacts...\n");

  // Check if artifacts exist
  console.log("Withdraw artifacts:");
  console.log("  WASM:", PROVER_ARTIFACTS.withdraw.wasmPath);
  console.log("  Exists:", fs.existsSync(PROVER_ARTIFACTS.withdraw.wasmPath));
  console.log("  ZKEY:", PROVER_ARTIFACTS.withdraw.zkeyPath);
  console.log("  Exists:", fs.existsSync(PROVER_ARTIFACTS.withdraw.zkeyPath));

  console.log("\nTransfer artifacts:");
  console.log("  WASM:", PROVER_ARTIFACTS.transfer.wasmPath);
  console.log("  Exists:", fs.existsSync(PROVER_ARTIFACTS.transfer.wasmPath));
  console.log("  ZKEY:", PROVER_ARTIFACTS.transfer.zkeyPath);
  console.log("  Exists:", fs.existsSync(PROVER_ARTIFACTS.transfer.zkeyPath));

  // Try to initialize client
  console.log("\n🚀 Initializing client...");
  const connection = new Connection("http://localhost:8899", "confirmed");
  const payer = Keypair.generate();

  try {
    const client = await ShieldedPoolClient.create({
      connection,
      payer,
      programId: Keypair.generate().publicKey,
      poolConfig: Keypair.generate().publicKey,
      idl: idl as any,
    });
    console.log("✅ Client initialized successfully");
    console.log("   Shielded address:", client.getShieldedAddress());
  } catch (error) {
    console.error("❌ Client initialization failed:", error);
    process.exit(1);
  }

  console.log("\n✨ All checks passed!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
