// Quick test to see if proof generation works
const snarkjs = require("snarkjs");
const path = require("path");

async function test() {
  console.log("Testing proof generation...");

  const wasmPath = path.join(__dirname, "circuits/withdraw.wasm");
  const zkeyPath = path.join(__dirname, "circuits/withdraw_final.zkey");

  console.log("WASM:", wasmPath);
  console.log("ZKEY:", zkeyPath);

  const input = {
    merkleRoot: "12345678901234567890123456789012",
    nullifier: "0",
    recipient: "99999999999999999999999999999999",
    amount: "1000000",
    value: "5000000",
    owner: "11111111111111111111111111111111",
    randomness: "22222222222222222222222222222222",
    nullifierKey: "33333333333333333333333333333333",
    merkleProof: Array(20).fill([0]),
    merkleIndices: Array(20).fill(0),
  };

  console.log("Generating proof...");
  const start = Date.now();

  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      wasmPath,
      zkeyPath
    );

    const elapsed = Date.now() - start;
    console.log(`✅ Proof generated in ${elapsed}ms`);
    console.log("Public signals:", publicSignals);
  } catch (error) {
    console.error("❌ Error:", error.message);
    throw error;
  }
}

test()
  .then(() => {
    console.log("Done!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });
