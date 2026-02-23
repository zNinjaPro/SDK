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
  it("deriveEpochTree matches expected seeds", () => {
    const builder = new TransactionBuilder(
      stubProgram,
      stubPoolConfig,
      stubConnection,
    );
    const epoch = 1n;
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(epoch);
    const [pda, bump] = (builder as any).deriveEpochTree(epoch);
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("epoch_tree"), stubPoolConfig.toBuffer(), epochBytes],
      stubProgram.programId,
    );
    expect(pda.toBase58()).to.equal(expected[0].toBase58());
    expect(bump).to.equal(expected[1]);
  });

  it("deriveEpochLeafChunk computes correct chunk index", () => {
    const builder = new TransactionBuilder(
      stubProgram,
      stubPoolConfig,
      stubConnection,
    );
    const epoch = 2n;
    const leafIndex = 512; // chunkIndex = 512 / 256 = 2
    const [pda] = (builder as any).deriveEpochLeafChunk(epoch, leafIndex);
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(epoch);
    const expected = PublicKey.findProgramAddressSync(
      [
        Buffer.from("leaves"),
        stubPoolConfig.toBuffer(),
        epochBytes,
        new BN(2).toArrayLike(Buffer, "le", 4),
      ],
      stubProgram.programId,
    );
    expect(pda.toBase58()).to.equal(expected[0].toBase58());
  });

  it("deriveNullifierMarker uses epoch and nullifier seeds", () => {
    const builder = new TransactionBuilder(
      stubProgram,
      stubPoolConfig,
      stubConnection,
    );
    const epoch = 3n;
    const nullifier = new Uint8Array(32);
    nullifier.set([0x00, 0x00, 0x00, 0x05], 0);
    const [pda, bump] = (builder as any).deriveNullifierMarker(
      epoch,
      nullifier,
    );
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(epoch);
    const expected = PublicKey.findProgramAddressSync(
      [
        Buffer.from("nullifier"),
        stubPoolConfig.toBuffer(),
        epochBytes,
        Buffer.from(nullifier),
      ],
      stubProgram.programId,
    );
    expect(pda.toBase58()).to.equal(expected[0].toBase58());
    expect(bump).to.equal(expected[1]);
  });
});
