/**
 * Sparse Merkle tree implementation for shielded pool
 * Reconstructs tree from on-chain LeafChunk PDAs
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MERKLE_DEPTH, LEAF_CHUNK_SIZE, MerkleProof } from "./types";
import { poseidonHashSync, ensurePoseidon } from "./crypto";

// Helper to hash two nodes using Poseidon (matches on-chain program and circuit)
function hashNodes(left: Uint8Array, right: Uint8Array): Uint8Array {
  return poseidonHashSync([left, right]);
}

/**
 * Merkle tree manager for the shielded pool
 */
export class MerkleTree {
  private leaves: Map<number, Uint8Array> = new Map();
  private zeroHashes: Uint8Array[] = [];
  private roots: Uint8Array[] = [];
  private nextIndex: number = 0;
  private zeroHashesComputed: boolean = false;

  constructor() {
    // Don't compute zero hashes yet - wait for Poseidon to be initialized
  }

  /**
   * Compute zero hashes for empty tree
   * zeroHashes[i] = Hash(zeroHashes[i-1], zeroHashes[i-1])
   */
  private computeZeroHashes(): void {
    if (this.zeroHashesComputed) return;

    // Allow caching zero hashes across runs to avoid recomputation in tests
    const useCache = process.env.ZK_CACHE_ZERO_HASHES === "1";
    const path = require("path");
    const fs = require("fs");
    const cacheFile = path.join(__dirname, "../assets/zero_hashes.json");
    if (useCache && fs.existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        this.zeroHashes = raw.map(
          (hex: string) => new Uint8Array(Buffer.from(hex, "hex"))
        );
        if (this.zeroHashes.length >= MERKLE_DEPTH + 1) {
          this.zeroHashesComputed = true;
          return;
        }
      } catch (e) {
        console.warn("Zero hash cache load failed, regenerating", e);
      }
    }

