// Groth16 prover scaffold using snarkjs
// Provides a minimal interface to generate proofs and public inputs.

import type { PublicKey } from "@solana/web3.js";
import type { Note, MerkleProof, SpendingKeys } from "./types";
import { poseidonHashSync } from "./crypto";

const BN254_PRIME_HEX =
  "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
const BN254_PRIME = BigInt("0x" + BN254_PRIME_HEX);
const BN254_PRIME_BYTES = Buffer.from(BN254_PRIME_HEX, "hex");

function reduceBytesToField(bytes: Uint8Array): number[] {
  const hex = Buffer.from(bytes).toString("hex");
  let value = BigInt("0x" + hex);
  value = value % BN254_PRIME;
  const fieldBytes = Buffer.from(value.toString(16).padStart(64, "0"), "hex");
  return Array.from(fieldBytes);
}

export type Groth16Proof = {
  a: number[];
  b: number[];
  c: number[];
};

export type ProverArtifacts = {
  wasmPath: string; // path to circuit wasm
  zkeyPath: string; // path to proving key
};

export type ProverOptions = {
  merkleOrder?: "top-down" | "bottom-up"; // controls pathElements/indices ordering
  attachPathAliases?: boolean; // when true, include pathElements/pathIndices for tests
};

export type WithdrawInputs = {
  note: Note;
  spendingKeys: SpendingKeys;
  merkleProof: MerkleProof;
  merkleRoot: Uint8Array;
  recipient: PublicKey;
  amount: bigint;
  epoch: bigint; // Epoch being spent from
  leafIndex: number; // Leaf index in epoch tree
  poolConfig?: PublicKey; // Solana-specific public input
  txAnchor?: Uint8Array;
  chainId?: Uint8Array;
};

export type TransferInputs = {
  inputNotes: [Note, Note];
  spendingKeys: SpendingKeys;
  outputNotes: [Note, Note];
  merkleProofs: [MerkleProof, MerkleProof];
  merkleRoot: Uint8Array;
  epoch: bigint; // Epoch being spent from
  inputLeafIndices: [number, number]; // Leaf indices for input notes
  txAnchor?: Uint8Array;
  poolConfig?: PublicKey;
  chainId?: Uint8Array;
};

export type RenewInputs = {
  /** Old note being renewed/migrated */
  oldNote: Note;
  /** New note being created in current epoch */
  newNote: Note;
  spendingKeys: SpendingKeys;
  merkleProof: MerkleProof;
  /** Merkle root for old epoch */
  merkleRoot: Uint8Array;
  oldEpoch: bigint;
  newEpoch: bigint;
  oldLeafIndex: number;
  poolConfig?: PublicKey;
  txAnchor?: Uint8Array;
  chainId?: Uint8Array;
};

export type ProverOutput = {
  proof: Groth16Proof;
  publicInputs: number[][]; // encoded for Anchor/Borsh consumption
};

// Dynamic import to avoid bundling snarkjs unless needed
declare const require: any;
async function loadSnarkJS(): Promise<any> {
  try {
    if (typeof require !== "undefined") {
      return require("snarkjs");
    }
  } catch (_) {}
  return null;
}

