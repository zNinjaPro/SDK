import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { buildWithdrawWitnessSignals } from "../src/prover";
import type { WithdrawInputs } from "../src/prover";

function dummyInputs(): WithdrawInputs {
  const recipient = PublicKey.unique();
  const siblings: Uint8Array[] = [];
  for (let i = 0; i < 4; i++) {
    const buf = Buffer.alloc(32, i + 1);
    siblings.push(new Uint8Array(buf));
  }
  const leafIndex = 5; // arbitrary index
  return {
    note: {
      value: 1000n,
      token: PublicKey.default,
      owner: new Uint8Array(32),
      blinding: new Uint8Array(32),
      commitment: new Uint8Array(32),
      nullifier: new Uint8Array(32),
      randomness: new Uint8Array(32),
      spent: false,
      leafIndex,
      memo: new Uint8Array(0),
    } as any,
    spendingKeys: {
      seed: new Uint8Array(32),
      spendingKey: new Uint8Array(32),
      viewingKey: new Uint8Array(32),
      nullifierKey: new Uint8Array(32),
      shieldedAddress: new Uint8Array(32),
    },
    merkleProof: {
      siblings,
      leafIndex,
      leaf: new Uint8Array(32),
      root: new Uint8Array(32),
    } as any,
    merkleRoot: new Uint8Array(Buffer.alloc(32, 9)),
    recipient,
    amount: 250n,
  };
}

describe("Prover merkle order selection", () => {
  it("uses bottom-up ordering by default (correct for circuit)", () => {
    const inputs = dummyInputs();
    const signals = buildWithdrawWitnessSignals(inputs);
    const path = signals.pathElements as string[];
    expect(path).to.have.length(4);
    // Bottom-up: first element is leaf-level sibling (buffer filled with 1)
    const firstHex = path[0] as any;
    const lastHex = path[path.length - 1] as any;
    expect(firstHex).to.equal(
      BigInt("0x" + Buffer.alloc(32, 1).toString("hex")).toString()
    );
    expect(lastHex).to.equal(
      BigInt("0x" + Buffer.alloc(32, 4).toString("hex")).toString()
    );
  });

  it("honors top-down when specified", () => {
    const inputs = dummyInputs();
    const signals = buildWithdrawWitnessSignals(inputs, {
      merkleOrder: "top-down",
    });
    const path = signals.pathElements as string[];
    expect(path).to.have.length(4);
    // Top-down (reversed): first element is root-level sibling (buffer filled with 4)
    const firstHex = path[0] as any;
    const lastHex = path[path.length - 1] as any;
    expect(firstHex).to.equal(
      BigInt("0x" + Buffer.alloc(32, 4).toString("hex")).toString()
    );
    expect(lastHex).to.equal(
      BigInt("0x" + Buffer.alloc(32, 1).toString("hex")).toString()
    );
  });
});
