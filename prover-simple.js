// Simple prover wrapper for testing
const snarkjs = require('snarkjs');
const fs = require('fs');

/**
 * Generate a Groth16 proof using snarkjs
 */
async function generateProof(wasmPath, zkeyPath, inputs) {
  // snarkjs expects all signals as strings
  const inputsFormatted = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (Array.isArray(value)) {
      inputsFormatted[key] = value.map(v => String(v));
    } else {
      inputsFormatted[key] = String(value);
    }
  }
  
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputsFormatted,
    wasmPath,
    zkeyPath
  );
  
  return { proof, publicSignals };
}

/**
 * Verify a Groth16 proof
 */
async function verifyProof(verificationKeyPath, publicSignals, proof) {
  const vKey = JSON.parse(fs.readFileSync(verificationKeyPath, 'utf-8'));
  const result = await snarkjs.groth16.verify(vKey, publicSignals, proof);
  return result;
}

module.exports = {
  generateProof,
  verifyProof
};
