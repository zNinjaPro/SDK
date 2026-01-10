import paramsJson from "./solana_poseidon_params.json";

const BN254_PRIME = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001"
);

type RawPoseidonTable = {
  width: number;
  full_rounds: number;
  partial_rounds: number;
  alpha: number;
  ark: string[];
  mds: string[][];
};

type PoseidonTable = {
  width: number;
  fullRounds: number;
  partialRounds: number;
  alpha: number;
  ark: bigint[];
  mds: bigint[][];
};

const TABLES: Record<number, PoseidonTable> = {};

function hexToBigInt(hex: string): bigint {
  return BigInt("0x" + hex);
}

for (const raw of paramsJson as RawPoseidonTable[]) {
  TABLES[raw.width] = {
    width: raw.width,
    fullRounds: raw.full_rounds,
    partialRounds: raw.partial_rounds,
    alpha: raw.alpha,
    ark: raw.ark.map(hexToBigInt),
    mds: raw.mds.map((row) => row.map(hexToBigInt)),
  };
}

function modPrime(value: bigint): bigint {
  let result = value % BN254_PRIME;
  if (result < 0n) {
    result += BN254_PRIME;
  }
  return result;
}

function addMod(a: bigint, b: bigint): bigint {
  return modPrime(a + b);
}

function mulMod(a: bigint, b: bigint): bigint {
  return modPrime(a * b);
}

function powAlpha(value: bigint, alpha: number): bigint {
  if (alpha === 5) {
    const x2 = mulMod(value, value);
    const x4 = mulMod(x2, x2);
    return mulMod(x4, value);
  }
  let result = 1n;
  let base = modPrime(value);
  let exp = BigInt(alpha);
  while (exp > 0n) {
    if (exp & 1n) {
      result = mulMod(result, base);
    }
    base = mulMod(base, base);
    exp >>= 1n;
  }
  return result;
}

function bytesToField(bytes: Uint8Array): bigint {
  const hex = Buffer.from(bytes).toString("hex") || "0";
  return modPrime(BigInt("0x" + hex));
}

function fieldToBytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function applyMds(state: bigint[], mds: bigint[][]): bigint[] {
  const width = state.length;
  const next = new Array<bigint>(width).fill(0n);
  for (let i = 0; i < width; i++) {
    let acc = 0n;
    for (let j = 0; j < width; j++) {
      acc = addMod(acc, mulMod(state[j], mds[i][j]));
    }
    next[i] = acc;
  }
  return next;
}

function poseidon(inputs: bigint[], params: PoseidonTable): bigint {
  if (inputs.length !== params.width - 1) {
    throw new Error(
      `poseidon width mismatch (inputs=${inputs.length}, width=${params.width})`
    );
  }

  const state = new Array<bigint>(params.width).fill(0n);
  state[0] = 0n; // domain tag
  for (let i = 0; i < inputs.length; i++) {
    state[i + 1] = modPrime(inputs[i]);
  }

  const totalRounds = params.fullRounds + params.partialRounds;
  const halfRounds = params.fullRounds / 2;
  let arkOffset = 0;

  const applyArk = () => {
    for (let i = 0; i < params.width; i++) {
      state[i] = addMod(state[i], params.ark[arkOffset + i]);
    }
    arkOffset += params.width;
  };

  const sboxFull = () => {
    for (let i = 0; i < params.width; i++) {
      state[i] = powAlpha(state[i], params.alpha);
    }
  };

  const sboxPartial = () => {
    state[0] = powAlpha(state[0], params.alpha);
  };

  for (let round = 0; round < halfRounds; round++) {
    applyArk();
    sboxFull();
    const updated = applyMds(state, params.mds);
    for (let i = 0; i < params.width; i++) {
      state[i] = updated[i];
    }
  }

  for (let round = 0; round < params.partialRounds; round++) {
    applyArk();
    sboxPartial();
    const updated = applyMds(state, params.mds);
    for (let i = 0; i < params.width; i++) {
      state[i] = updated[i];
    }
  }

  for (let round = 0; round < halfRounds; round++) {
    applyArk();
    sboxFull();
    const updated = applyMds(state, params.mds);
    for (let i = 0; i < params.width; i++) {
      state[i] = updated[i];
    }
  }

  if (arkOffset !== totalRounds * params.width) {
    throw new Error("poseidon ark length mismatch");
  }

  return modPrime(state[0]);
}

export function poseidonHashBytes(inputs: Uint8Array[]): Uint8Array {
  if (inputs.length < 1 || inputs.length > 3) {
    throw new Error(
      `poseidonHashBytes supports 1-3 inputs, received ${inputs.length}`
    );
  }
  const width = inputs.length + 1;
  const params = TABLES[width];
  if (!params) {
    throw new Error(`No Poseidon parameters for width=${width}`);
  }

  const felts = inputs.map(bytesToField);
  const result = poseidon(felts, params);
  return fieldToBytes(result);
}

export function poseidonHashField(inputs: Uint8Array[]): bigint {
  if (inputs.length < 1 || inputs.length > 3) {
    throw new Error(
      `poseidonHashField supports 1-3 inputs, received ${inputs.length}`
    );
  }
  const width = inputs.length + 1;
  const params = TABLES[width];
  if (!params) {
    throw new Error(`No Poseidon parameters for width=${width}`);
  }

  const felts = inputs.map(bytesToField);
  return poseidon(felts, params);
}
