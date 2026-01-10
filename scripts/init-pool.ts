import { AnchorProvider, Program, Idl, BN, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

async function main() {
  const rpc = process.env.RPC_URL || "http://127.0.0.1:8899";
  const programIdStr =
    process.env.PROGRAM_ID || "C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7";
  const programId = new PublicKey(programIdStr);
  const walletPath =
    process.env.WALLET ||
    path.join(process.env.HOME || "", "/.config/solana/id.json");
  const idlPath =
    process.env.IDL_PATH || path.join(__dirname, "../src/idl.json");
  const merkleDepth = parseInt(process.env.MERKLE_DEPTH || "12", 10);

  if (!fs.existsSync(walletPath))
    throw new Error(`Wallet not found: ${walletPath}`);
  const secret = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  if (!fs.existsSync(idlPath)) throw new Error(`IDL not found: ${idlPath}`);
  const idl: Idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const connection = new Connection(rpc, "confirmed");
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const program = new Program(idl, programId, provider);

  // Derive pool config PDA
  const [poolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-config")],
    programId
  );

  // Check if already exists
  const acc = await connection.getAccountInfo(poolConfigPda);
  if (acc) {
    console.log(`POOL_CONFIG already exists: ${poolConfigPda.toBase58()}`);
    return;
  }

  // Initialize pool
  console.log("Initializing pool...");
  const nullifierChunkSize = 64; // sensible default for tests
  const txSig = await program.methods
    .initializePool(new BN(merkleDepth), new BN(nullifierChunkSize))
    .accounts({
      payer: payer.publicKey,
      poolConfig: poolConfigPda,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .signers([payer])
    .rpc();

  console.log(`✅ Pool initialized. Tx: ${txSig}`);
  console.log(`POOL_CONFIG=${poolConfigPda.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
/**
 * Initialize a new shielded pool
 * Usage: ts-node scripts/init-pool.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import idl from "../src/idl.json";

async function main() {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const programId = new PublicKey(idl.address);

  // Load payer from wallet.json (via env var or default to Solana CLI config)
  const walletPath =
    process.env.WALLET ||
    path.join(process.env.HOME || "", ".config/solana/id.json");
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet not found: ${walletPath}. Set WALLET env var.`);
  }
  const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const payer = Keypair.fromSecretKey(new Uint8Array(walletData));

  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Program:", programId.toBase58());

  // Create provider and program
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new Program(idl as any, provider);

  // Use native SOL as the mint (we'll need to create an SPL token for real usage)
  // For now, let's create a simple test mint
  const mint = Keypair.generate();
  console.log("\n🪙 Creating test mint:", mint.publicKey.toBase58());

  // For this example, we'll use a system program account as a placeholder
  // In production, you'd create an actual SPL token mint
  // For now, let's use the payer's pubkey as a deterministic "mint"
  const testMint = payer.publicKey; // Placeholder

  // Derive PDAs
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), testMint.toBuffer()],
    programId
  );

  const [poolTree] = PublicKey.findProgramAddressSync(
    [Buffer.from("tree"), testMint.toBuffer()],
    programId
  );

  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), testMint.toBuffer()],
    programId
  );

  console.log("\n📋 Pool accounts:");
  console.log("  Pool Config:", poolConfig.toBase58());
  console.log("  Pool Tree:  ", poolTree.toBase58());
  console.log("  Vault Auth: ", vaultAuthority.toBase58());

  // Initialize pool
  const merkleDepth = parseInt(process.env.MERKLE_DEPTH || "20");
  const rootHistory = 100;
  const nullifierChunkSize = 1024;

  try {
    console.log(`\n🔧 Initializing pool (depth=${merkleDepth})...`);

    const tx = await program.methods
      .initializePool(
        Buffer.from("test-pool-v1"),
        merkleDepth,
        rootHistory,
        nullifierChunkSize
      )
      .accounts({
        poolConfig,
        poolTree,
        vaultAuthority,
        mint: testMint,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("✅ Pool initialized!");
    console.log("   Transaction:", tx);
    console.log("\n💾 Save these for your .env:");
    console.log(`POOL_CONFIG=${poolConfig.toBase58()}`);
    console.log(`POOL_MINT=${testMint.toBase58()}`);
  } catch (err: any) {
    console.error("❌ Initialization failed:", err.message);
    if (err.logs) {
      console.error("\nProgram logs:");
      err.logs.forEach((log: string) => console.error("  ", log));
    }
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
