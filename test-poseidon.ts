/**
 * Quick test to verify Poseidon syscall works on custom validator
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const idlPath = process.env.IDL_PATH || path.join(__dirname, "src/idl.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

async function main() {
  console.log("🧪 Testing Poseidon Syscall on Custom Validator\n");

  const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`📡 RPC: ${RPC_URL}\n`);

  // Load wallet
  const walletPath =
    process.env.WALLET || path.join(__dirname, "test-fixtures/wallet.json");
  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

  const balance = await connection.getBalance(walletKeypair.publicKey);
  console.log(`✅ Wallet: ${walletKeypair.publicKey.toBase58()}`);
  console.log(`   Balance: ${balance / 1e9} SOL\n`);

  const wallet = new Wallet(walletKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const programId = new PublicKey(idl.address);
  const program = new Program(idl, provider);

  console.log(`✅ Program: ${programId.toBase58()}\n`);

  // Create a test token
  console.log("📝 Creating test token...");
  const mintAuthority = walletKeypair;
  const mint = await createMint(
    connection,
    walletKeypair,
    mintAuthority.publicKey,
    null,
    6,
    undefined,
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`✅ Token: ${mint.toBase58()}\n`);

  // Get user token account
  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    walletKeypair,
    mint,
    walletKeypair.publicKey,
    false,
    undefined,
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log(
    `✅ User token account: ${userTokenAccount.address.toBase58()}\n`
  );

  // Mint tokens
  await mintTo(
    connection,
    walletKeypair,
    mint,
    userTokenAccount.address,
    mintAuthority,
    10_000_000,
    [],
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`✅ Minted 10 tokens\n`);

  // Initialize pool
  console.log("📝 Initializing pool (this will trigger Poseidon syscall)...");

  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.toBuffer()],
    programId
  );

  const configSeed = mint.toBuffer();
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });

  try {
    const initIx = await (program.methods as any)
      .initializePool(configSeed, 20, 100, 256)
      .accounts({
        mint: mint,
        authority: walletKeypair.publicKey,
      })
      .instruction();

    const tx = new Transaction().add(computeBudgetIx, initIx);
    const sig = await provider.sendAndConfirm(tx, [], {
      commitment: "confirmed",
    });

    console.log(`\n✅ SUCCESS! Pool initialized: ${poolConfig.toBase58()}`);
    console.log(`   Signature: ${sig}`);
    console.log(`\n🎉 Poseidon syscall is WORKING on custom validator!`);
  } catch (error: any) {
    console.log(`\n❌ FAILED: ${error.message}`);
    if (error.logs) {
      console.log("\n📋 Transaction logs:");
      error.logs.forEach((log: string) => console.log(`   ${log}`));
    }
    console.log(`\n💀 Poseidon syscall still not available`);
  }
}

main().catch(console.error);
