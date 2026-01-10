import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TransactionBuilder } from "../src/txBuilder";

// Minimal stubs to satisfy constructor
const stubProgram: any = {
  programId: new PublicKey("C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7"),
  provider: { connection: {} },
  account: {},
};
const stubPoolConfig = new PublicKey("11111111111111111111111111111111");
const stubConnection: any = {};

describe("PDA derivation", () => {
  it("deriveLeafChunk requires mint and matches seeds", () => {
    const builder = new TransactionBuilder(
      stubProgram,
      stubPoolConfig,
      stubConnection
    );
    const mint = new PublicKey("So11111111111111111111111111111111111111112");
    const leafIndex = 512; // chunkIndex = 2
    const [pda, bump] = (builder as any).deriveLeafChunk(leafIndex, mint);
    const expected = PublicKey.findProgramAddressSync(
      [
        Buffer.from("leaf"),
        mint.toBuffer(),
        new BN(2).toArrayLike(Buffer, "be", 4),
      ],
      stubProgram.programId
    );
    expect(pda.toBase58()).to.equal(expected[0].toBase58());
    expect(bump).to.equal(expected[1]);
  });

  it("deriveNullifierChunk uses first 4 bytes BE for index", () => {
    const builder = new TransactionBuilder(
      stubProgram,
      stubPoolConfig,
      stubConnection
    );
    const nullifier = new Uint8Array(32);
    // Set first 4 bytes to 0x00000005 => chunkIndex = 5
    nullifier.set([0x00, 0x00, 0x00, 0x05], 0);
    const { address, bump, index } = (builder as any).deriveNullifierChunk(
      nullifier,
      256
    );
    const expected = PublicKey.findProgramAddressSync(
      [
        Buffer.from("nullifier"),
        stubPoolConfig.toBuffer(),
        new BN(5).toArrayLike(Buffer, "be", 4),
      ],
      stubProgram.programId
    );
    expect(address.toBase58()).to.equal(expected[0].toBase58());
    expect(bump).to.equal(expected[1]);
    expect(index).to.equal(5);
  });

  it("deriveNullifierChunk modulo distributes across chunk space", () => {
    const builder = new TransactionBuilder(
      stubProgram,
      stubPoolConfig,
      stubConnection
    );
    const nullifier = new Uint8Array(32);
    nullifier.set([0xff, 0xff, 0xff, 0xff], 0);
    const chunkSize = 1024;
    const maxChunks = Math.floor(0xffffffff / chunkSize);
    const expectedIndex = 0xffffffff % maxChunks;
    const { index } = (builder as any).deriveNullifierChunk(
      nullifier,
      chunkSize
    );
    expect(index).to.equal(expectedIndex);
  });
});
