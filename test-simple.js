#!/usr/bin/env node
/**
 * Simple standalone test to verify deposit flow
 */

const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { AnchorProvider, Wallet } = require("@coral-xyz/anchor");
const {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createMint,
  createAssociatedTokenAccountInstruction,
  mintTo,
  getAccount,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Starting simple test...");

  // Setup connection
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  // Check validator is running
  try {
    const version = await connection.getVersion();
    console.log("✓ Validator running:", version["solana-core"]);
  } catch (e) {
    console.error("✗ Validator not running:", e.message);
    process.exit(1);
  }

  // Load wallet
  const rootDir = path.resolve(__dirname, "..");
  const walletPath = path.join(rootDir, "wallet.json");
  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  console.log("✓ Loaded wallet:", walletKeypair.publicKey.toBase58());

  // Airdrop if needed
  const balance = await connection.getBalance(walletKeypair.publicKey);
  if (balance < 1_000_000_000) {
    console.log("Requesting airdrop...");
    const sig = await connection.requestAirdrop(
      walletKeypair.publicKey,
      2_000_000_000
    );
    await connection.confirmTransaction(sig);
    console.log("✓ Airdrop confirmed");
  }

  // Setup provider
  const wallet = new Wallet(walletKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Load program (skip Program wrapper due to IDL format issues)
  const programId = new PublicKey(
    "C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7"
  );
  const idlPath = path.join(
    rootDir,
    "program",
    "target",
    "idl",
    "shielded_pool.json"
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  console.log("✓ Program loaded:", programId.toBase58());

  // Create mint first (needed for pool config address)
  console.log("Creating mint...");
  const mint = await createMint(
    connection,
    walletKeypair,
    walletKeypair.publicKey,
    null,
    9,
    undefined,
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log("✓ Mint created:", mint.toBase58());

  // Compute pool config address
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.toBuffer()],
    programId
  );

  // Initialize SDK client
  console.log("Initializing SDK client...");
  const { ShieldedPoolClient } = require("./dist");
  const client = new ShieldedPoolClient({
    connection,
    programId,
    poolConfig,
    payer: walletKeypair,
    idl,
  });
  console.log("✓ SDK client initialized");

  // Initialize client (loads keys, starts scanner)
  await client.init();
  console.log("✓ Client init complete");

  // Create user token account
  console.log("Setting up token account...");
  const userTokenAccount = getAssociatedTokenAddressSync(
    mint,
    walletKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  try {
    await getAccount(
      connection,
      userTokenAccount,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    console.log("✓ User ATA exists");
  } catch {
    const ix = createAssociatedTokenAccountInstruction(
      walletKeypair.publicKey,
      userTokenAccount,
      walletKeypair.publicKey,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new (require("@solana/web3.js").Transaction)();
    tx.recentBlockhash = blockhash;
    tx.feePayer = walletKeypair.publicKey;
    tx.add(ix);
    await provider.sendAndConfirm(tx, [walletKeypair]);
    console.log("✓ User ATA created");
  }

  // Mint tokens to user
  console.log("Minting tokens...");
  await mintTo(
    connection,
    walletKeypair,
    mint,
    userTokenAccount,
    walletKeypair,
    10_000_000,
    [],
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log("✓ Tokens minted");

  // Perform deposit using SDK
  console.log("\nPerforming deposit...");
  const depositAmount = 1_000_000;

  const note = await client.deposit(mint, depositAmount);
  console.log("✓ Deposit successful!");
  console.log("  Amount:", depositAmount);
  console.log("  Note commitment:", note.commitment.slice(0, 16) + "...");

  // Wait for scanner to process
  console.log("\nWaiting for scanner...");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const shieldedBalance = client.getShieldedBalance(mint);
  console.log("✓ Shielded balance:", shieldedBalance);

  console.log("\n✓ All tests passed!");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ Test failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
