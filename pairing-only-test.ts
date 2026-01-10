import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

const idlPath = process.env.IDL_PATH || path.join(__dirname, "src/idl.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
const programId = new PublicKey("C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7");

async function main() {
  console.log("🧪 Minimal Pairing Syscall Test\n");
  const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
  const connection = new Connection(RPC_URL, "confirmed");
  const walletPath =
    process.env.WALLET || path.join(__dirname, "test-fixtures/wallet.json");
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const provider = new AnchorProvider(connection, new Wallet(kp), {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);

  // Prepare a dummy 4-pairing input (768 bytes) for on-chain verifier
  // We'll call a lightweight method we add that executes `verify_alt_bn128_pairing` directly.
  const pairingInput = Buffer.alloc(768, 1);

  try {
    const ix = await (program.methods as any)
      .verifyPairing(pairingInput)
      .accounts({
        authority: kp.publicKey,
      })
      .instruction();
    const sig = await provider.sendAndConfirm(
      new (await import("@solana/web3.js")).Transaction().add(ix)
    );
    console.log(`✅ Sent verifyPairing tx: ${sig}`);
    console.log(`   Check logs: solana confirm -v ${sig}`);
  } catch (e: any) {
    console.log("⚠️ verifyPairing failed:", e.message);
    if (e.logs) {
      for (const log of e.logs) console.log("   ", log);
    }
  }
}

main();