    // Default to the on-chain zero hash constants so client roots always match
    // the program unless explicitly overridden (set ZK_USE_ONCHAIN_ZEROS=0).
    const onChainFlag = process.env.ZK_USE_ONCHAIN_ZEROS;
    const useOnChainConstants =
      onChainFlag === undefined || onChainFlag === "1";
    if (useOnChainConstants) {
      const ONCHAIN = [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "829a01fae4f8e22b1b4ca5ad5b54a5834ee098a77b735bd57431a7656d29a108",
        "50b4feaeb79752e57b182c6207a6984ebf5e6dc9d7e56c42889666509843b718",
        "f56fdd59a3fd78fbc066b31c20a0dc02d2fab63095664e87f2b2f0819e1cc22d",
        "6e58ea3b67b9d42ee340b22fcc79b87a8ce47a7a6d0404cb1d63fc16c0b95220",
        "2584ba0c4ab469e2d5d3c1e11b328a043f5cea0d1108539eec8c046b13bde31f",
        "c67b4a68ca203df0335e6fb6247a82963e5059ffa18e1af2cfb98581fea5aa00",
        "4dd60b46e179bc509022284c4ba37c9992b2e1b4f3261480dc18c2b346a9a01c",
        "4dc7695fdeb763e585c1fa1d235c42d196917acd8867cdcf20b5fca7594a3412",
        "363f05d4d2cca7b40d87546181acd14f1d21f9535c3d13c45dfbb32afaa3c516",
        "beab72b4311584a18d104dbf69ef69690840fd9fc40263b58122052478f08117",
        "e4f44df15cd40969d4f1bea1110ea66ba4e275ec3839ae243d72cd22f01f0d21",
        "b159372c0d35324c8f5fe23ff3fdf89901218d3d544eafaa115c08f2ddf6e205",
        "ed736191e841bed7a395136f9fa614613debec5500f7ad6ef4d347ebdfd2dc03",
        "cc5180e4ec4b20348de932af63145a84262d19dff70a7021004f908a3bbb0a14",
        "794af051ca62f7b8442b34b6a502719aa31a49ba3abeda8186008fbb48f1331d",
        "173f6cd904333bd65eff5ab013cdf034628a1a60c21e7cb9713b478716bddf15",
        "1869e4f7fb4386284462475025833eb5dfeed358e6599fb341e5ddcaa077021f",
        "ec6e0d9aabf53541d3d255ea5822dcd43ead632aa2aebb0ba8f0ca3394b88e22",
        "33fbba7f378f62141641f322f3f05d40161059883aeedbbd89f09388e3c70812",
      ];
      this.zeroHashes = new Array(MERKLE_DEPTH + 1);
      for (let i = 0; i <= MERKLE_DEPTH; i++) {
        this.zeroHashes[i] =
          i < ONCHAIN.length
            ? new Uint8Array(Buffer.from(ONCHAIN[i], "hex"))
            : new Uint8Array(32);
      }
      this.zeroHashesComputed = true;
      // Persist cache for faster subsequent runs if enabled
      if (useCache) {
        try {
          const out = this.zeroHashes.map((u) =>
            Buffer.from(u).toString("hex")
          );
          fs.mkdirSync(path.join(__dirname, "../assets"), { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify(out));
        } catch (e) {
          console.warn("Zero hash cache save failed", e);
        }
      }
      return;
    }

    // Dynamic generation with circomlib Poseidon (circuit matching)
    try {
      ensurePoseidon();
      this.zeroHashes = new Array(MERKLE_DEPTH + 1);
      this.zeroHashes[0] = new Uint8Array(32); // field element 0
      for (let i = 1; i <= MERKLE_DEPTH; i++) {
        const prev = this.zeroHashes[i - 1];
        this.zeroHashes[i] = hashNodes(prev, prev) as Uint8Array;
      }
      this.zeroHashesComputed = true;
      if (useCache) {
        try {
          const out = this.zeroHashes.map((u) =>
            Buffer.from(u).toString("hex")
          );
          fs.mkdirSync(path.join(__dirname, "../assets"), { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify(out));
        } catch (e) {
          console.warn("Zero hash cache save failed", e);
        }
      }
    } catch (e) {
      console.error(
        "Failed dynamic zero hash generation, falling back to zeros",
        e
      );
      this.zeroHashes = new Array(MERKLE_DEPTH + 1)
        .fill(null)
        .map(() => new Uint8Array(32));
      this.zeroHashesComputed = true;
    }
  } /**
   * Insert a leaf and return (leaf_index, new_root)
   */
  insert(leaf: Uint8Array): { leafIndex: number; root: Uint8Array } {
    this.computeZeroHashes();
    const leafIndex = this.nextIndex;
    this.leaves.set(leafIndex, leaf);
    this.nextIndex++;

    const root = this.computeRoot();
    this.roots.push(root);

    return { leafIndex, root };
  }

  /**
   * Bulk insert leaves
   */
  insertMany(leaves: Uint8Array[]): void {
    for (const leaf of leaves) {
      this.insert(leaf);
    }
  }

  /**
   * Compute current root
   * Iterative bottom-up approach that always reaches MERKLE_DEPTH,
   * matching proof verification and circuit expectations.
   */
  computeRoot(): Uint8Array {
    this.computeZeroHashes();

    // Level 0: initialize with existing leaves (sparse)
    let levelNodes: Uint8Array[] = [];
    for (let i = 0; i < this.nextIndex; i++) {
      levelNodes[i] = this.leaves.get(i)!;
    }

    let currentCount = this.nextIndex;

    // Build up to MERKLE_DEPTH, padding with zero hashes as needed
    for (let level = 0; level < MERKLE_DEPTH; level++) {
      const nextLevel: Uint8Array[] = [];
      const levelSize = Math.ceil(currentCount / 2) || 1;

      for (let i = 0; i < levelSize; i++) {
        const left = levelNodes[i * 2] || this.zeroHashes[level];
        const right = levelNodes[i * 2 + 1] || this.zeroHashes[level];
        nextLevel[i] = hashNodes(left, right);
      }

      levelNodes = nextLevel;
      currentCount = levelNodes.length;
    }

    return levelNodes[0] || this.zeroHashes[MERKLE_DEPTH];
  }

  /**
   * Get Merkle proof for a leaf
   */
  getProof(leafIndex: number): MerkleProof {
    this.computeZeroHashes();
    if (!this.leaves.has(leafIndex)) {
      throw new Error(`Leaf ${leafIndex} not found in tree`);
    }
    const siblings: Uint8Array[] = [];

    // Build level-by-level arrays to mirror computeRoot and guarantee consistency.
    let levelNodes: Uint8Array[] = [];
    for (let i = 0; i < this.nextIndex; i++) {
      levelNodes[i] = this.leaves.get(i)!;
    }

    let currentIndex = leafIndex;
    for (let level = 0; level < MERKLE_DEPTH; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      const sibling = levelNodes[siblingIndex] || this.zeroHashes[level];
      siblings.push(sibling);

      const nextLevel: Uint8Array[] = [];
      const levelSize = Math.max(1, Math.ceil((levelNodes.length || 1) / 2));
      for (let i = 0; i < levelSize; i++) {
        const left = levelNodes[i * 2] || this.zeroHashes[level];
        const right = levelNodes[i * 2 + 1] || this.zeroHashes[level];
        nextLevel[i] = hashNodes(left, right);
      }

      levelNodes = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    const leaf = this.leaves.get(leafIndex)!;
    const root = levelNodes[0] || this.zeroHashes[MERKLE_DEPTH];

    return { leaf, leafIndex, siblings, root };
  }

  /**
   * Compute hash of a node at a specific level and index
   */
  private computeNodeAt(level: number, index: number): Uint8Array {
    if (level === 0) {
      return this.leaves.get(index) || this.zeroHashes[0];
    }

    const leftChild = this.computeNodeAt(level - 1, index * 2);
    const rightChild = this.computeNodeAt(level - 1, index * 2 + 1);

    return hashNodes(leftChild, rightChild);
  }

  /**
   * Verify a Merkle proof
   */
  static verifyProof(proof: MerkleProof): boolean {
    let current = proof.leaf;
    let index = proof.leafIndex;

    for (const sibling of proof.siblings) {
      if (index % 2 === 0) {
        current = hashNodes(current, sibling);
      } else {
        current = hashNodes(sibling, current);
      }
      index = Math.floor(index / 2);
    }

    return arraysEqual(current, proof.root);
  }

  /**
   * Check if a root exists in the root history
   */
  isKnownRoot(root: Uint8Array): boolean {
    return this.roots.some((r) => arraysEqual(r, root));
  }

  /**
   * Get current root
   */
  getRoot(): Uint8Array {
    return this.roots[this.roots.length - 1] || this.zeroHashes[MERKLE_DEPTH];
  }

  /**
   * Get next leaf index
   */
  getNextIndex(): number {
    return this.nextIndex;
  }

  /**
   * Get a leaf by index
   */
  getLeaf(index: number): Uint8Array | undefined {
    return this.leaves.get(index);
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.leaves.clear();
    this.roots = [];
    this.nextIndex = 0;
  }
}

/**
 * Syncs Merkle tree from on-chain LeafChunk PDAs
 */
export class MerkleTreeSync {
  private tree: MerkleTree;
  private connection: Connection;
  private program: Program;
  private poolConfig: PublicKey;

  constructor(connection: Connection, program: Program, poolConfig: PublicKey) {
    this.tree = new MerkleTree();
    this.connection = connection;
    this.program = program;
    this.poolConfig = poolConfig;
  }

  /**
   * Sync tree from chain (fetch all LeafChunk PDAs)
   */
  async sync(): Promise<void> {
    console.log("🌲 Syncing merkle tree from chain...");
    // Derive pool tree PDA using mint (on-chain seeds: b"tree", mint)
    const mint = await this.getMint();
    const [poolTreePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("tree"), mint.toBuffer()],
      this.program.programId
    );

    const poolTreeAccount = await (this.program.account as any).poolTree.fetch(
      poolTreePDA
    );
    const nextIndex = Number(poolTreeAccount.nextIndex);
    console.log("   Pool tree nextIndex:", nextIndex);

    if (nextIndex === 0) {
      console.log("   Tree is empty");
      return; // Empty tree
    }

    // Calculate number of chunks needed
    const numChunks = Math.ceil(nextIndex / LEAF_CHUNK_SIZE);
    console.log("   Fetching", numChunks, "chunks...");

    // Fetch all chunks in parallel
    const chunkPromises = Array.from({ length: numChunks }, (_, i) =>
      this.fetchLeafChunk(i)
    );

    const chunks = await Promise.all(chunkPromises);

    // Rebuild tree
    this.tree.clear();
    let totalLeaves = 0;
    for (const chunk of chunks) {
      if (!chunk) continue;

      for (let i = 0; i < chunk.count; i++) {
        this.tree.insert(chunk.leaves[i]);
        totalLeaves++;
      }
    }
    console.log("✅ Synced", totalLeaves, "leaves into merkle tree");
  }

  /**
   * Fetch a specific LeafChunk PDA
   */
  private async fetchLeafChunk(chunkIndex: number): Promise<{
    count: number;
    leaves: Uint8Array[];
  } | null> {
    try {
      const mint = await this.getMint();
      const [leafChunkPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("leaf"),
          mint.toBuffer(),
          new BN(chunkIndex).toArrayLike(Buffer, "be", 4),
        ],
        this.program.programId
      );

      const chunk = await (this.program.account as any).leafChunk.fetch(
        leafChunkPDA
      );

      return {
        count: chunk.count,
        leaves: chunk.leaves.slice(0, chunk.count),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get mint address from pool config
   */
  private async getMint(): Promise<PublicKey> {
    const config = await (this.program.account as any).poolConfig.fetch(
      this.poolConfig
    );
    return config.mint;
  }

  /**
   * Get Merkle proof for a leaf
   */
  getProof(leafIndex: number): MerkleProof {
    return this.tree.getProof(leafIndex);
  }

  /**
   * Get current root
   */
  getRoot(): Uint8Array {
    return this.tree.getRoot();
  }

  /**
   * Get next leaf index
   */
  getNextIndex(): number {
    return this.tree.getNextIndex();
  }

  /**
   * Find the leaf index for a given commitment (linear scan of current tree state).
   */
  findLeafIndex(commitment: Uint8Array): number | undefined {
    const limit = this.tree.getNextIndex();
    for (let i = 0; i < limit; i++) {
      const leaf = this.tree.getLeaf(i);
      if (leaf && arraysEqual(leaf, commitment)) {
        return i;
      }
    }
    return undefined;
  }

  /**
   * Get the underlying tree
   */
  getTree(): MerkleTree {
    return this.tree;
  }
}

/**
 * Compare two byte arrays
 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
