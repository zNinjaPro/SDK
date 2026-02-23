/**
 * Epoch-aware Merkle tree implementation for shielded pool
 * Reconstructs trees from on-chain EpochLeafChunk PDAs
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import {
  MERKLE_DEPTH,
  LEAF_CHUNK_SIZE,
  MerkleProof,
  EpochState,
  EpochInfo,
} from "./types";
import { PDA_SEEDS } from "./config";
import { poseidonHashSync } from "./crypto";

// Helper to hash two nodes using Poseidon (matches on-chain program and circuit)
function hashNodes(left: Uint8Array, right: Uint8Array): Uint8Array {
  return poseidonHashSync([left, right]);
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

/**
 * Pre-computed zero hashes for depth 12 merkle tree
 * These match the on-chain constants exactly
 */
const ZERO_HASHES_DEPTH_12 = [
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
  // Level 12 (root of empty tree)
  "b159372c0d35324c8f5fe23ff3fdf89901218d3d544eafaa115c08f2ddf6e205",
];

/**
 * Epoch-aware Merkle tree for the shielded pool
 * Depth = 12 (4,096 leaves per epoch)
 */
export class EpochMerkleTree {
  private leaves: Map<number, Uint8Array> = new Map();
  private zeroHashes: Uint8Array[] = [];
  private roots: Uint8Array[] = [];
  private nextIndex: number = 0;
  public readonly epoch: bigint;
  private finalRoot: Uint8Array | null = null;
  private state: EpochState = EpochState.Active;

  constructor(epoch: bigint) {
    this.epoch = epoch;
    this.initZeroHashes();
  }

  /**
   * Initialize zero hashes from precomputed constants
   */
  private initZeroHashes(): void {
    this.zeroHashes = ZERO_HASHES_DEPTH_12.map(
      (hex) => new Uint8Array(Buffer.from(hex, "hex")),
    );
  }

  /**
   * Get epoch number
   */
  getEpoch(): bigint {
    return this.epoch;
  }

  /**
   * Get epoch state
   */
  getState(): EpochState {
    return this.state;
  }

  /**
   * Set epoch state
   */
  setState(state: EpochState): void {
    this.state = state;
  }

  /**
   * Set final root (for finalized epochs)
   */
  setFinalRoot(root: Uint8Array): void {
    this.finalRoot = root;
    this.state = EpochState.Finalized;
  }

  /**
   * Get final root (for finalized epochs)
   */
  getFinalRoot(): Uint8Array | null {
    return this.finalRoot;
  }

  /**
   * Insert a leaf and return (leaf_index, new_root)
   */
  insert(leaf: Uint8Array): { leafIndex: number; root: Uint8Array } {
    if (this.state !== EpochState.Active) {
      throw new Error(
        `Cannot insert into epoch ${this.epoch} with state ${EpochState[this.state]}`,
      );
    }

    const maxLeaves = 1 << MERKLE_DEPTH; // 2^12 = 4096
    if (this.nextIndex >= maxLeaves) {
      throw new Error(`Epoch ${this.epoch} is full (${maxLeaves} leaves)`);
    }

    const leafIndex = this.nextIndex;
    this.leaves.set(leafIndex, leaf);
    this.nextIndex++;

    const root = this.computeRoot();
    this.roots.push(root);

    return { leafIndex, root };
  }

  /**
   * Bulk insert leaves (for syncing from chain)
   */
  insertMany(leaves: Uint8Array[]): void {
    for (const leaf of leaves) {
      const leafIndex = this.nextIndex;
      this.leaves.set(leafIndex, leaf);
      this.nextIndex++;
    }
    // Only compute root once at the end
    if (leaves.length > 0) {
      this.roots.push(this.computeRoot());
    }
  }

  /**
   * Compute current root
   */
  computeRoot(): Uint8Array {
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
    if (!this.leaves.has(leafIndex)) {
      throw new Error(`Leaf ${leafIndex} not found in epoch ${this.epoch}`);
    }

    const siblings: Uint8Array[] = [];

    // Build level-by-level arrays
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
    const root =
      this.finalRoot || levelNodes[0] || this.zeroHashes[MERKLE_DEPTH];

    return { leaf, leafIndex, epoch: this.epoch, siblings, root };
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
    if (this.finalRoot && arraysEqual(root, this.finalRoot)) {
      return true;
    }
    return this.roots.some((r) => arraysEqual(r, root));
  }

  /**
   * Get current root (or final root if finalized)
   */
  getRoot(): Uint8Array {
    if (this.finalRoot) {
      return this.finalRoot;
    }
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
   * Find leaf index for a commitment
   */
  findLeafIndex(commitment: Uint8Array): number | undefined {
    for (let i = 0; i < this.nextIndex; i++) {
      const leaf = this.leaves.get(i);
      if (leaf && arraysEqual(leaf, commitment)) {
        return i;
      }
    }
    return undefined;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.leaves.clear();
    this.roots = [];
    this.nextIndex = 0;
    this.finalRoot = null;
    this.state = EpochState.Active;
  }
}

/**
 * Manages multiple epoch trees and syncs from on-chain
 */
export class EpochMerkleTreeManager {
  private trees: Map<bigint, EpochMerkleTree> = new Map();
  private connection: Connection;
  private program: Program;
  private poolConfig: PublicKey;
  private currentEpoch: bigint = 0n;

  constructor(connection: Connection, program: Program, poolConfig: PublicKey) {
    this.connection = connection;
    this.program = program;
    this.poolConfig = poolConfig;
  }

  /**
   * Get or create tree for an epoch
   */
  getTree(epoch: bigint): EpochMerkleTree {
    let tree = this.trees.get(epoch);
    if (!tree) {
      tree = new EpochMerkleTree(epoch);
      this.trees.set(epoch, tree);
    }
    return tree;
  }

  /**
   * Get current epoch from pool config
   */
  async fetchCurrentEpoch(): Promise<bigint> {
    const config = await (this.program.account as any).poolConfig.fetch(
      this.poolConfig,
    );
    this.currentEpoch = BigInt(config.currentEpoch.toString());
    return this.currentEpoch;
  }

  /**
   * Sync a specific epoch's tree from chain
   */
  async syncEpoch(epoch: bigint): Promise<EpochMerkleTree> {

    // Derive epoch tree PDA
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(epoch);

    const [epochTreePDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(PDA_SEEDS.EPOCH_TREE),
        this.poolConfig.toBuffer(),
        epochBytes,
      ],
      this.program.programId,
    );

    let epochTreeAccount;
    try {
      epochTreeAccount = await (this.program.account as any).epochTree.fetch(
        epochTreePDA,
      );
    } catch (e) {
      return this.getTree(epoch);
    }

    const tree = this.getTree(epoch);
    tree.clear();

    // Parse state
    const stateValue = epochTreeAccount.state;
    if (stateValue === 0) tree.setState(EpochState.Active);
    else if (stateValue === 1) tree.setState(EpochState.Frozen);
    else if (stateValue === 2) {
      tree.setState(EpochState.Finalized);
      tree.setFinalRoot(new Uint8Array(epochTreeAccount.finalRoot));
    }

    const nextIndex = Number(epochTreeAccount.nextIndex);

    if (nextIndex === 0) {
      return tree;
    }

    // Fetch leaf chunks
    const numChunks = Math.ceil(nextIndex / LEAF_CHUNK_SIZE);

    const chunkPromises = Array.from({ length: numChunks }, (_, i) =>
      this.fetchLeafChunk(epoch, i),
    );

    const chunks = await Promise.all(chunkPromises);

    // Populate tree
    const allLeaves: Uint8Array[] = [];
    for (const chunk of chunks) {
      if (!chunk) continue;
      for (let i = 0; i < chunk.count; i++) {
        allLeaves.push(chunk.leaves[i]);
      }
    }
    tree.insertMany(allLeaves);

    return tree;
  }

  /**
   * Sync all known epochs from chain
   */
  async syncAll(): Promise<void> {
    await this.fetchCurrentEpoch();

    // Sync current epoch and a few previous ones
    const epochsToSync: bigint[] = [];
    for (
      let e = this.currentEpoch;
      e >= 0n && e >= this.currentEpoch - 5n;
      e--
    ) {
      epochsToSync.push(e);
    }

    for (const epoch of epochsToSync) {
      await this.syncEpoch(epoch);
    }
  }

  /**
   * Fetch a specific EpochLeafChunk PDA
   */
  private async fetchLeafChunk(
    epoch: bigint,
    chunkIndex: number,
  ): Promise<{
    count: number;
    leaves: Uint8Array[];
  } | null> {
    try {
      const epochBytes = Buffer.alloc(8);
      epochBytes.writeBigUInt64LE(epoch);

      const chunkIndexBytes = Buffer.alloc(4);
      chunkIndexBytes.writeUInt32LE(chunkIndex);

      const [leafChunkPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from(PDA_SEEDS.LEAVES),
          this.poolConfig.toBuffer(),
          epochBytes,
          chunkIndexBytes,
        ],
        this.program.programId,
      );

      const chunk = await (this.program.account as any).epochLeafChunk.fetch(
        leafChunkPDA,
      );

      return {
        count: chunk.count,
        leaves: chunk.leaves
          .slice(0, chunk.count)
          .map((l: any) => new Uint8Array(l)),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get epoch info from chain
   */
  async getEpochInfo(epoch: bigint): Promise<EpochInfo | null> {
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64LE(epoch);

    const [epochTreePDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(PDA_SEEDS.EPOCH_TREE),
        this.poolConfig.toBuffer(),
        epochBytes,
      ],
      this.program.programId,
    );

    try {
      const account = await (this.program.account as any).epochTree.fetch(
        epochTreePDA,
      );
      const config = await (this.program.account as any).poolConfig.fetch(
        this.poolConfig,
      );

      let state: EpochState;
      if (account.state === 0) state = EpochState.Active;
      else if (account.state === 1) state = EpochState.Frozen;
      else state = EpochState.Finalized;

      const finalizedSlot = BigInt(account.finalizedSlot.toString());
      const expirySlots = BigInt(config.expirySlots.toString());

      return {
        epoch,
        startSlot: BigInt(account.startSlot.toString()),
        endSlot: BigInt(account.endSlot.toString()),
        finalizedSlot,
        state,
        finalRoot: new Uint8Array(account.finalRoot),
        depositCount: Number(account.nextIndex),
        expirySlot: finalizedSlot > 0n ? finalizedSlot + expirySlots : 0n,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if an epoch is expired
   */
  async isEpochExpired(epoch: bigint, currentSlot: bigint): Promise<boolean> {
    const info = await this.getEpochInfo(epoch);
    if (!info || info.state !== EpochState.Finalized) {
      return false;
    }
    return currentSlot >= info.expirySlot;
  }

  /**
   * Get Merkle proof for a commitment in a specific epoch
   */
  getProof(epoch: bigint, leafIndex: number): MerkleProof {
    const tree = this.trees.get(epoch);
    if (!tree) {
      throw new Error(`Epoch ${epoch} tree not found. Call syncEpoch first.`);
    }
    return tree.getProof(leafIndex);
  }

  /**
   * Find which epoch contains a commitment
   */
  findCommitment(
    commitment: Uint8Array,
  ): { epoch: bigint; leafIndex: number } | null {
    for (const [epoch, tree] of this.trees) {
      const leafIndex = tree.findLeafIndex(commitment);
      if (leafIndex !== undefined) {
        return { epoch, leafIndex };
      }
    }
    return null;
  }

  /**
   * Get current epoch number
   */
  getCurrentEpoch(): bigint {
    return this.currentEpoch;
  }

  /**
   * Sync all known epochs (alias for syncAll)
   */
  async sync(): Promise<void> {
    return this.syncAll();
  }

  /**
   * Get all synced epochs
   */
  getSyncedEpochs(): bigint[] {
    return Array.from(this.trees.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  }
}

// Re-export for backward compatibility during migration
export { EpochMerkleTree as MerkleTree };
export { EpochMerkleTreeManager as MerkleTreeSync };
