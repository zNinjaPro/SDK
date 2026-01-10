import { describe, it } from "mocha";
import { expect } from "chai";
import { computeCommitment, computeNullifier } from "../src/crypto";

function randomBytes(len: number): Uint8Array {
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = (Math.random() * 256) | 0;
  return a;
}

describe("crypto commitments", () => {
  it("computeCommitment returns 32 bytes and is deterministic", async () => {
    const value = 123456789n;
    const owner = randomBytes(32);
    const randomness = randomBytes(32);

    const c1 = await computeCommitment(value, owner, randomness);
    const c2 = await computeCommitment(value, owner, randomness);

    expect(c1).to.be.instanceOf(Uint8Array);
    expect(c1.length).to.equal(32);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).to.equal(true);
  });

  it("computeCommitment changes when inputs change", async () => {
    const value = 42n;
    const owner = randomBytes(32);
    const randomness = randomBytes(32);

    const base = await computeCommitment(value, owner, randomness);
    const changedValue = await computeCommitment(43n, owner, randomness);
    const changedOwner = await computeCommitment(
      value,
      randomBytes(32),
      randomness
    );
    const changedRand = await computeCommitment(value, owner, randomBytes(32));

    expect(Buffer.from(base).equals(Buffer.from(changedValue))).to.equal(false);
    expect(Buffer.from(base).equals(Buffer.from(changedOwner))).to.equal(false);
    expect(Buffer.from(base).equals(Buffer.from(changedRand))).to.equal(false);
  });

  it("computeNullifier returns 32 bytes and is deterministic", async () => {
    const commitment = randomBytes(32);
    const nullifierKey = randomBytes(32);

    const n1 = await computeNullifier(commitment, nullifierKey);
    const n2 = await computeNullifier(commitment, nullifierKey);

    expect(n1).to.be.instanceOf(Uint8Array);
    expect(n1.length).to.equal(32);
    expect(Buffer.from(n1).equals(Buffer.from(n2))).to.equal(true);
  });

  it("computeNullifier changes with inputs", async () => {
    const commitment = randomBytes(32);
    const nullifierKey = randomBytes(32);

    const base = await computeNullifier(commitment, nullifierKey);
    const changedCommit = await computeNullifier(randomBytes(32), nullifierKey);
    const changedKey = await computeNullifier(commitment, randomBytes(32));

    expect(Buffer.from(base).equals(Buffer.from(changedCommit))).to.equal(
      false
    );
    expect(Buffer.from(base).equals(Buffer.from(changedKey))).to.equal(false);
  });
});
