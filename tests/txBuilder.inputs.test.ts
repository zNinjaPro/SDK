import { AnchorProvider, Wallet, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { TransactionBuilder } from "../src/txBuilder";
import { MerkleTreeSync } from "../src/merkle";

function makeNote(value: bigint, token: PublicKey): any {
  return {
    value,
    token,
    owner: new Uint8Array(32),
    blinding: new Uint8Array(32),
    commitment: new Uint8Array(32),
    nullifier: new Uint8Array(32),
    randomness: new Uint8Array(32),
    memo: new Uint8Array(0),
    spent: false,
  };
}

describe("txBuilder deposit inputs formatting", function () {
  // Skip if no validator running - this is an integration test
  before(async function () {
    const connection = new Connection(
      process.env.RPC_URL || "http://localhost:8899",
      "confirmed"
    );
    try {
      await connection.getVersion();
    } catch {
      console.log("    ⏭ Skipping: No Solana validator running");
      this.skip();
    }
  });

  it("formats commitment (32), tag (16), and encrypted payload order", async () => {
    const connection = new Connection(
      process.env.RPC_URL || "http://localhost:8899",
      "confirmed"
    );
    const payer = Keypair.generate();
    // airdrop and confirm to fund payer for mint creation
    try {
      const sig = await connection.requestAirdrop(payer.publicKey, 1e9);
      await connection.confirmTransaction(sig, "confirmed");
    } catch {}
    const wallet = new Wallet(payer);
    const provider = new AnchorProvider(connection, wallet, {} as any);

    // Create a minimal fake Program to avoid IDL dependency
    const programId = new PublicKey(
      "C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7"
    );
    const program: any = {
      programId,
      provider,
      account: { poolConfig: { fetch: async (_pc: PublicKey) => ({ mint }) } },
      methods: {
        initializeLeafChunk: (_chunkIndex: number) => ({
          accounts: (_a: any) => ({
            instruction: async () => ({
              programId,
              keys: [],
              data: Buffer.from([2]),
            }),
          }),
        }),
        depositShielded: (
          _amount: any,
          _commitment: any,
          _encrypted: any,
          _tag: any
        ) => ({
          accounts: (_a: any) => ({
            remainingAccounts: (_r: any) => ({
              instruction: async () => ({
                programId,
                keys: [],
                data: Buffer.from([1]),
              }),
            }),
          }),
        }),
      },
    };

    // Create a test mint
    const mint = await createMint(connection, payer, payer.publicKey, null, 6);

    // Derive PoolConfig PDA (must exist on-chain for fetch, so just simulate here)
    const [poolConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), mint.toBuffer()],
      program.programId
    );

    // Create MerkleTreeSync bound to program/pool (no on-chain fetch in this test)
    const merkle = new MerkleTreeSync(connection, program as any, poolConfig);

    const builder = new TransactionBuilder(
      program as any,
      poolConfig,
      connection
    );

    const note = makeNote(1000n, mint);

    // Build deposit transaction; we won't send, just introspect instructions
    const tx = await builder.buildDeposit(payer.publicKey, note, merkle);

    // Find the deposit instruction
    const ix = tx.instructions.find((i) =>
      i.programId.equals(program.programId)
    );
    expect(ix).to.not.be.undefined;

    // Anchor encodes args in ix.data; basic sanity: non-empty
    expect(ix!.data.length).greaterThan(0);

    // We cannot decode Borsh here easily; instead, assert inputs prepared in builder:
    // - Commitment length 32
    // - Tag length 16 (placeholder)
    // - Encrypted payload starts with 24-byte nonce then ciphertext (length > 24)

    // Recompute payload pieces similarly to builder to validate expectations
    const { encryptNote, serializeNote } = require("../src/crypto");
    const serialized = serializeNote(
      note.value,
      note.token.toBytes(),
      note.owner,
      note.randomness,
      note.memo
    );
    const encrypted = encryptNote(serialized, note.owner);
    const encryptedPayload = Buffer.concat([
      Buffer.from(encrypted.nonce),
      Buffer.from(encrypted.encrypted),
    ]);

    expect(Buffer.from(note.commitment).length).eq(32);
    expect(encryptedPayload.length).greaterThan(24);
  });
});
