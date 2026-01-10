import "mocha";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import idl from "../src/idl.json";
import { ShieldedPoolClient } from "../src/client";

// Sequential end-to-end: deposit -> transfer -> withdraw using shared state
// Designed for faster, reliable CI runs and local development.

describe("Shielded Pool E2E Sequential Flow", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const programId = new PublicKey(
    "C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7"
  );

  let payer: Keypair;
  let clientA: ShieldedPoolClient;
  let clientB: ShieldedPoolClient;
  let mint: PublicKey;
  let poolConfig: PublicKey;
  let poolTreePda: PublicKey;
  let vaultAuthorityPda: PublicKey;
  const TRANSFER_TOP_UP = 500_000n;

  const loadVerifierKey = (circuit: "withdraw" | "transfer") => {
    const fs = require("fs");
    const path = require("path");
    const vkPath = path.join(__dirname, "../assets", `${circuit}_vk.json`);
    const payload = JSON.parse(fs.readFileSync(vkPath, "utf8"));

    const ensureBytes32 = (arr: any[], label: string) => {
      if (!Array.isArray(arr) || arr.length !== 32) {
        throw new Error(`${label} must have length 32`);
      }
      return arr.map((v, idx) => {
        if (typeof v !== "number" || v < 0 || v > 255) {
          throw new Error(`${label}[${idx}] must be a byte`);
        }
        return v;
      });
    };

    const normalizeG1 = (point: any[], label: string) => {
      if (!Array.isArray(point) || point.length !== 2) {
        throw new Error(`${label} must have length 2`);
      }
      return [
        ensureBytes32(point[0], `${label}.x`),
        ensureBytes32(point[1], `${label}.y`),
      ];
    };

    const normalizeG2 = (point: any[], label: string) => {
      if (!Array.isArray(point) || point.length !== 4) {
        throw new Error(`${label} must have length 4`);
      }
      return point.map((limb, idx) => ensureBytes32(limb, `${label}[${idx}]`));
    };

    const icPoints = payload.icPoints.map((pt: any, idx: number) =>
      normalizeG1(pt, `icPoints[${idx}]`)
    );

    return {
      vkAlpha: normalizeG1(payload.vkAlpha, "vkAlpha"),
      vkBeta: normalizeG2(payload.vkBeta, "vkBeta"),
      vkGamma: normalizeG2(payload.vkGamma, "vkGamma"),
      vkDelta: normalizeG2(payload.vkDelta, "vkDelta"),
      icPoints,
    } as const;
  };

  const ensureVerifierConfig = async (opts: {
    program: any;
    payer: any;
    circuit: "withdraw" | "transfer";
  }) => {
    const { program, payer, circuit } = opts;
    const seed =
      circuit === "withdraw"
        ? Buffer.from("withdraw")
        : Buffer.from("transfer");
    const variant =
      circuit === "withdraw" ? { withdraw: {} } : { shieldedTransfer: {} };
    const [verifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("verifier"), poolConfig.toBuffer(), seed],
      programId
    );

    const info = await connection.getAccountInfo(verifierPda);
    if (info && info.owner.equals(program.programId)) {
      console.log(
        `${circuit} verifier already initialized:`,
        verifierPda.toBase58()
      );
      return verifierPda;
    }

    const vk = loadVerifierKey(circuit);
    const INIT_CHUNK = 4;
    const APPEND_CHUNK = 4;
    const initIc = vk.icPoints.slice(0, INIT_CHUNK);
    const remaining = vk.icPoints.slice(INIT_CHUNK);

    await (program.methods as any)
      .initializeVerifier(
        variant,
        vk.vkAlpha,
        vk.vkBeta,
        vk.vkGamma,
        vk.vkDelta,
        initIc
      )
      .accounts({
        verifierConfig: verifierPda,
        poolConfig,
        payer: payer.publicKey,
        systemProgram: require("@solana/web3.js").SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    while (remaining.length > 0) {
      const chunk = remaining.splice(0, APPEND_CHUNK);
      await (program.methods as any)
        .appendVerifierIc(variant, chunk)
        .accounts({
          verifierConfig: verifierPda,
          poolConfig,
          authority: payer.publicKey,
        })
        .signers([payer])
        .rpc();
    }

    console.log(`${circuit} verifier initialized:`, verifierPda.toBase58());
    return verifierPda;
  };

  const ensureTransferInputs = async () => {
    if (!clientA) {
      throw new Error("ClientA not initialized");
    }

    let attempts = 0;
    while (clientA.getUnspentNotes().length < 2 && attempts < 3) {
      attempts++;
      console.log(
        `🔁 Transfer prep deposit #${attempts}: funding ${TRANSFER_TOP_UP.toString()} lamports`
      );
      const sig = await clientA.deposit(TRANSFER_TOP_UP);
      await connection.confirmTransaction(sig);
      const target = (await clientA.getBalance()) + TRANSFER_TOP_UP;
      await clientA.waitForBalance(target, 30000);
    }

    if (clientA.getUnspentNotes().length < 2) {
      throw new Error("Unable to prepare two spendable notes for transfer");
    }
  };

  before(async () => {
    // Read payer and mint from setup outputs or env vars
    const fs = require("fs");
    const path = require("path");

    const payerPath =
      process.env.PAYER_PATH ||
      path.join(__dirname, "../test-fixtures/payer.json");
    if (!fs.existsSync(payerPath)) {
      throw new Error(
        `Payer keypair not found at ${payerPath}. Run setup scripts first or set PAYER_PATH env var.`
      );
    }
    const payerSecret: number[] = JSON.parse(
      fs.readFileSync(payerPath, "utf8")
    );
    payer = Keypair.fromSecretKey(Uint8Array.from(payerSecret));

    const mintPath =
      process.env.MINT_PATH ||
      path.join(__dirname, "../test-fixtures/mint_pubkey.txt");
    if (!fs.existsSync(mintPath)) {
      throw new Error(
        `Mint pubkey not found at ${mintPath}. Run setup scripts first or set MINT_PATH env var.`
      );
    }
    const mintStr: string = fs.readFileSync(mintPath, "utf8").trim();
    mint = new PublicKey(mintStr);
    const programId = new PublicKey(
      "C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7"
    );
    const [poolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), mint.toBuffer()],
      programId
    );
    poolConfig = poolConfigPda;
    const [poolTree] = PublicKey.findProgramAddressSync(
      [Buffer.from("tree"), mint.toBuffer()],
      programId
    );
    poolTreePda = poolTree;
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()],
      programId
    );
    vaultAuthorityPda = vaultAuthority;

    // Create token account for payer and mint tokens
    // Ensure payer ATA exists (guard against setup overlap)
    const payerAtaAddr = getAssociatedTokenAddressSync(
      mint,
      payer.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const ataInfo = await connection.getAccountInfo(payerAtaAddr);
    if (!ataInfo) {
      const ix = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerAtaAddr,
        payer.publicKey,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const tx = new Transaction().add(ix);
      await connection.sendTransaction(tx, [payer]);
    }

    // Mint 10M tokens to payer for testing
    await mintTo(
      connection,
      payer,
      mint,
      payerAtaAddr,
      payer,
      10_000_000,
      [],
      {},
      TOKEN_PROGRAM_ID
    );

    // Initialize pool config on-chain if missing
    const { SystemProgram } = require("@solana/web3.js");
    const { AnchorProvider, Program } = require("@coral-xyz/anchor");
    const provider = new AnchorProvider(
      connection,
      {
        publicKey: payer.publicKey,
        signTransaction: async (tx: Transaction | VersionedTransaction) => tx,
        signAllTransactions: async (
          txs: (Transaction | VersionedTransaction)[]
        ) => txs,
      },
      { commitment: "confirmed" }
    );
    const program = new Program(idl as any, provider);
    try {
      await (program.methods as any)
        .initializePool(Buffer.from([]), 20, 16, 256)
        .accounts({
          poolConfig: poolConfig,
          poolTree: poolTreePda,
          vaultAuthority: vaultAuthorityPda,
          mint: mint,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();
    } catch (e) {
      // Ignore if already initialized
    }
    // Ensure first leaf chunk exists
    const [leafChunkPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("leaf"), mint.toBuffer(), Buffer.from([0, 0, 0, 0])],
      programId
    );
    try {
      await (program.account as any).leafChunk.fetch(leafChunkPda);
    } catch {
      try {
        await (program.methods as any)
          .initializeLeafChunk(0)
          .accounts({
            leafChunk: leafChunkPda,
            mint,
            payer: payer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([payer])
          .rpc();
      } catch (e) {
        // ignore
      }
    }

    // Ensure verifiers exist (chunked to avoid anchor JS encode limits)
    await ensureVerifierConfig({ program, payer, circuit: "withdraw" });
    await ensureVerifierConfig({ program, payer, circuit: "transfer" });

    clientA = await ShieldedPoolClient.create({
      connection,
      programId,
      poolConfig,
      payer,
      idl: idl as Idl,
      testMode: true,
    });
    clientB = await ShieldedPoolClient.create({
      connection,
      programId,
      poolConfig,
      payer,
      idl: idl as Idl,
      testMode: true,
    });
  });

  it("deposit", async function () {
    this.timeout(60000);
    const amount = 1_000_000n;
    const sig = await clientA.deposit(amount);
    expect(sig).to.be.a("string");
    await connection.confirmTransaction(sig);
    // bounded wait for balance to reflect (includes pending in testMode)
    const ok = await clientA.waitForBalance(amount, 30000);
    expect(ok).to.equal(true);
    const bal = await clientA.getBalance();
    expect(bal).to.equal(amount);
  });

  it("transfer", async function () {
    this.timeout(120000);
    await ensureTransferInputs();
    const amount = 500_000n;
    const startingA = await clientA.getBalance();
    const startingB = await clientB.getBalance();
    const expectedA = startingA - amount;
    const expectedB = startingB + amount;
    const addressB = clientB.getShieldedAddress();
    const sig = await clientA.transfer(amount, addressB);
    expect(sig).to.be.a("string");
    await connection.confirmTransaction(sig);
    // In test mode the scanner is disabled; manually promote the recipient note for clientB.
    const outputs = clientA.getLastOutputNotes();
    if (outputs && outputs.length > 0) {
      const poolTree = await (clientA as any).program.account.poolTree.fetch(
        poolTreePda
      );
      const nextIndex = Number(poolTree.nextIndex);
      const recipientNote = { ...outputs[0] };
      recipientNote.leafIndex = nextIndex - outputs.length;
      (clientB as any).noteManager.addNote(recipientNote);
    }
    // bounded waits for balances
    await clientA.waitForBalance(expectedA, 30000);
    await clientB.waitForBalance(expectedB, 30000);
    const balA = await clientA.getBalance();
    const balB = await clientB.getBalance();
    expect(balA).to.equal(expectedA);
    expect(balB).to.equal(expectedB);
  });

  it("withdraw", async function () {
    this.timeout(120000);
    const minLamports = 120_000_000;
    const payerBalance = await connection.getBalance(payer.publicKey);
    if (payerBalance < minLamports) {
      const delta = minLamports - payerBalance;
      console.log(
        `⬆️  Airdropping payer to ${minLamports} lamports (was ${payerBalance})`
      );
      const sig = await connection.requestAirdrop(payer.publicKey, delta);
      await connection.confirmTransaction(sig);
    }
    // Use payer as recipient so they can sign the transaction
    const recipient = payer.publicKey;
    // Withdraw the full deposited amount
    const sig = await clientA.withdraw(1_000_000n, recipient);
    expect(sig).to.be.a("string");
    await connection.confirmTransaction(sig);
    await clientA.waitForBalance(0n, 30000);
    const balA = await clientA.getBalance();
    expect(balA).to.equal(0n);
  });
});
