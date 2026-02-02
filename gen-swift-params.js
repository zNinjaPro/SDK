const params = require("./src/poseidon/solana_poseidon_params.json");

// Generate Swift code for each width
for (const p of params) {
  console.log("// Width " + p.width);
  console.log("table[" + p.width + "] = Parameters(");
  console.log("    width: " + p.width + ",");
  console.log("    fullRounds: " + p.full_rounds + ",");
  console.log("    partialRounds: " + p.partial_rounds + ",");
  console.log("    alpha: " + p.alpha + ",");
  console.log("    ark: [");
  for (let i = 0; i < p.ark.length; i += 4) {
    const chunk = p.ark
      .slice(i, i + 4)
      .map((h) => 'FieldElement("' + h + '", radix: 16)!');
    console.log("        " + chunk.join(", ") + ",");
  }
  console.log("    ],");
  console.log("    mds: [");
  for (const row of p.mds) {
    const cells = row.map((h) => 'FieldElement("' + h + '", radix: 16)!');
    console.log("        [" + cells.join(", ") + "],");
  }
  console.log("    ]");
  console.log(")");
  console.log("");
}
