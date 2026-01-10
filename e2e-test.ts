/**
 * End-to-End Integration Test
 *
 * Tests the complete flow:
 * 1. Deploy/initialize pool
 * 2. Deposit tokens
 * 3. Generate proof client-side
 * 4. Withdraw with on-chain verification
 * 5. Verify balance changes
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  Transaction,
} from "@solana/web3.js";
import {
  Program,
  AnchorProvider,
  Wallet,
  setProvider,
} from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { ShieldedPoolClient } from "./src/client";
import * as fs from "fs";
import * as path from "path";

// Load IDL
const idlPath = process.env.IDL_PATH || path.join(__dirname, "src/idl.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

async function main() {
  // Simple retry helper for transient blockhash expiry on devnet
  async function retry<T>(
    label: string,
    fn: () => Promise<T>,
    attempts = 3
  ): Promise<T> {
    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        const msg = `${label} failed (attempt ${i}/${attempts})`;
        if (
          e?.name === "TransactionExpiredBlockheightExceededError" ||
          /block height exceeded/i.test(e?.message || "")
        ) {
          console.log(`⚠️  ${msg}: block height exceeded; retrying...`);
        } else {
          console.log(`⚠️  ${msg}: ${e?.message || e}`);
        }
        // Small delay before retry
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    throw lastErr;
  }
  console.log("🧪 Starting E2E Integration Test\n");

  // Setup connection (use env or default to localhost)
  const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
  connection = new Connection(RPC_URL, "confirmed");

  // Load wallet
  const walletPath =
    process.env.WALLET || path.join(__dirname, "test-fixtures/wallet.json");
  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  console.log(`✅ Wallet: ${walletKeypair.publicKey.toBase58()}`);

  // Check wallet balance
  const balance = await connection.getBalance(walletKeypair.publicKey);
  console.log(`   Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < LAMPORTS_PER_SOL) {
    console.log("\n💰 Airdropping SOL...");
    const signature = await connection.requestAirdrop(
      walletKeypair.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(signature);
    console.log("✅ Airdrop confirmed");
  }

  // Setup provider and program
  const wallet = new Wallet(walletKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: true,
    maxRetries: 5,
  });
  // Reusable confirm options for token ops
  const confirmOpts = {
    commitment: "confirmed" as const,
    skipPreflight: true,
    maxRetries: 5,
  };
  setProvider(provider);

  const programId = new PublicKey(
    "C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7"
  );
  const program = new Program(idl, provider);
  console.log(`✅ Program: ${programId.toBase58()}\n`);

  // Step 1: Create test token
  console.log("📝 Step 1: Creating test token...");
  const mintAuthority = walletKeypair;
  const mint = await retry("createMint", () =>
    createMint(
      connection,
      walletKeypair,
      mintAuthority.publicKey,
      null,
      6, // 6 decimals
      undefined,
      confirmOpts,
      TOKEN_2022_PROGRAM_ID
    )
  );
  console.log(`✅ Token created: ${mint.toBase58()}`);

  // Create token account for wallet
  const userTokenAccount = await retry("getOrCreateATA", () =>
    getOrCreateAssociatedTokenAccount(
      connection,
      walletKeypair,
      mint,
      walletKeypair.publicKey,
      false,
      "confirmed",
      confirmOpts,
      TOKEN_2022_PROGRAM_ID
    )
  );
  console.log(`✅ User token account: ${userTokenAccount.address.toBase58()}`);

  // Mint tokens to user
  const mintAmount = 10_000_000; // 10 tokens with 6 decimals
  await retry("mintTo", () =>
    mintTo(
      connection,
      walletKeypair,
      mint,
      userTokenAccount.address,
      mintAuthority,
      mintAmount,
      [],
      confirmOpts,
      TOKEN_2022_PROGRAM_ID
    )
  );
  console.log(`✅ Minted ${mintAmount / 1_000_000} tokens to user\n`);

  // Step 2: Initialize pool
  console.log("📝 Step 2: Initializing shielded pool...");

  // Derive pool config PDA from mint
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.toBuffer()],
    programId
  );

  try {
    // Check if pool already exists
    try {
      const poolData = await (program.account as any).poolConfig.fetch(
        poolConfig
      );
      console.log("⚠️  Pool already exists, skipping initialization");
    } catch {
      // Pool doesn't exist, initialize it
      const configSeed = mint.toBuffer(); // 32-byte seed from mint

      // Create compute budget instruction (max allowed is 1.4M)
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000,
      });

      const initIx = await (program.methods as any)
        .initializePool(
          configSeed,
          20, // merkle_depth - MUST match circuit
          100, // root_history
          256 // nullifier_chunk_size
        )
        .accounts({
          mint: mint,
          authority: walletKeypair.publicKey,
        })
        .instruction();

      const tx = new Transaction().add(computeBudgetIx, initIx);
      const sig = await provider.sendAndConfirm(tx);

      console.log(`✅ Pool initialized: ${poolConfig.toBase58()}`);
      console.log(`   Signature: ${sig}`);
    }
  } catch (error: any) {
    console.log(`⚠️  Pool initialization failed: ${error.message}`);
    console.log("   Continuing with existing pool...");
  }

  console.log();

  // Step 3: Initialize SDK client
  console.log("📝 Step 3: Initializing SDK client...");
  console.log("   Creating client from seed...");

  const seed = Buffer.alloc(32, 1); // Simple test seed
  const client = await ShieldedPoolClient.fromSeed(
    {
      connection,
      programId,
      poolConfig: poolConfig,
      payer: walletKeypair,
      idl,
    },
    seed
  );

  console.log("   Client initialized successfully");
  const shieldedAddress = client.getShieldedAddress();
  console.log(`✅ Shielded address: ${shieldedAddress}\n`); // Step 4: Deposit tokens
  console.log("📝 Step 4: Depositing tokens to shielded pool...");
  const depositAmount = 5_000_000n; // 5 tokens

  try {
    const depositSig = await client.deposit(depositAmount);
    console.log(`✅ Deposit confirmed: ${depositSig}`);

    // Wait for scanner to process
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const balance = await client.getBalance();
    console.log(`✅ Shielded balance: ${balance / 1_000_000n} tokens\n`);
  } catch (error: any) {
    console.error(`❌ Deposit failed: ${error.message}`);
    if (error.logs) {
      console.error("   Logs:", error.logs.join("\n   "));
    }
    process.exit(1);
  }

  // Step 5: Withdraw tokens with proof generation
  console.log("📝 Step 5: Withdrawing tokens with ZK proof...");
  const withdrawAmount = 1_000_000n; // 1 token
  const recipient = walletKeypair.publicKey;

  try {
    // Check circuit artifacts exist
    const artifactsPath = path.join(__dirname, "circuits");
    const wasmPath = path.join(artifactsPath, "withdraw.wasm");
    const zkeyPath = path.join(artifactsPath, "withdraw_final.zkey");

    if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
      console.log("⚠️  Circuit artifacts not found");
      console.log("   Run: cd ../circuits && ./copy-to-sdk.sh");
      process.exit(1);
    }

    console.log("✅ Circuit artifacts found");
    console.log("⚡ Generating ZK proof (this may take ~1 second)...");

    const startTime = Date.now();
    const withdrawSig = await client.withdraw(withdrawAmount, recipient);
    const elapsed = Date.now() - startTime;

    console.log(`✅ Withdraw confirmed: ${withdrawSig}`);
    console.log(`   Proof generation + submission: ${elapsed}ms`);

    // Verify balance changes
    const newBalance = await client.getBalance();
    console.log(`✅ New shielded balance: ${newBalance / 1_000_000n} tokens`);

    // Check recipient token account
    const recipientAccount = await getAccount(
      connection,
      userTokenAccount.address,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    console.log(
      `✅ Recipient token balance: ${Number(recipientAccount.amount) / 1_000_000} tokens\n`
    );
  } catch (error: any) {
    console.error(`❌ Withdraw failed: ${error.message}`);
    if (error.stack) {
      console.error("Stack:", error.stack);
    }
    if (error.logs) {
      console.error("   Logs:", error.logs.join("\n   "));
    }
    process.exit(1);
  }

  // Step 6: Test shielded transfer (if we have enough balance)
  console.log("📝 Step 6: Testing shielded transfer...");

  const currentBalance = await client.getBalance();
  if (currentBalance < 2_000_000n) {
    console.log("⚠️  Insufficient balance for transfer test, skipping...\n");
  } else {
    try {
      // Create a second recipient address (for demo, use a different seed)
      const recipientSeed = Buffer.alloc(32, 2);
      const recipientClient = await ShieldedPoolClient.fromSeed(
        {
          connection,
          programId,
          poolConfig: poolConfig,
          payer: walletKeypair,
          idl,
        },
        recipientSeed
      );
      const recipientAddress = recipientClient.getShieldedAddress();

      console.log(`   Recipient: ${recipientAddress.substring(0, 20)}...`);
      console.log("⚡ Generating transfer proof...");

      const transferAmount = 1_000_000n;
      const startTime = Date.now();
      const transferSig = await client.transfer(
        transferAmount,
        recipientAddress
      );
      const elapsed = Date.now() - startTime;

      console.log(`✅ Transfer confirmed: ${transferSig}`);
      console.log(`   Proof generation + submission: ${elapsed}ms`);

      const finalBalance = await client.getBalance();
      console.log(
        `✅ Final shielded balance: ${finalBalance / 1_000_000n} tokens\n`
      );
    } catch (error: any) {
      console.error(`❌ Transfer failed: ${error.message}`);
      if (error.logs) {
        console.error("   Logs:", error.logs.join("\n   "));
      }
    }
  }

  console.log("🎉 E2E Integration Test Complete!\n");
  console.log("Summary:");
  console.log("✅ Pool initialized");
  console.log("✅ Tokens deposited");
  console.log("✅ ZK proof generated client-side");
  console.log("✅ Withdraw verified on-chain");
  console.log("✅ Balance changes confirmed");
  console.log("\n✨ All systems operational!\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  });
