// @ts-nocheck
// Variant comparison for Poseidon zero hash chain
describe("Poseidon variant comparison", () => {
  it("logs zero hash chain across variants", async () => {
    const lib = await import("circomlibjs");
    const variants = [
      ["wasm", lib.buildPoseidon],
      ["opt", lib.buildPoseidonOpt],
      ["ref", lib.buildPoseidonReference],
    ];
    const ZERO_CONST = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "829a01fae4f8e22b1b4ca5ad5b54a5834ee098a77b735bd57431a7656d29a108",
      "50b4feaeb79752e57b182c6207a6984ebf5e6dc9d7e56c42889666509843b718",
      "f56fdd59a3fd78fbc066b31c20a0dc02d2fab63095664e87f2b2f0819e1cc22d",
    ];
    for (const [name, builder] of variants) {
      const poseidon = await builder();
      const F = poseidon.F;
      let prev = F.e(0);
      const chain = ["0".padStart(64, "0")];
      for (let i = 1; i < ZERO_CONST.length; i++) {
        const out = poseidon([prev, prev]);
        const hex = F.toString(out).replace(/^0x/, "").padStart(64, "0");
        chain.push(hex);
        prev = out;
      }
      for (let i = 0; i < chain.length; i++) {
        const expected = ZERO_CONST[i];
        const actual = chain[i];
        console.log(`[variant ${name}] level=${i} expected=${expected.slice(0,8)} actual=${actual.slice(0,8)} match=${expected===actual}`);
      }
    }
  });
});
