// Centralized SDK configuration
import path from "path";

// Default paths to circuit artifacts (relative to SDK root)
const CIRCUITS_DIR = path.join(__dirname, "..", "circuits");

export const PROVER_ARTIFACTS = {
  withdraw: {
    wasmPath:
      process.env.WITHDRAW_WASM_PATH ||
      path.join(CIRCUITS_DIR, "withdraw.wasm"),
    zkeyPath:
      process.env.WITHDRAW_ZKEY_PATH ||
      path.join(CIRCUITS_DIR, "withdraw_final.zkey"),
  },
  transfer: {
    wasmPath:
      process.env.TRANSFER_WASM_PATH ||
      path.join(CIRCUITS_DIR, "transfer.wasm"),
    zkeyPath:
      process.env.TRANSFER_ZKEY_PATH ||
      path.join(CIRCUITS_DIR, "transfer_final.zkey"),
  },
};

export type ProverArtifactsEntry = typeof PROVER_ARTIFACTS.withdraw;
