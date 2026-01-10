const anchor = require("@coral-xyz/anchor");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

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
  const rootHistory = parseInt(process.env.ROOT_HISTORY || "100", 10);
  const nullifierChunkSize = parseInt(
    process.env.NULLIFIER_CHUNK_SIZE || "64",
    10
  );

  if (!fs.existsSync(walletPath))
    throw new Error(`Wallet not found: ${walletPath}`);
  const secret = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  if (!fs.existsSync(idlPath)) throw new Error(`IDL not found: ${idlPath}`);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const connection = new Connection(rpc, "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new anchor.Program(idl, provider);

  // Create or use existing test mint (use regular SPL Token, not Token-2022)
  console.log("Creating test mint...");
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    9, // decimals
    undefined, // keypair
    undefined, // confirmOptions
    TOKEN_PROGRAM_ID // explicitly use standard SPL Token program
  );
  console.log(`Mint created: ${mint.toBase58()}`);

  // Derive PDAs
  const [poolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.toBuffer()],
    programId
  );
  const [poolTreePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("tree"), mint.toBuffer()],
    programId
  );
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()],
    programId
  );

  const acc = await connection.getAccountInfo(poolConfigPda);
  if (acc) {
    console.log(`POOL_CONFIG already exists: ${poolConfigPda.toBase58()}`);
    return;
  }

  console.log("Initializing pool...");
  const configSeed = Buffer.from([]);
  const txSig = await program.methods
    .initializePool(configSeed, merkleDepth, rootHistory, nullifierChunkSize)
    .accounts({
      poolConfig: poolConfigPda,
      poolTree: poolTreePda,
      vaultAuthority: vaultAuthorityPda,
      mint: mint,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer])
    .rpc();

  console.log(`✅ Pool initialized. Tx: ${txSig}`);
  console.log(`MINT=${mint.toBase58()}`);
  console.log(`POOL_CONFIG=${poolConfigPda.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
