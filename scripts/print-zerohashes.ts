import { poseidonHash, poseidonHashSync } from "../src/crypto";

async function main() {
  // Ensure poseidon is initialized
  await poseidonHash([new Uint8Array(32)]);
  const zeros: Uint8Array[] = [];
  zeros[0] = new Uint8Array(32);
  for (let i = 1; i <= 5; i++) {
    // zeroHashes[i] = Poseidon(zeroHashes[i-1], zeroHashes[i-1])
    const h = poseidonHashSync([zeros[i - 1], zeros[i - 1]]);
    zeros[i] = h;
  }
  for (let i = 0; i <= 5; i++) {
    console.log(`${i}: ${Buffer.from(zeros[i]).toString("hex")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