// Lightweight artifacts loader with defaults and existence checks
export async function loadArtifacts(options?: {
  baseDir?: string;
  wasm?: string;
  zkey?: string;
}): Promise<ProverArtifacts> {
  const path = require("path");
  const fs = require("fs");
  const baseDir = options?.baseDir || path.join(__dirname, "../artifacts");
  const wasmPath = options?.wasm || path.join(baseDir, "circuit.wasm");
  const zkeyPath = options?.zkey || path.join(baseDir, "circuit.zkey");
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM not found at ${wasmPath}`);
  }
  if (!fs.existsSync(zkeyPath)) {
    throw new Error(`ZKey not found at ${zkeyPath}`);
  }
  return { wasmPath, zkeyPath };
}

function toWitnessSignalsWithdraw(
  inputs: WithdrawInputs,
  options?: ProverOptions,
): Record<string, any> {
  // Build raw (bottom-up) index bits from leaf index
  const rawIndices: number[] = [];
  let w = inputs.merkleProof.leafIndex;
  for (let i = 0; i < inputs.merkleProof.siblings.length; i++) {
    rawIndices.push(w % 2);
    w = Math.floor(w / 2);
  }
  const leftIsOne = process.env.ZK_MERKLE_LEFT_IS_ONE === "1";
  const normalize = (arr: number[]) =>
    leftIsOne ? arr.map((b) => (b === 0 ? 1 : 0)) : arr;

  // Deterministic ordering with optional override via env var
  // Precedence: explicit options override env, then default
  const order =
    options?.merkleOrder || process.env.ZK_MERKLE_ORDER || "bottom-up";
  let chosenProof = inputs.merkleProof.siblings.slice();
  let chosenIndices = normalize(rawIndices.slice());
  if (order === "top-down") {
    chosenProof = chosenProof.reverse();
    chosenIndices = normalize(rawIndices.slice().reverse());
  }

  // Optional per-level trace
  if (process.env.ZK_TRACE_MERKLE === "1") {
    try {
      let cur = inputs.note.commitment;
      console.log(
        `[trace] withdraw merkle start leaf=${Buffer.from(cur).toString("hex").slice(0, 16)} order=${order}`,
      );
      for (let i = 0; i < chosenProof.length; i++) {
        const sib = chosenProof[i];
        const bit = chosenIndices[i];
        const before = Buffer.from(cur).toString("hex").slice(0, 8);
        const sibHex = Buffer.from(sib).toString("hex").slice(0, 8);
        cur =
          bit === 0
            ? poseidonHashSync([cur, sib])
            : poseidonHashSync([sib, cur]);
        console.log(
          `[trace] level=${i} bit=${bit} cur=${before} sib=${sibHex} -> ${Buffer.from(cur).toString("hex").slice(0, 8)}`,
        );
      }
      const finalHex = Buffer.from(cur).toString("hex");
      const targetHex = Buffer.from(inputs.merkleRoot).toString("hex");
      console.log(
        `[trace] withdraw merkle final=${finalHex.slice(0, 16)} target=${targetHex.slice(0, 16)} match=${finalHex === targetHex}`,
      );
    } catch (e) {
      console.warn("[trace] withdraw merkle trace failed", e);
    }
  }

  // Helper to convert Buffer to decimal BigInt string
  const bufferToBigInt = (buf: Uint8Array): string => {
    let hex = Buffer.from(buf).toString("hex");
    if (hex.length === 0) return "0";
    return BigInt("0x" + hex).toString();
  };

  // Convert PublicKey to decimal BigInt string (from bytes)
  const pubkeyToBigInt = (pubkey: any): string => {
    return bufferToBigInt(pubkey.toBytes());
  };

  const siblingsBE = chosenProof.map((s) => bufferToBigInt(s));

  // Compute epoch-aware nullifier = Poseidon(commitment, nullifierKey, epoch, leafIndex)
  const epochBuf = Buffer.alloc(32);
  let epochVal = inputs.epoch;
  for (let i = 0; i < 8; i++) {
    epochBuf[i] = Number(epochVal & 0xffn);
    epochVal >>= 8n;
  }

  const leafIndexBuf = Buffer.alloc(32);
  leafIndexBuf.writeUInt32LE(inputs.leafIndex, 0);

  const nullifierBytes = poseidonHashSync([
    Buffer.from(inputs.note.commitment),
    Buffer.from(inputs.spendingKeys.nullifierKey),
    epochBuf,
    leafIndexBuf,
  ]);
  const nullifierStr = bufferToBigInt(nullifierBytes);

  // Debug trace
  if (process.env.ZK_TRACE_MERKLE === "1") {
    try {
      const altNullifierBytes = poseidonHashSync([
        Buffer.from(inputs.note.commitment),
        Buffer.from(inputs.spendingKeys.nullifierKey),
        leafIndexBuf,
      ]);
      console.log(
        `[trace] nullifier base=${Buffer.from(nullifierBytes)
          .toString("hex")
          .slice(0, 16)} alt=${Buffer.from(altNullifierBytes)
          .toString("hex")
          .slice(0, 16)}`,
      );
    } catch (e) {
      console.warn("[trace] nullifier alt compute failed", e);
    }
  }

  const txAnchorBytes = inputs.txAnchor ?? new Uint8Array(32);
  const txAnchorStr = bufferToBigInt(txAnchorBytes);

  const poolIdBytes = inputs.poolConfig
    ? Uint8Array.from(reduceBytesToField(inputs.poolConfig.toBytes()))
    : new Uint8Array(32);
  const poolIdStr = bufferToBigInt(poolIdBytes);

  const chainIdBytes = inputs.chainId ?? new Uint8Array(32);
  const chainIdStr = bufferToBigInt(chainIdBytes);

  // Match exact circuit signal names from withdraw.circom (epoch-aware)
  const signals: Record<string, any> = {
    // Public inputs
    merkleRoot: bufferToBigInt(inputs.merkleRoot),
    nullifier: nullifierStr,
    amount: inputs.amount.toString(),
    epoch: inputs.epoch.toString(),
    txAnchor: txAnchorStr,
    poolId: poolIdStr,
    chainId: chainIdStr,

    // Private inputs (exact circuit names)
    value: inputs.note.value.toString(),
    recipient: pubkeyToBigInt(inputs.recipient),
    owner: bufferToBigInt(inputs.note.owner),
    randomness: bufferToBigInt(inputs.note.randomness),
    nullifierKey: bufferToBigInt(inputs.spendingKeys.nullifierKey),
    leafIndex: inputs.leafIndex.toString(),
    merkleProof: siblingsBE,
    merkleIndices: chosenIndices,
  };

  // Back-compat aliases for test harnesses that expect circom-style naming
  if (options?.attachPathAliases) {
    signals.pathElements = siblingsBE;
    signals.pathIndices = chosenIndices;
  }

  return signals;
}

function toWitnessSignalsTransfer(inputs: TransferInputs): Record<string, any> {
  const pubkeyToBigInt = (pubkey: any): string =>
    bufferToBigInt(pubkey.toBytes());
  const leftIsOne = process.env.ZK_MERKLE_LEFT_IS_ONE === "1";
  const normalize = (arr: number[]) =>
    leftIsOne ? arr.map((b) => (b === 0 ? 1 : 0)) : arr;
  const order = process.env.ZK_MERKLE_ORDER || "bottom-up"; // transfer does not expose per-call override currently

  const buildIndices = (leafIndex: number, depth: number) => {
    const out: number[] = [];
    let w = leafIndex;
    for (let i = 0; i < depth; i++) {
      out.push(w % 2);
      w = Math.floor(w / 2);
    }
    return out;
  };

  const makeProof = (commitment: Uint8Array, mp: MerkleProof) => {
    let proof = mp.siblings.slice();
    let indices = buildIndices(mp.leafIndex, mp.siblings.length);
    if (order === "top-down") {
      proof = proof.reverse();
      indices = indices.reverse();
    }
    indices = normalize(indices);
    if (process.env.ZK_TRACE_MERKLE === "1") {
      try {
        let cur = commitment;
        console.log(
          `[trace] transfer merkle start leaf=${Buffer.from(cur).toString("hex").slice(0, 16)} order=${order}`,
        );
        for (let i = 0; i < proof.length; i++) {
          const sib = proof[i];
          const bit = indices[i];
          const before = Buffer.from(cur).toString("hex").slice(0, 8);
          const sibHex = Buffer.from(sib).toString("hex").slice(0, 8);
          cur =
            bit === 0
              ? poseidonHashSync([cur, sib])
              : poseidonHashSync([sib, cur]);
          console.log(
            `[trace] level=${i} bit=${bit} cur=${before} sib=${sibHex} -> ${Buffer.from(cur).toString("hex").slice(0, 8)}`,
          );
        }
        const finalHex = Buffer.from(cur).toString("hex");
        const targetHex = Buffer.from(mp.root).toString("hex");
        console.log(
          `[trace] transfer merkle final=${finalHex.slice(0, 16)} target=${targetHex.slice(0, 16)} match=${finalHex === targetHex}`,
        );
      } catch (e) {
        console.warn("[trace] transfer merkle trace failed", e);
      }
    }
    return { proof, indices };
  };

  const p1 = makeProof(inputs.inputNotes[0].commitment, inputs.merkleProofs[0]);
  const p2 = makeProof(inputs.inputNotes[1].commitment, inputs.merkleProofs[1]);

  // Compute epoch-aware nullifiers for inputs: Poseidon(commitment, nullifierKey, epoch, leafIndex)
  const epochBuf = Buffer.alloc(32);
  let epochVal = inputs.epoch;
  for (let i = 0; i < 8; i++) {
    epochBuf[i] = Number(epochVal & 0xffn);
    epochVal >>= 8n;
  }

  const leafIndex1Buf = Buffer.alloc(32);
  leafIndex1Buf.writeUInt32LE(inputs.inputLeafIndices[0], 0);

  const leafIndex2Buf = Buffer.alloc(32);
  leafIndex2Buf.writeUInt32LE(inputs.inputLeafIndices[1], 0);

  const nullifier1Bytes = poseidonHashSync([
    Buffer.from(inputs.inputNotes[0].commitment),
    Buffer.from(inputs.spendingKeys.nullifierKey),
    epochBuf,
    leafIndex1Buf,
  ]);
  const nullifier2Bytes = poseidonHashSync([
    Buffer.from(inputs.inputNotes[1].commitment),
    Buffer.from(inputs.spendingKeys.nullifierKey),
    epochBuf,
    leafIndex2Buf,
  ]);
  const bufferToBigInt = (buf: Uint8Array): string => {
    let hex = Buffer.from(buf).toString("hex");
    if (hex.length === 0) return "0";
    return BigInt("0x" + hex).toString();
  };
  const nullifier1Str = BigInt(
    "0x" + Buffer.from(nullifier1Bytes).toString("hex"),
  ).toString();
  const nullifier2Str = BigInt(
    "0x" + Buffer.from(nullifier2Bytes).toString("hex"),
  ).toString();

  const txAnchorBytes = inputs.txAnchor ?? new Uint8Array(32);
  const poolIdBytes = inputs.poolConfig
    ? Uint8Array.from(reduceBytesToField(inputs.poolConfig.toBytes()))
    : new Uint8Array(32);
  const chainIdBytes = inputs.chainId ?? new Uint8Array(32);

  const txAnchorStr = bufferToBigInt(txAnchorBytes);
  const poolIdStr = bufferToBigInt(poolIdBytes);
  const chainIdStr = bufferToBigInt(chainIdBytes);

  // Match exact circuit signal names from transfer.circom (epoch-aware)
  return {
    // Public inputs
    merkleRoot: BigInt(
      "0x" + Buffer.from(inputs.merkleRoot).toString("hex"),
    ).toString(),
    nullifier1: nullifier1Str,
    nullifier2: nullifier2Str,
    outputCommitment1: BigInt(
      "0x" + Buffer.from(inputs.outputNotes[0].commitment).toString("hex"),
    ).toString(),
    outputCommitment2: BigInt(
      "0x" + Buffer.from(inputs.outputNotes[1].commitment).toString("hex"),
    ).toString(),
    epoch: inputs.epoch.toString(),
    txAnchor: txAnchorStr,
    poolId: poolIdStr,
    chainId: chainIdStr,

    // Private inputs - Input notes (exact circuit names)
    inputValue1: inputs.inputNotes[0].value.toString(),
    inputOwner1: bufferToBigInt(inputs.inputNotes[0].owner),
    inputRandomness1: bufferToBigInt(inputs.inputNotes[0].randomness),
    inputValue2: inputs.inputNotes[1].value.toString(),
    inputOwner2: bufferToBigInt(inputs.inputNotes[1].owner),
    inputRandomness2: bufferToBigInt(inputs.inputNotes[1].randomness),
    nullifierKey: bufferToBigInt(inputs.spendingKeys.nullifierKey),
    inputLeafIndex1: inputs.inputLeafIndices[0].toString(),
    inputLeafIndex2: inputs.inputLeafIndices[1].toString(),

    // Private inputs - Merkle proofs (exact circuit names)
    merkleProof1: p1.proof.map((s) => bufferToBigInt(s)),
    merkleIndices1: p1.indices,
    merkleProof2: p2.proof.map((s) => bufferToBigInt(s)),
    merkleIndices2: p2.indices,

    // Private inputs - Output notes (exact circuit names)
    outputValue1: inputs.outputNotes[0].value.toString(),
    outputOwner1: bufferToBigInt(inputs.outputNotes[0].owner),
    outputRandomness1: bufferToBigInt(inputs.outputNotes[0].randomness),
    outputValue2: inputs.outputNotes[1].value.toString(),
    outputOwner2: bufferToBigInt(inputs.outputNotes[1].owner),
    outputRandomness2: bufferToBigInt(inputs.outputNotes[1].randomness),
  };
}

export async function proveWithdraw(
  artifacts: ProverArtifacts,
  inputs: WithdrawInputs,
  options?: ProverOptions,
): Promise<ProverOutput> {
  const debugTrace = process.env.ZK_TRACE_PROVER === "1";
  const t0 = Date.now();
  if (debugTrace) {
    console.log("[trace] withdraw inputs", {
      merkleRoot: Buffer.from(inputs.merkleRoot).toString("hex").slice(0, 16),
      leafIndex: inputs.merkleProof.leafIndex,
      siblings: inputs.merkleProof.siblings.length,
      value: inputs.note.value.toString(),
      commitment: Buffer.from(inputs.note.commitment)
        .toString("hex")
        .slice(0, 16),
    });
  }
  const txAnchorBytes = inputs.txAnchor ?? new Uint8Array(32);
  const chainIdBytes = inputs.chainId ?? new Uint8Array(32);
  const poolIdBytes = inputs.poolConfig
    ? Uint8Array.from(reduceBytesToField(inputs.poolConfig.toBytes()))
    : new Uint8Array(32);
  if (process.env.MOCK_PROOFS === "1") {
    const empty: Groth16Proof = {
      a: new Array(64).fill(0),
      b: new Array(128).fill(0),
      c: new Array(64).fill(0),
    };
    // Compute nullifier = Poseidon(commitment, nullifierKey)
    const nullifier = poseidonHashSync([
      Buffer.from(inputs.note.commitment),
      Buffer.from(inputs.spendingKeys.nullifierKey),
    ]);
    // Format amount as 32-byte array (8-byte u64 padded with zeros)
    const amountBuf = Buffer.alloc(32);
    amountBuf.writeBigUInt64LE(inputs.amount, 0);
    const txAnchor = Array.from(txAnchorBytes);
    const poolId = Array.from(poolIdBytes);
    const chainId = Array.from(chainIdBytes);

    // Public inputs order: root | nullifiers[n_in] | value_out | tx_anchor | pool_id | chain_id
    const publicInputs = [
      Array.from(inputs.merkleRoot), // root
      Array.from(nullifier), // nullifier (n_in=1)
      Array.from(amountBuf), // value_out
      txAnchor, // tx_anchor
      poolId, // pool_id
      chainId, // chain_id
    ];
    console.log("⚑ MOCK_PROOFS enabled: skipping witness+proving");
    return { proof: empty, publicInputs };
  }
  const snarkjs = await loadSnarkJS();
  if (!snarkjs) {
    // Fallback: return zeroed proof
    const empty: Groth16Proof = {
      a: new Array(64).fill(0),
      b: new Array(128).fill(0),
      c: new Array(64).fill(0),
    };
    const amountBuf = Buffer.alloc(32);
    amountBuf.writeBigUInt64LE(inputs.amount, 0);
    // Return placeholder public inputs
    const publicInputs = [
      Array.from(inputs.merkleRoot),
      new Array(32).fill(0), // nullifier placeholder
      Array.from(amountBuf),
      Array.from(txAnchorBytes),
      Array.from(poolIdBytes),
      Array.from(chainIdBytes),
    ];
    return { proof: empty, publicInputs };
  }

  const tSignals0 = Date.now();
  const signals = toWitnessSignalsWithdraw(inputs, options);
  const tSignals1 = Date.now();
  console.log(`⏱️ build-signals(ms): ${tSignals1 - tSignals0}`);

  // Sanity: compute root from proof and note commitment using SDK Poseidon
  try {
    // Check commitment consistency
    const valueBuf = Buffer.alloc(32);
    valueBuf.write(
      BigInt(inputs.note.value).toString(16).padStart(64, "0"),
      "hex",
    );
    const ownerBuf = Buffer.from(inputs.note.owner);
    const randBuf = Buffer.from(inputs.note.randomness);
    const computedLeaf = poseidonHashSync([valueBuf, ownerBuf, randBuf]);
    const computedLeafHex = Buffer.from(computedLeaf).toString("hex");
    const noteLeafHex = Buffer.from(inputs.note.commitment).toString("hex");
    if (computedLeafHex !== noteLeafHex) {
      console.warn(
        "⚠️ Commitment mismatch: computed != note.commitment",
        computedLeafHex.slice(0, 16) + "...",
        noteLeafHex.slice(0, 16) + "...",
      );
    } else {
      console.log("✅ Commitment matches note.commitment");
    }

    let cur = inputs.note.commitment;
    let idx = inputs.merkleProof.leafIndex;
    for (const sib of inputs.merkleProof.siblings) {
      if (idx % 2 === 0) {
        cur = poseidonHashSync([cur, sib]);
      } else {
        cur = poseidonHashSync([sib, cur]);
      }
      idx = Math.floor(idx / 2);
    }
    const sdkRootHex = Buffer.from(cur).toString("hex");
    const providedRootHex = Buffer.from(inputs.merkleRoot).toString("hex");
    if (sdkRootHex !== providedRootHex) {
      console.warn(
        "⚠️ SDK-computed root != provided merkleRoot:",
        sdkRootHex.slice(0, 16) + "...",
        providedRootHex.slice(0, 16) + "...",
      );
    } else {
      console.log("✅ SDK-computed root matches provided merkleRoot");
    }
  } catch (e) {
    console.warn("⚠️ Failed to compute SDK root for sanity check:", e);
  }

  // Debug: Log witness signals
  console.log("🔍 Witness signals:");
  console.log("   merkleRoot:", signals.merkleRoot.slice(0, 20) + "...");
  console.log("   recipient:", signals.recipient.slice(0, 20) + "...");
  console.log("   amount:", signals.amount);
  console.log("   value:", signals.value);
  console.log("   merkleProof length:", signals.merkleProof.length);
  console.log(
    "   merkleProof[0]:",
    signals.merkleProof[0]?.slice(0, 20) + "...",
  );
  console.log(
    "   merkleProof[1]:",
    signals.merkleProof[1]?.slice(0, 20) + "...",
  );
  console.log("   merkleIndices:", signals.merkleIndices);

  // Extra sanity: recompute root using witness strings passed to the circuit
  try {
    const toBuf = (decStr: string): Uint8Array => {
      const hex = BigInt(decStr).toString(16).padStart(64, "0");
      return new Uint8Array(Buffer.from(hex, "hex"));
    };
    let cur2 = toBuf(
      BigInt(
        "0x" + Buffer.from(inputs.note.commitment).toString("hex"),
      ).toString(),
    );
    for (let i = 0; i < signals.merkleProof.length; i++) {
      const sib = toBuf(signals.merkleProof[i]);
      const s = Number(signals.merkleIndices[i]);
      if (s === 0) {
        cur2 = poseidonHashSync([cur2, sib]);
      } else {
        cur2 = poseidonHashSync([sib, cur2]);
      }
    }
    const witnessRootHex = Buffer.from(cur2).toString("hex");
    const providedRootHex2 = BigInt(signals.merkleRoot)
      .toString(16)
      .padStart(64, "0");
    if (witnessRootHex !== providedRootHex2) {
      console.warn(
        "⚠️ Witness-derived root != provided merkleRoot:",
        witnessRootHex.slice(0, 16) + "...",
        providedRootHex2.slice(0, 16) + "...",
      );
    } else {
      console.log("✅ Witness-derived root matches provided merkleRoot");
    }
  } catch (e) {
    console.warn("⚠️ Failed witness-root recompute:", e);
  }

  const { groth16 } = snarkjs;
  const tWitness0 = Date.now();
  let proof: any;
  let publicSignals: string[];
  const useRapidsnark = process.env.USE_RAPIDSNARK === "1";
  if (useRapidsnark) {
    const path = require("path");
    const fs = require("fs");
    const os = require("os");
    const { spawnSync } = require("child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "withdraw-"));
    const wtnsPath = path.join(tmpDir, "witness.wtns");
    const proofJsonPath = path.join(tmpDir, "proof.json");
    const publicJsonPath = path.join(tmpDir, "public.json");
    await snarkjs.wtns.calculate(signals, artifacts.wasmPath, wtnsPath);
    const bin = process.env.RAPIDSNARK_BIN || "rapidsnark";
    // quick availability check
    const which = require("child_process").spawnSync("which", [bin], {
      encoding: "utf8",
    });
    if (which.status !== 0 || !which.stdout) {
      console.error(
        `rapidsnark binary not found: ${bin}. Set RAPIDSNARK_BIN or install rapidsnark.`,
      );
      console.error(
        "macOS hint: brew tap geometryxyz/snark && brew install rapidsnark (or build from source)",
      );
      throw new Error("rapidsnark not available on PATH");
    }
    const rs = require("child_process").spawnSync(
      bin,
      [artifacts.zkeyPath, wtnsPath, proofJsonPath, publicJsonPath],
      { stdio: "inherit" },
    );
    if (rs.status !== 0) {
      throw new Error("rapidsnark failed to generate proof");
    }
    const proofJson = JSON.parse(fs.readFileSync(proofJsonPath, "utf8"));
    const pubJson = JSON.parse(fs.readFileSync(publicJsonPath, "utf8"));
    proof = proofJson.proof;
    publicSignals = pubJson;
  } else {
    const out = await groth16.fullProve(
      signals,
      artifacts.wasmPath,
      artifacts.zkeyPath,
    );
    proof = out.proof;
    publicSignals = out.publicSignals;
  }
  const tWitness1 = Date.now();
  console.log(
    `⏱️ witness+prove(ms): ${tWitness1 - tWitness0} (rapidsnark=${useRapidsnark})`,
  );

  // Format proof for Solana (256 bytes total)
  const proofBytes = new Uint8Array(256);
  let offset = 0;

  // pi_a (64 bytes: 2 field elements)
  for (const val of proof.pi_a.slice(0, 2)) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  // pi_b (128 bytes: 4 field elements in specific order for BN254)
  const pi_b_ordered = [
    proof.pi_b[0][1],
    proof.pi_b[0][0],
    proof.pi_b[1][1],
    proof.pi_b[1][0],
  ];
  for (const val of pi_b_ordered) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  // pi_c (64 bytes: 2 field elements)
  for (const val of proof.pi_c.slice(0, 2)) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  const formatted: Groth16Proof = {
    a: Array.from(proofBytes.slice(0, 64)),
    b: Array.from(proofBytes.slice(64, 192)),
    c: Array.from(proofBytes.slice(192, 256)),
  };

  // Extract public signals from circuit output
  // withdraw circuit default: [merkleRoot, nullifier, valueOut, txAnchor, poolId, chainId]
  const circuitPublicInputs = publicSignals.map((sig: string) => {
    const hex = BigInt(sig).toString(16).padStart(64, "0");
    return Array.from(Buffer.from(hex, "hex"));
  });

  if (circuitPublicInputs.length !== 6) {
    throw new Error(
      `withdraw circuit expected 6 public inputs, got ${circuitPublicInputs.length}`,
    );
  }

  const labels = [
    "merkleRoot",
    "nullifier",
    "value_out",
    "tx_anchor",
    "pool_id",
    "chain_id",
  ];
  labels.forEach((label, idx) => {
    if (circuitPublicInputs[idx].length !== 32) {
      throw new Error(`${label} must be 32 bytes`);
    }
  });

  // Optional: enforce inputs lie within BN254 field
  const inField = (x: Uint8Array) => {
    for (let i = 0; i < 32; i++) {
      if (x[i] < BN254_PRIME_BYTES[i]) return true;
      if (x[i] > BN254_PRIME_BYTES[i]) return false;
    }
    return false;
  };
  circuitPublicInputs.forEach((pi, idx) => {
    const ok = inField(Uint8Array.from(pi));
    if (!ok) {
      console.warn(`⚠️ public input not in BN254 field: ${labels[idx]}`);
    }
  });

  const publicInputs = circuitPublicInputs;
  const t1 = Date.now();
  console.log(`⏱️ withdraw total(ms): ${t1 - t0}`);
  return { proof: formatted, publicInputs };
}

// Test helper: expose withdraw witness signal mapping without requiring snarkjs
export function buildWithdrawWitnessSignals(
  inputs: WithdrawInputs,
  options?: ProverOptions,
): Record<string, any> {
  return toWitnessSignalsWithdraw(inputs, {
    attachPathAliases: true,
    ...options,
  });
}

export async function proveTransfer(
  artifacts: ProverArtifacts,
  inputs: TransferInputs,
  options?: ProverOptions,
): Promise<ProverOutput> {
  const debugTrace = process.env.ZK_TRACE_PROVER === "1";
  const canonicalEnv = process.env.ZK_TRANSFER_CANONICAL_PIS ?? "1";
  const expectCanonical = canonicalEnv !== "0";
  if (!expectCanonical) {
    console.warn(
      "Legacy transfer public inputs are deprecated; forcing canonical layout with tx_anchor/pool_id/chain_id",
    );
  }
  if (!inputs.poolConfig) {
    throw new Error(
      "poolConfig is required to encode canonical transfer public inputs (pool_id)",
    );
  }
  const txAnchorBytes = inputs.txAnchor ?? new Uint8Array(32);
  const chainIdBytes = inputs.chainId ?? new Uint8Array(32);
  const poolIdBytes = Uint8Array.from(
    reduceBytesToField(inputs.poolConfig.toBytes()),
  );
  const t0 = Date.now();
  if (debugTrace) {
    const summarizeNote = (note: any, proof: MerkleProof) => ({
      value: note.value.toString(),
      leafIndex: proof?.leafIndex,
      siblings: proof?.siblings?.length ?? 0,
      commitment: Buffer.from(note.commitment).toString("hex").slice(0, 16),
    });
    const order = process.env.ZK_MERKLE_ORDER || "bottom-up";
    console.log("[trace] transfer inputs", {
      merkleRoot: Buffer.from(inputs.merkleRoot).toString("hex").slice(0, 16),
      order,
      input0: summarizeNote(inputs.inputNotes[0], inputs.merkleProofs[0]),
      input1: summarizeNote(inputs.inputNotes[1], inputs.merkleProofs[1]),
      output0: Buffer.from(inputs.outputNotes[0].commitment)
        .toString("hex")
        .slice(0, 16),
      output1: Buffer.from(inputs.outputNotes[1].commitment)
        .toString("hex")
        .slice(0, 16),
    });
  }
  if (process.env.MOCK_PROOFS === "1") {
    const empty: Groth16Proof = {
      a: new Array(64).fill(0),
      b: new Array(128).fill(0),
      c: new Array(64).fill(0),
    };
    const mutInputs = [
      Array.from(inputs.merkleRoot),
      new Array(32).fill(0),
      new Array(32).fill(0),
      Array.from(inputs.outputNotes[0].commitment),
      Array.from(inputs.outputNotes[1].commitment),
    ];
    mutInputs.push(
      Array.from(txAnchorBytes),
      Array.from(poolIdBytes),
      Array.from(chainIdBytes),
    );
    const publicInputs = mutInputs;
    console.log("⚑ MOCK_PROOFS enabled: skipping witness+proving");
    return { proof: empty, publicInputs };
  }
  const snarkjs = await loadSnarkJS();
  if (!snarkjs) {
    // Fallback: return zeroed proof
    const empty: Groth16Proof = {
      a: new Array(64).fill(0),
      b: new Array(128).fill(0),
      c: new Array(64).fill(0),
    };
    // Return placeholder public inputs
    const mutInputs = [
      Array.from(inputs.merkleRoot),
      new Array(32).fill(0), // nullifier1 placeholder
      new Array(32).fill(0), // nullifier2 placeholder
      Array.from(inputs.outputNotes[0].commitment),
      Array.from(inputs.outputNotes[1].commitment),
    ];
    mutInputs.push(
      Array.from(txAnchorBytes),
      Array.from(poolIdBytes),
      Array.from(chainIdBytes),
    );
    const publicInputs = mutInputs;
    return { proof: empty, publicInputs };
  }

  const tSignals0 = Date.now();
  const signals = toWitnessSignalsTransfer(inputs);
  const tSignals1 = Date.now();
  console.log(`⏱️ build-signals(ms): ${tSignals1 - tSignals0}`);
  const { groth16 } = snarkjs;
  const tWitness0 = Date.now();
  let proof: any;
  let publicSignals: string[];
  const useRapidsnark = process.env.USE_RAPIDSNARK === "1";
  if (useRapidsnark) {
    const path = require("path");
    const fs = require("fs");
    const os = require("os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-"));
    const wtnsPath = path.join(tmpDir, "witness.wtns");
    const proofJsonPath = path.join(tmpDir, "proof.json");
    const publicJsonPath = path.join(tmpDir, "public.json");
    await snarkjs.wtns.calculate(signals, artifacts.wasmPath, wtnsPath);
    const bin = process.env.RAPIDSNARK_BIN || "rapidsnark";
    const which = require("child_process").spawnSync("which", [bin], {
      encoding: "utf8",
    });
    if (which.status !== 0 || !which.stdout) {
      console.error(
        `rapidsnark binary not found: ${bin}. Set RAPIDSNARK_BIN or install rapidsnark.`,
      );
      console.error(
        "macOS hint: brew tap geometryxyz/snark && brew install rapidsnark (or build from source)",
      );
      throw new Error("rapidsnark not available on PATH");
    }
    const rs = require("child_process").spawnSync(
      bin,
      [artifacts.zkeyPath, wtnsPath, proofJsonPath, publicJsonPath],
      { stdio: "inherit" },
    );
    if (rs.status !== 0) {
      throw new Error("rapidsnark failed to generate proof");
    }
    const proofJson = JSON.parse(fs.readFileSync(proofJsonPath, "utf8"));
    const pubJson = JSON.parse(fs.readFileSync(publicJsonPath, "utf8"));
    proof = proofJson.proof;
    publicSignals = pubJson;
  } else {
    const out = await groth16.fullProve(
      signals,
      artifacts.wasmPath,
      artifacts.zkeyPath,
    );
    proof = out.proof;
    publicSignals = out.publicSignals;
  }
  const tWitness1 = Date.now();
  console.log(
    `⏱️ witness+prove(ms): ${tWitness1 - tWitness0} (rapidsnark=${useRapidsnark})`,
  );

  // Format proof for Solana (256 bytes total)
  const proofBytes = new Uint8Array(256);
  let offset = 0;

  // pi_a (64 bytes)
  for (const val of proof.pi_a.slice(0, 2)) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  // pi_b (128 bytes)
  const pi_b_ordered = [
    proof.pi_b[0][1],
    proof.pi_b[0][0],
    proof.pi_b[1][1],
    proof.pi_b[1][0],
  ];
  for (const val of pi_b_ordered) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  // pi_c (64 bytes)
  for (const val of proof.pi_c.slice(0, 2)) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  const formatted: Groth16Proof = {
    a: Array.from(proofBytes.slice(0, 64)),
    b: Array.from(proofBytes.slice(64, 192)),
    c: Array.from(proofBytes.slice(192, 256)),
  };

  // Extract public inputs from circuit output
  // Canonical circuit: [root, nullifier1, nullifier2, cm1, cm2, tx_anchor, pool_id, chain_id]
  const publicInputs = publicSignals.map((sig: string) => {
    const hex = BigInt(sig).toString(16).padStart(64, "0");
    return Array.from(Buffer.from(hex, "hex"));
  });

  if (publicInputs.length !== 8) {
    throw new Error(
      `transfer circuit expected 8 canonical public inputs, got ${publicInputs.length}`,
    );
  }

  const labels = [
    "merkleRoot",
    "nullifier1",
    "nullifier2",
    "outputCommitment1",
    "outputCommitment2",
    "tx_anchor",
    "pool_id",
    "chain_id",
  ];
  labels.forEach((label, idx) => {
    if (publicInputs[idx].length !== 32) {
      throw new Error(`${label} must be 32 bytes`);
    }
  });

  const t1 = Date.now();
  console.log(`⏱️ transfer total(ms): ${t1 - t0}`);
  return { proof: formatted, publicInputs };
}

/**
 * Build witness signals for renew circuit
 */
function toWitnessSignalsRenew(
  inputs: RenewInputs,
  options?: ProverOptions,
): Record<string, any> {
  const bufferToBigInt = (buf: Uint8Array): string => {
    let hex = Buffer.from(buf).toString("hex");
    if (hex.length === 0) return "0";
    return BigInt("0x" + hex).toString();
  };

  // Build merkle proof path
  const leftIsOne = process.env.ZK_MERKLE_LEFT_IS_ONE === "1";
  const normalize = (arr: number[]) =>
    leftIsOne ? arr.map((b) => (b === 0 ? 1 : 0)) : arr;
  const order =
    options?.merkleOrder || process.env.ZK_MERKLE_ORDER || "bottom-up";

  const rawIndices: number[] = [];
  let w = inputs.merkleProof.leafIndex;
  for (let i = 0; i < inputs.merkleProof.siblings.length; i++) {
    rawIndices.push(w % 2);
    w = Math.floor(w / 2);
  }

  let chosenProof = inputs.merkleProof.siblings.slice();
  let chosenIndices = normalize(rawIndices.slice());
  if (order === "top-down") {
    chosenProof = chosenProof.reverse();
    chosenIndices = normalize(rawIndices.slice().reverse());
  }

  const siblingsBE = chosenProof.map((s) => bufferToBigInt(s));

  // Compute epoch-aware nullifier for old note
  const oldEpochBuf = Buffer.alloc(32);
  let oldEpochVal = inputs.oldEpoch;
  for (let i = 0; i < 8; i++) {
    oldEpochBuf[i] = Number(oldEpochVal & 0xffn);
    oldEpochVal >>= 8n;
  }

  const leafIndexBuf = Buffer.alloc(32);
  leafIndexBuf.writeUInt32LE(inputs.oldLeafIndex, 0);

  const nullifierBytes = poseidonHashSync([
    Buffer.from(inputs.oldNote.commitment),
    Buffer.from(inputs.spendingKeys.nullifierKey),
    oldEpochBuf,
    leafIndexBuf,
  ]);
  const nullifierStr = bufferToBigInt(nullifierBytes);

  const txAnchorBytes = inputs.txAnchor ?? new Uint8Array(32);
  const poolIdBytes = inputs.poolConfig
    ? Uint8Array.from(reduceBytesToField(inputs.poolConfig.toBytes()))
    : new Uint8Array(32);
  const chainIdBytes = inputs.chainId ?? new Uint8Array(32);

  // Match exact circuit signal names from renew.circom
  return {
    // Public inputs
    oldRoot: bufferToBigInt(inputs.merkleRoot),
    nullifier: nullifierStr,
    newCommitment: bufferToBigInt(inputs.newNote.commitment),
    oldEpoch: inputs.oldEpoch.toString(),
    newEpoch: inputs.newEpoch.toString(),
    txAnchor: bufferToBigInt(txAnchorBytes),
    poolId: bufferToBigInt(poolIdBytes),
    chainId: bufferToBigInt(chainIdBytes),

    // Private inputs
    value: inputs.oldNote.value.toString(),
    owner: bufferToBigInt(inputs.oldNote.owner),
    oldRandomness: bufferToBigInt(inputs.oldNote.randomness),
    newRandomness: bufferToBigInt(inputs.newNote.randomness),
    nullifierKey: bufferToBigInt(inputs.spendingKeys.nullifierKey),
    leafIndex: inputs.oldLeafIndex.toString(),
    merkleProof: siblingsBE,
    merkleIndices: chosenIndices,
  };
}

/**
 * Generate a Groth16 proof for renew circuit
 */
export async function proveRenew(
  artifacts: ProverArtifacts,
  inputs: RenewInputs,
  options?: ProverOptions,
): Promise<ProverOutput> {
  const debugTrace = process.env.ZK_TRACE_PROVER === "1";
  const t0 = Date.now();

  if (debugTrace) {
    console.log("[trace] renew inputs", {
      oldRoot: Buffer.from(inputs.merkleRoot).toString("hex").slice(0, 16),
      oldEpoch: inputs.oldEpoch.toString(),
      newEpoch: inputs.newEpoch.toString(),
      leafIndex: inputs.oldLeafIndex,
      value: inputs.oldNote.value.toString(),
    });
  }

  const txAnchorBytes = inputs.txAnchor ?? new Uint8Array(32);
  const chainIdBytes = inputs.chainId ?? new Uint8Array(32);
  const poolIdBytes = inputs.poolConfig
    ? Uint8Array.from(reduceBytesToField(inputs.poolConfig.toBytes()))
    : new Uint8Array(32);

  if (process.env.MOCK_PROOFS === "1") {
    const empty: Groth16Proof = {
      a: new Array(64).fill(0),
      b: new Array(128).fill(0),
      c: new Array(64).fill(0),
    };

    const oldEpochBuf = Buffer.alloc(32);
    let oldEpochVal = inputs.oldEpoch;
    for (let i = 0; i < 8; i++) {
      oldEpochBuf[i] = Number(oldEpochVal & 0xffn);
      oldEpochVal >>= 8n;
    }

    const leafIndexBuf = Buffer.alloc(32);
    leafIndexBuf.writeUInt32LE(inputs.oldLeafIndex, 0);

    const nullifier = poseidonHashSync([
      Buffer.from(inputs.oldNote.commitment),
      Buffer.from(inputs.spendingKeys.nullifierKey),
      oldEpochBuf,
      leafIndexBuf,
    ]);

    const newEpochBuf = Buffer.alloc(32);
    let newEpochVal = inputs.newEpoch;
    for (let i = 0; i < 8; i++) {
      newEpochBuf[i] = Number(newEpochVal & 0xffn);
      newEpochVal >>= 8n;
    }

    const publicInputs = [
      Array.from(inputs.merkleRoot),
      Array.from(nullifier),
      Array.from(inputs.newNote.commitment),
      Array.from(oldEpochBuf),
      Array.from(newEpochBuf),
      Array.from(txAnchorBytes),
      Array.from(poolIdBytes),
      Array.from(chainIdBytes),
    ];

    console.log("⚑ MOCK_PROOFS enabled: skipping witness+proving for renew");
    return { proof: empty, publicInputs };
  }

  const snarkjs = await loadSnarkJS();
  if (!snarkjs) {
    throw new Error("snarkjs not available for renew proof generation");
  }

  const tSignals0 = Date.now();
  const signals = toWitnessSignalsRenew(inputs, options);
  const tSignals1 = Date.now();
  console.log(`⏱️ renew build-signals(ms): ${tSignals1 - tSignals0}`);

  const tProve0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    signals,
    artifacts.wasmPath,
    artifacts.zkeyPath,
  );
  const tProve1 = Date.now();
  console.log(`⏱️ renew prove(ms): ${tProve1 - tProve0}`);

  // Convert proof to bytes format
  const proofBytes = new Uint8Array(256);
  let offset = 0;

  // pi_a (64 bytes)
  for (const val of proof.pi_a.slice(0, 2)) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  // pi_b (128 bytes) - note the swapped order for BN254
  const pi_b_ordered = [
    proof.pi_b[0][1],
    proof.pi_b[0][0],
    proof.pi_b[1][1],
    proof.pi_b[1][0],
  ];
  for (const val of pi_b_ordered) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  // pi_c (64 bytes)
  for (const val of proof.pi_c.slice(0, 2)) {
    const hex = BigInt(val).toString(16).padStart(64, "0");
    const bytes = Buffer.from(hex, "hex");
    proofBytes.set(bytes, offset);
    offset += 32;
  }

  const formatted: Groth16Proof = {
    a: Array.from(proofBytes.slice(0, 64)),
    b: Array.from(proofBytes.slice(64, 192)),
    c: Array.from(proofBytes.slice(192, 256)),
  };

  // Extract public inputs
  const publicInputs = publicSignals.map((sig: string) => {
    const hex = BigInt(sig).toString(16).padStart(64, "0");
    return Array.from(Buffer.from(hex, "hex"));
  });

  const t1 = Date.now();
  console.log(`⏱️ renew total(ms): ${t1 - t0}`);
  return { proof: formatted, publicInputs };
}
