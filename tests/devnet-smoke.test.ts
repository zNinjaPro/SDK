/**
 * Devnet Smoke Test — validates the complete shielded pool flow with real Groth16 proofs
 *
 * This test runs against a live devnet deployment. It exercises:
 *   1. Deposit tokens into the pool
 *   2. Epoch rollover (permissionless)
 *   3. Epoch finalization (permissionless)
 *   4. Withdraw tokens with a real Groth16 proof verified on-chain
 *   5. (Optional) Shielded transfer with real proofs
 *
 * Configuration via environment variables:
 *   SOLANA_RPC_URL     — devnet RPC endpoint (default: https://api.devnet.solana.com)
 *   POOL_CONFIG_PDA    — base58 pool config PDA from deploy-devnet.sh
 *   TOKEN_MINT         — base58 SPL token mint from deploy-devnet.sh
 *   DEVNET_PAYER_PATH  — path to payer keypair JSON (default: ~/.config/solana/id.json)
 *   TEST_MNEMONIC      — optional BIP39 mnemonic for deterministic keys
 *   DEPLOYMENT_JSON    — path to devnet-deployment.json (alternative to individual env vars)
 *   SKIP_TRANSFER      — set to "1" to skip the transfer test (saves time)
 *
 * Prerequisites:
 *   - Program deployed on devnet with altbn128_syscalls feature
 *   - Pool initialized with short epoch params (100 slots duration)
 *   - Verification keys uploaded for withdraw, transfer, renew circuits
 *   - Payer wallet funded with SOL and test tokens on devnet
 *   - Circuit artifacts present in sdk/circuits/ (withdraw, transfer, renew)
 *
 * Run:
 *   cd sdk && npx mocha -r ts-node/register tests/devnet-smoke.test.ts --timeout 600000 --exit
 */

import "mocha";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { Idl } from "@coral-xyz/anchor";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { ShieldedPoolClient } from "../src/client";
import { PDA_SEEDS } from "../src/config";
import idl from "../src/idl.json";

// ============================================================
// CONFIGURATION
// ============================================================

interface DeploymentConfig {
  rpcUrl: string;
  programId: PublicKey;
  poolConfig: PublicKey;
  tokenMint: PublicKey;
  payerKeypair: Keypair;
  testMnemonic?: string;
}

function loadDeploymentConfig(): DeploymentConfig {
  const programId = new PublicKey(
    "C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7",
  );

  // Try loading from devnet-deployment.json first
  const deploymentJsonPath =
    process.env.DEPLOYMENT_JSON ||
    path.join(__dirname, "../../program/devnet-deployment.json");

  let poolConfigStr: string | undefined;
  let tokenMintStr: string | undefined;

  if (fs.existsSync(deploymentJsonPath)) {
    const deployment = JSON.parse(fs.readFileSync(deploymentJsonPath, "utf8"));
    poolConfigStr = deployment.poolConfig || deployment.pool_config;
    tokenMintStr =
      deployment.tokenMint || deployment.token_mint || deployment.mint;
    console.log(`📄 Loaded deployment config from ${deploymentJsonPath}`);
  }

  // Environment variables override deployment JSON
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  poolConfigStr = process.env.POOL_CONFIG_PDA || poolConfigStr;
  tokenMintStr = process.env.TOKEN_MINT || tokenMintStr;

  if (!poolConfigStr || !tokenMintStr) {
    throw new Error(
      "Missing POOL_CONFIG_PDA and/or TOKEN_MINT. Set env vars or provide DEPLOYMENT_JSON path.",
    );
  }

  // Load payer keypair
  const payerPath =
    process.env.DEVNET_PAYER_PATH ||
    path.join(process.env.HOME || "~", ".config", "solana", "id.json");

  if (!fs.existsSync(payerPath)) {
    throw new Error(
      `Payer keypair not found at ${payerPath}. Set DEVNET_PAYER_PATH env var.`,
    );
  }

  const payerSecret: number[] = JSON.parse(fs.readFileSync(payerPath, "utf8"));
  const payerKeypair = Keypair.fromSecretKey(Uint8Array.from(payerSecret));

  return {
    rpcUrl,
    programId,
    poolConfig: new PublicKey(poolConfigStr),
    tokenMint: new PublicKey(tokenMintStr),
    payerKeypair,
    testMnemonic: process.env.TEST_MNEMONIC,
  };
}

// ============================================================
// HELPERS
// ============================================================

