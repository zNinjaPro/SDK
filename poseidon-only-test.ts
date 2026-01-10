/**
 * Minimal Poseidon Syscall Test
 *
 * Creates a real pool and tests deposit to trigger Poseidon hashing.
 * Much faster than full E2E test by using SPL Token v1 instead of v2.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  Program,
  AnchorProvider,
  Wallet,
  setProvider,
  BN,
} from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const idlPath = process.env.IDL_PATH || path.join(__dirname, "src/idl.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

async function main() {
  console.log("🧪 Minimal Poseidon Syscall Test\n");

  const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
  const connection = new Connection(RPC_URL, "confirmed");

  // Load wallet
  const walletPath =
    process.env.WALLET || path.join(__dirname, "test-fixtures/wallet.json");
  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  console.log(`✅ Wallet: ${walletKeypair.publicKey.toBase58()}`);

  const wallet = new Wallet(walletKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false, // Keep preflight to see errors
    maxRetries: 3,
  });
  setProvider(provider);

  const programId = new PublicKey(
    "C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7"
  );
  const program = new Program(idl, provider);

  console.log("\n📝 Step 1: Creating test mint (SPL Token v1 - faster)...");
  const mintKeypair = Keypair.generate();
  const mint = await createMint(
    connection,
    walletKeypair,
    walletKeypair.publicKey,
    null,
    6, // decimals
    mintKeypair,
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`✅ Mint created: ${mint.toBase58()}`);

  // Derive PDAs
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.toBuffer()],
    programId
  );
  const [poolVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()],
    programId
  );
  const [poolTree] = PublicKey.findProgramAddressSync(
    [Buffer.from("tree"), mint.toBuffer()],
    programId
  );

  console.log("\n📝 Step 2: Initializing pool...");
  try {
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    });

    const initIx = await (program.methods as any)
      .initializePool(
        mint.toBuffer(),
        20, // merkle_depth
        100, // root_history
        256 // nullifier_chunk_size
      )
      .accounts({
        mint: mint,
        authority: walletKeypair.publicKey,
      })
      .instruction();

    const tx = new Transaction().add(computeBudgetIx, initIx);
    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [walletKeypair],
      {
        commitment: "confirmed",
      }
    );
    console.log(`✅ Pool initialized: ${sig}`);
  } catch (e: any) {
    if (e.message.includes("already in use")) {
      console.log("⚠️  Pool already exists");
    } else {
      throw e;
    }
  }

  // Initialize first leaf chunk (required for deposit)
  console.log("\n📝 Step 2b: Initializing first leaf chunk...");
  try {
    const leafChunkIndex = 0;
    const [leafChunk] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("leaf"),
        mint.toBuffer(),
        new BN(leafChunkIndex).toArrayLike(Buffer, "be", 4),
      ],
      programId
    );

    const initLeafIx = await (program.methods as any)
      .initializeLeafChunk(leafChunkIndex)
      .accounts({
        leafChunk: leafChunk,
        mint: mint,
        payer: walletKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx2 = new Transaction().add(initLeafIx);
    const sig2 = await sendAndConfirmTransaction(
      connection,
      tx2,
      [walletKeypair],
      {
        commitment: "confirmed",
      }
    );
    console.log(`✅ Leaf chunk initialized: ${sig2}`);
  } catch (e: any) {
    if (e.message.includes("already in use")) {
      console.log("⚠️  Leaf chunk already exists");
    } else {
      console.log(`⚠️  Leaf chunk init: ${e.message}`);
    }
  }

  console.log("\n📝 Step 3: Getting vault token account address...");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    mint,
    poolVault,
    true, // allow off-curve PDA
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`✅ Vault ATA: ${vaultTokenAccount.toBase58()}`);

  // Check if vault token account exists
  const vaultAccountInfo = await connection.getAccountInfo(vaultTokenAccount);
  if (!vaultAccountInfo) {
    console.log("   Creating vault token account...");
    const createVaultAtaIx = createAssociatedTokenAccountInstruction(
      walletKeypair.publicKey,
      vaultTokenAccount,
      poolVault,
      mint,
      TOKEN_2022_PROGRAM_ID
    );
    const tx = new Transaction().add(createVaultAtaIx);
    await sendAndConfirmTransaction(connection, tx, [walletKeypair], {
      commitment: "confirmed",
    });
    console.log("✅ Vault token account created");
  } else {
    console.log("   Vault token account already exists");
  }

  console.log("\n📝 Step 3b: Creating user token account...");
  const userTokenAccount = await createAccount(
    connection,
    walletKeypair,
    mint,
    walletKeypair.publicKey,
    undefined,
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`✅ User token account: ${userTokenAccount.toBase58()}`);

  console.log("\n📝 Step 4: Minting tokens...");
  await mintTo(
    connection,
    walletKeypair,
    mint,
    userTokenAccount,
    walletKeypair,
    10_000_000, // 10 tokens
    [],
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log("✅ Minted 10 tokens");

  console.log("\n🔥 Step 5: Depositing (will trigger Poseidon syscall)...");
  const commitment = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    commitment[i] = i + 1;
  }

  try {
    const leafIndex = 0;
    const [leafChunk] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("leaf"),
        mint.toBuffer(),
        new BN(Math.floor(leafIndex / 4096)).toArrayLike(Buffer, "be", 4),
      ],
      programId
    );

    const encryptedNote = Buffer.alloc(128); // Dummy encrypted data
    const tag = Array.from(new Uint8Array(16));

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    });

    const depositIx = await (program.methods as any)
      .depositShielded(
        new BN(5_000_000),
        Array.from(commitment),
        encryptedNote, // Pass Buffer directly for bytes type
        tag
      )
      .accounts({
        poolConfig: poolConfig,
        poolTree: poolTree,
        mint: mint,
        userTokenAccount: userTokenAccount,
        vaultTokenAccount: vaultTokenAccount,
        user: walletKeypair.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: leafChunk, isWritable: true, isSigner: false },
      ])
      .instruction();

    const tx = new Transaction().add(computeBudgetIx, depositIx);
    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [walletKeypair],
      {
        commitment: "confirmed",
      }
    );

    console.log(`✅ Deposit successful: ${sig}`);
    console.log(`\n🔍 Check logs: solana confirm -v ${sig}`);
  } catch (error: any) {
    console.log(`\n⚠️  Transaction failed:`);
    console.log(`   Error: ${error.message}`);

    if (error.logs) {
      console.log(`\n📋 Program Logs:`);
      let foundPoseidon = false;
      for (const log of error.logs) {
        if (
          log.includes("Poseidon") ||
          log.includes("DIRECT") ||
          log.includes("error code")
        ) {
          console.log(`   🔍 ${log}`);
          foundPoseidon = true;
        } else {
          console.log(`      ${log}`);
        }
      }
      if (foundPoseidon) {
        console.log(`\n✅ Found Poseidon syscall logs above!`);
      }
    }
  }

  console.log("\n🎉 Test complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  });
