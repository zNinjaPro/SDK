#!/usr/bin/env node
/**
 * Test real proof generation with circuits
 */

const { generateProof, verifyProof } = require("./prover-simple");
const path = require("path");
const fs = require("fs");

const CIRCUITS_DIR = path.join(__dirname, "circuits");
const PROVER_ARTIFACTS = {
  withdraw: {
    wasmPath: path.join(CIRCUITS_DIR, "withdraw.wasm"),
    zkeyPath: path.join(CIRCUITS_DIR, "withdraw_final.zkey"),
    vkeyPath: path.join(CIRCUITS_DIR, "withdraw_verification_key.json"),
  },
  transfer: {
    wasmPath: path.join(CIRCUITS_DIR, "transfer.wasm"),
    zkeyPath: path.join(CIRCUITS_DIR, "transfer_final.zkey"),
    vkeyPath: path.join(CIRCUITS_DIR, "transfer_verification_key.json"),
  },
};

async function testProver() {
  console.log("Testing prover with real circuits...\n");

  // Check if artifacts exist
  console.log("Checking circuit artifacts:");
  console.log("  Withdraw WASM:", PROVER_ARTIFACTS.withdraw.wasmPath);
  console.log("  Withdraw ZKEY:", PROVER_ARTIFACTS.withdraw.zkeyPath);
  console.log("  Transfer WASM:", PROVER_ARTIFACTS.transfer.wasmPath);
  console.log("  Transfer ZKEY:", PROVER_ARTIFACTS.transfer.zkeyPath);
  console.log();

  const withdrawWasmExists = fs.existsSync(PROVER_ARTIFACTS.withdraw.wasmPath);
  const withdrawZkeyExists = fs.existsSync(PROVER_ARTIFACTS.withdraw.zkeyPath);
  const transferWasmExists = fs.existsSync(PROVER_ARTIFACTS.transfer.wasmPath);
  const transferZkeyExists = fs.existsSync(PROVER_ARTIFACTS.transfer.zkeyPath);

  console.log("Artifact status:");
  console.log("  ✓ Withdraw WASM:", withdrawWasmExists ? "Found" : "Missing");
  console.log("  ✓ Withdraw ZKEY:", withdrawZkeyExists ? "Found" : "Missing");
  console.log("  ✓ Transfer WASM:", transferWasmExists ? "Found" : "Missing");
  console.log("  ✓ Transfer ZKEY:", transferZkeyExists ? "Found" : "Missing");
  console.log();

  if (!withdrawWasmExists || !withdrawZkeyExists) {
    console.log(
      "⚠ Withdraw artifacts missing. Run: cd circuits && ./copy-to-sdk.sh"
    );
    return;
  }

  // Test withdraw proof
  console.log("Generating withdraw proof...");
  const withdrawInputs = JSON.parse(
    fs.readFileSync(path.join(__dirname, "test-withdraw-input.json"), "utf-8")
  );

  try {
    const startTime = Date.now();
    const { proof, publicSignals } = await generateProof(
      PROVER_ARTIFACTS.withdraw.wasmPath,
      PROVER_ARTIFACTS.withdraw.zkeyPath,
      withdrawInputs
    );
    const duration = Date.now() - startTime;

    console.log("✓ Withdraw proof generated in", duration, "ms");
    console.log("  Proof pi_a:", proof.pi_a[0].substring(0, 20) + "...");
    console.log("  Public signals:", publicSignals.length, "values");

    // Verify the proof
    const valid = await verifyProof(
      PROVER_ARTIFACTS.withdraw.vkeyPath,
      publicSignals,
      proof
    );
    console.log("  Verification:", valid ? "✓ VALID" : "✗ INVALID");
    console.log();
  } catch (err) {
    console.error("✗ Withdraw proof failed:", err.message);
    console.error(err.stack);
    return;
  }

  // Test transfer proof (if artifacts exist)
  if (transferWasmExists && transferZkeyExists) {
    console.log("Generating transfer proof...");
    const transferInputs = JSON.parse(
      fs.readFileSync(path.join(__dirname, "test-transfer-input.json"), "utf-8")
    );

    try {
      const startTime = Date.now();
      const { proof, publicSignals } = await generateProof(
        PROVER_ARTIFACTS.transfer.wasmPath,
        PROVER_ARTIFACTS.transfer.zkeyPath,
        transferInputs
      );
      const duration = Date.now() - startTime;

      console.log("✓ Transfer proof generated in", duration, "ms");
      console.log("  Proof pi_a:", proof.pi_a[0].substring(0, 20) + "...");
      console.log("  Public signals:", publicSignals.length, "values");

      // Verify the proof
      const valid = await verifyProof(
        PROVER_ARTIFACTS.transfer.vkeyPath,
        publicSignals,
        proof
      );
      console.log("  Verification:", valid ? "✓ VALID" : "✗ INVALID");
      console.log();
    } catch (err) {
      console.error("✗ Transfer proof failed:", err.message);
      console.error(err.stack);
      return;
    }
  }

  console.log("✓ All prover tests passed!");
}

testProver()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ Test failed:", err);
    process.exit(1);
  });