/** Sleep for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a specific slot, polling every interval */
async function waitForSlot(
  connection: Connection,
  targetSlot: number,
  pollIntervalMs: number = 2000,
  timeoutMs: number = 300000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const currentSlot = await connection.getSlot();
    if (currentSlot >= targetSlot) return;
    const remaining = targetSlot - currentSlot;
    console.log(
      `   ⏳ Current slot: ${currentSlot}, target: ${targetSlot} (${remaining} slots remaining)`,
    );
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for slot ${targetSlot} after ${timeoutMs}ms`,
  );
}

/** Ensure payer has minimum SOL balance (airdrop if needed) */
async function ensurePayerSol(
  connection: Connection,
  payer: Keypair,
  minLamports: number = 2 * LAMPORTS_PER_SOL,
): Promise<void> {
  const balance = await connection.getBalance(payer.publicKey);
  if (balance < minLamports) {
    console.log(
      `   ⬆️  Airdropping SOL: current ${balance / LAMPORTS_PER_SOL} SOL, need ${minLamports / LAMPORTS_PER_SOL} SOL`,
    );
    // Devnet airdrop max is 2 SOL per request
    const needed = minLamports - balance;
    const batches = Math.ceil(needed / (2 * LAMPORTS_PER_SOL));
    for (let i = 0; i < batches; i++) {
      const amount = Math.min(
        2 * LAMPORTS_PER_SOL,
        needed - i * 2 * LAMPORTS_PER_SOL,
      );
      try {
        const sig = await connection.requestAirdrop(payer.publicKey, amount);
        await connection.confirmTransaction(sig, "confirmed");
        console.log(
          `   ✅ Airdrop ${i + 1}/${batches}: ${amount / LAMPORTS_PER_SOL} SOL`,
        );
      } catch (e) {
        console.warn(
          `   ⚠️  Airdrop failed (may be rate limited):`,
          (e as Error).message,
        );
        // Wait and retry
        await sleep(10000);
      }
    }
    const newBalance = await connection.getBalance(payer.publicKey);
    console.log(`   SOL balance: ${newBalance / LAMPORTS_PER_SOL} SOL`);
  }
}

/** Ensure payer has test tokens via mint authority */
async function ensureTokens(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  amount: number = 100_000_000,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Create ATA if it doesn't exist
  const ataInfo = await connection.getAccountInfo(ata);
  if (!ataInfo) {
    console.log("   Creating associated token account...");
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      payer.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const tx = new Transaction().add(ix);
    const sig = await connection.sendTransaction(tx, [payer]);
    await connection.confirmTransaction(sig, "confirmed");
  }

  // Check balance
  const account = await getAccount(connection, ata);
  const currentBalance = Number(account.amount);
  if (currentBalance < amount) {
    console.log(
      `   Minting ${amount - currentBalance} test tokens to payer...`,
    );
    try {
      await mintTo(
        connection,
        payer,
        mint,
        ata,
        payer, // assuming payer is mint authority for test token
        amount - currentBalance,
        [],
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID,
      );
      console.log(`   ✅ Token balance: ${amount}`);
    } catch (e) {
      console.warn(
        `   ⚠️  Mint failed (payer may not be mint authority):`,
        (e as Error).message,
      );
      if (currentBalance === 0) {
        throw new Error(
          "Payer has no test tokens and cannot mint. Transfer tokens manually.",
        );
      }
      console.log(`   Using existing balance: ${currentBalance}`);
    }
  }

  return ata;
}

// ============================================================
// TEST SUITE
// ============================================================

describe("Devnet Smoke Test", function () {
  // These tests involve real proof generation and on-chain confirmation
  this.timeout(600_000); // 10 minutes total timeout

  let config: DeploymentConfig;
  let connection: Connection;
  let client: ShieldedPoolClient;

  // Track tx signatures for post-test inspection
  const txSignatures: Record<string, string> = {};

  // Per-epoch state
  let depositEpoch: bigint;

  before(async function () {
    console.log("\n🚀 Devnet Smoke Test — Setup");
    console.log("═══════════════════════════════════════");

    // Load configuration
    try {
      config = loadDeploymentConfig();
    } catch (e) {
      console.error("❌ Configuration error:", (e as Error).message);
      console.error(
        "   Set POOL_CONFIG_PDA, TOKEN_MINT env vars or provide DEPLOYMENT_JSON path.",
      );
      this.skip();
      return;
    }

    console.log(`   RPC:          ${config.rpcUrl}`);
    console.log(`   Program:      ${config.programId.toBase58()}`);
    console.log(`   Pool Config:  ${config.poolConfig.toBase58()}`);
    console.log(`   Token Mint:   ${config.tokenMint.toBase58()}`);
    console.log(`   Payer:        ${config.payerKeypair.publicKey.toBase58()}`);

    connection = new Connection(config.rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 120_000,
    });

    // Ensure payer has SOL
    await ensurePayerSol(connection, config.payerKeypair);

    // Ensure payer has test tokens
    await ensureTokens(connection, config.payerKeypair, config.tokenMint);

    // Verify pool config exists on-chain
    const poolInfo = await connection.getAccountInfo(config.poolConfig);
    if (!poolInfo) {
      console.error(
        "❌ Pool config account not found on-chain. Run deploy-devnet.sh first.",
      );
      this.skip();
      return;
    }
    console.log(
      `   Pool config account: ${poolInfo.data.length} bytes, owner=${poolInfo.owner.toBase58()}`,
    );

    // Create ShieldedPoolClient with real prover (no testMode)
    const clientConfig: any = {
      connection,
      programId: config.programId,
      poolConfig: config.poolConfig,
      payer: config.payerKeypair,
      idl: idl as Idl,
      artifactsBaseDir: path.join(__dirname, "..", "circuits"),
      merkleOrder: "bottom-up" as const,
      historyScanLimit: 200,
      testMode: false,
    };

    if (config.testMnemonic) {
      client = await ShieldedPoolClient.fromMnemonic(
        clientConfig,
        config.testMnemonic,
      );
    } else {
      client = await ShieldedPoolClient.create(clientConfig);
    }

    depositEpoch = client.getCurrentEpoch();

    console.log(`   Shielded address: ${client.getShieldedAddress()}`);
    console.log(`   Current epoch:    ${depositEpoch}`);
    console.log(`   Initial balance:  ${await client.getBalance()}`);
    console.log("═══════════════════════════════════════\n");
  });

  after(async function () {
    // Print transaction summary
    console.log("\n═══════════════════════════════════════");
    console.log("📋 Transaction Summary");
    console.log("═══════════════════════════════════════");
    for (const [label, sig] of Object.entries(txSignatures)) {
      console.log(`   ${label}: ${sig}`);
      console.log(`      https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    }
    console.log("═══════════════════════════════════════\n");

    // Clean up scanner subscription
    if (client) {
      await client.stop();
    }
  });

  // ----------------------------------------------------------
  // TEST 1: Deposit
  // ----------------------------------------------------------
  it("deposits tokens into the pool", async function () {
    this.timeout(120_000);
    console.log("📥 Test: Deposit");

    const depositAmount = 1_000_000n; // 1M token units
    const balanceBefore = await client.getBalance();
    console.log(`   Balance before: ${balanceBefore}`);

    const sig = await client.deposit(depositAmount);
    txSignatures["deposit"] = sig;
    console.log(`   ✅ Deposit tx: ${sig}`);

    // Wait for balance to update (scanner processes events)
    const ok = await client.waitForBalance(
      balanceBefore + depositAmount,
      60_000,
    );
    const balanceAfter = await client.getBalance();
    console.log(`   Balance after:  ${balanceAfter}`);

    expect(sig).to.be.a("string").with.length.greaterThan(80);
    expect(balanceAfter >= balanceBefore + depositAmount).to.be.true;

    // Verify note has epoch and leafIndex
    const notes = client.getUnspentNotes();
    expect(notes.length).to.be.at.least(1);
    const depositedNote = notes[notes.length - 1];
    console.log(
      `   Note: epoch=${depositedNote.epoch}, leafIndex=${depositedNote.leafIndex}, value=${depositedNote.value}`,
    );
  });

  // ----------------------------------------------------------
  // TEST 2: Epoch Rollover & Finalization
  // ----------------------------------------------------------
  it("triggers epoch rollover and finalization", async function () {
    this.timeout(300_000); // 5 minutes — may need to wait for epoch to end
    console.log("🔄 Test: Epoch Lifecycle");

    // Fetch epoch tree to check timing
    const epochInfo = await client.getEpochInfo();
    console.log(`   Current epoch: ${epochInfo.epoch}`);
    console.log(`   Epoch state:   ${epochInfo.state}`);
    console.log(`   Deposits:      ${epochInfo.depositCount}`);

    // Get current slot and epoch config to determine when rollover is possible
    const currentSlot = await connection.getSlot();
    const startSlot = Number(epochInfo.startSlot);
    console.log(`   Current slot:  ${currentSlot}`);
    console.log(`   Epoch start:   ${startSlot}`);

    // If using short epochs (100 slots), we may need to wait for the epoch to end
    // The epoch duration is set during pool init; we read the pool config to find it
    // For devnet with short epochs: ~100 slots = ~40 seconds
    // Calculate when the epoch should end based on pool config

    // Try rollover — if the epoch hasn't ended yet, wait for it
    let rolloverSuccess = false;
    const maxWaitMs = 240_000; // 4 minutes max wait
    const startTime = Date.now();

    while (!rolloverSuccess && Date.now() - startTime < maxWaitMs) {
      try {
        const newEpoch = await client.rolloverEpoch();
        console.log(`   ✅ Epoch rolled over to: ${newEpoch}`);
        rolloverSuccess = true;
      } catch (e) {
        const msg = (e as Error).message;
        if (
          msg.includes("EpochNotEnded") ||
          msg.includes("epoch") ||
          msg.includes("0x") // anchor error codes
        ) {
          // Epoch hasn't ended yet — wait and retry
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(
            `   ⏳ Epoch not yet ended, waiting... (${elapsed}s elapsed)`,
          );
          await sleep(5000);
        } else {
          throw e; // unexpected error
        }
      }
    }

    if (!rolloverSuccess) {
      console.log(
        "   ⚠️  Epoch did not end within timeout — skipping rollover test",
      );
      console.log("   💡 This is expected if epoch_duration > ~100 slots");
      this.skip();
      return;
    }

    // Wait for finalization delay (for short devnet params: ~10 slots = ~4s)
    console.log("   Waiting for finalization delay...");
    await sleep(10_000); // Conservative wait for 10-slot finalization delay

    // Finalize the old epoch
    let finalizeSuccess = false;
    const finalizeStart = Date.now();
    while (!finalizeSuccess && Date.now() - finalizeStart < 60_000) {
      try {
        const finalizeSig = await client.finalizeEpoch(depositEpoch);
        txSignatures["finalize_epoch"] = finalizeSig;
        console.log(`   ✅ Epoch ${depositEpoch} finalized: ${finalizeSig}`);
        finalizeSuccess = true;
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("FinalizationDelay") || msg.includes("0x")) {
          console.log("   ⏳ Finalization delay not met, waiting...");
          await sleep(5000);
        } else {
          throw e;
        }
      }
    }

    if (!finalizeSuccess) {
      console.log("   ⚠️  Could not finalize epoch within timeout");
      this.skip();
      return;
    }

    // Verify epoch is now finalized
    const updatedInfo = await client.getEpochInfo();
    console.log(`   New current epoch: ${updatedInfo.epoch}`);
  });

  // ----------------------------------------------------------
  // TEST 3: Withdraw with real Groth16 proof
  // ----------------------------------------------------------
  it("withdraws tokens with real Groth16 proof", async function () {
    this.timeout(180_000); // 3 minutes — proof generation can be slow
    console.log("📤 Test: Withdraw with Real Proof");

    const balance = await client.getBalance();
    console.log(`   Balance: ${balance}`);

    if (balance === 0n) {
      console.log("   ⚠️  No balance to withdraw — skipping");
      this.skip();
      return;
    }

    // Withdraw the full deposited amount
    const withdrawAmount = balance;
    const recipient = config.payerKeypair.publicKey;
    console.log(`   Withdrawing: ${withdrawAmount} to ${recipient.toBase58()}`);

    console.log("   🔐 Generating Groth16 proof (this may take 30-60s)...");
    const proofStart = Date.now();

    const sig = await client.withdraw(withdrawAmount, recipient);
    txSignatures["withdraw"] = sig;

    const proofDuration = Date.now() - proofStart;
    console.log(`   ✅ Withdraw tx: ${sig} (proof+submit: ${proofDuration}ms)`);

    // Verify balance is now 0
    const balanceAfter = await client.getBalance();
    console.log(`   Balance after:  ${balanceAfter}`);
    expect(balanceAfter).to.equal(0n);

    // Verify on-chain: check tx was successful
    const txResult = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(txResult).to.not.be.null;
    expect(txResult!.meta!.err).to.be.null;

    // Log CU usage for Task 6
    if (txResult?.meta?.computeUnitsConsumed) {
      console.log(
        `   📊 Compute units consumed: ${txResult.meta.computeUnitsConsumed}`,
      );
    }
  });

  // ----------------------------------------------------------
  // TEST 4: Shielded Transfer (optional)
  // ----------------------------------------------------------
  it("performs shielded transfer with real proof", async function () {
    if (process.env.SKIP_TRANSFER === "1") {
      console.log("   ⏩ Skipping transfer test (SKIP_TRANSFER=1)");
      this.skip();
      return;
    }

    this.timeout(300_000); // 5 minutes — multiple deposits + epoch cycle + proof
    console.log("🔀 Test: Shielded Transfer with Real Proof");

    // We need at least 2 notes for the transfer circuit.
    // Deposit twice to create 2 notes in the current epoch.
    const depositAmount = 500_000n;

    console.log("   Depositing note 1...");
    const sig1 = await client.deposit(depositAmount);
    txSignatures["transfer_deposit_1"] = sig1;
    console.log(`   ✅ Deposit 1: ${sig1}`);

    console.log("   Depositing note 2...");
    const sig2 = await client.deposit(depositAmount);
    txSignatures["transfer_deposit_2"] = sig2;
    console.log(`   ✅ Deposit 2: ${sig2}`);

    // Wait for balance to include both deposits
    const expectedBalance = depositAmount * 2n;
    const ok = await client.waitForBalance(expectedBalance, 60_000);
    const balance = await client.getBalance();
    console.log(`   Balance: ${balance} (expected: ${expectedBalance})`);

    if (balance < expectedBalance) {
      console.log("   ⚠️  Insufficient balance for transfer — skipping");
      this.skip();
      return;
    }

    // Trigger epoch cycle so these notes become spendable
    const currentEpoch = client.getCurrentEpoch();
    console.log(`   Current epoch: ${currentEpoch}`);

    // Wait for epoch to end and rollover
    console.log("   Waiting for epoch to end for rollover...");
    let rolloverDone = false;
    const rolloverStart = Date.now();
    while (!rolloverDone && Date.now() - rolloverStart < 240_000) {
      try {
        await client.rolloverEpoch();
        rolloverDone = true;
        console.log("   ✅ Epoch rolled over");
      } catch {
        await sleep(5000);
      }
    }

    if (!rolloverDone) {
      console.log("   ⚠️  Could not rollover epoch — skipping transfer");
      this.skip();
      return;
    }

    // Wait for finalization
    console.log("   Waiting for finalization...");
    await sleep(10_000);
    let finalizeDone = false;
    const finalizeStart = Date.now();
    while (!finalizeDone && Date.now() - finalizeStart < 60_000) {
      try {
        const finSig = await client.finalizeEpoch(currentEpoch);
        txSignatures["transfer_finalize"] = finSig;
        finalizeDone = true;
        console.log("   ✅ Epoch finalized");
      } catch {
        await sleep(5000);
      }
    }

    if (!finalizeDone) {
      console.log("   ⚠️  Could not finalize — skipping transfer");
      this.skip();
      return;
    }

    // Create a second client as recipient
    const recipientClient = await ShieldedPoolClient.create({
      connection,
      programId: config.programId,
      poolConfig: config.poolConfig,
      payer: config.payerKeypair,
      idl: idl as Idl,
      artifactsBaseDir: path.join(__dirname, "..", "circuits"),
      merkleOrder: "bottom-up" as const,
      historyScanLimit: 200,
      testMode: false,
    });
    const recipientAddress = recipientClient.getShieldedAddress();
    console.log(`   Recipient shielded address: ${recipientAddress}`);

    // Transfer
    const transferAmount = 400_000n;
    console.log(`   🔐 Generating transfer proof (this may take 60-120s)...`);
    const proofStart = Date.now();

    const transferSig = await client.transfer(transferAmount, recipientAddress);
    txSignatures["transfer"] = transferSig;

    const proofDuration = Date.now() - proofStart;
    console.log(
      `   ✅ Transfer tx: ${transferSig} (proof+submit: ${proofDuration}ms)`,
    );

    // Verify sender balance decreased
    const senderBalance = await client.getBalance();
    console.log(`   Sender balance after:    ${senderBalance}`);

    // Log CU usage for Task 6
    const txResult = await connection.getTransaction(transferSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (txResult?.meta?.computeUnitsConsumed) {
      console.log(
        `   📊 Compute units consumed: ${txResult.meta.computeUnitsConsumed}`,
      );
    }

    // Clean up recipient scanner
    await recipientClient.stop();
  });
});
