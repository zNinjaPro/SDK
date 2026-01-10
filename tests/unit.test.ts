/**
 * Unit tests for SDK components
 */

import { expect } from "chai";
import { KeyManager } from "../src/keyManager";
import { NoteManager } from "../src/noteManager";
import { PublicKey, Keypair } from "@solana/web3.js";

describe("SDK Unit Tests", () => {
  describe("KeyManager", () => {
    it("should generate random keys", () => {
      const km1 = KeyManager.generate();
      const km2 = KeyManager.generate();

      expect(km1).to.exist;
      expect(km2).to.exist;

      // Should be different
      const addr1 = km1.getShieldedAddress();
      const addr2 = km2.getShieldedAddress();
      expect(Buffer.from(addr1).toString("hex")).to.not.equal(
        Buffer.from(addr2).toString("hex")
      );
    });

    it("should derive consistent keys from same seed", () => {
      const seed = new Uint8Array(32).fill(1);

      const km1 = KeyManager.fromSeed(seed);
      const km2 = KeyManager.fromSeed(seed);

      const addr1 = km1.getShieldedAddress();
      const addr2 = km2.getShieldedAddress();

      expect(Buffer.from(addr1).toString("hex")).to.equal(
        Buffer.from(addr2).toString("hex")
      );
    });

    it("should restore from valid mnemonic", () => {
      const mnemonic =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

      const km = KeyManager.fromMnemonic(mnemonic);

      expect(km).to.exist;
      expect(km.getSpendingKey()).to.be.instanceOf(Uint8Array);
      expect(km.getViewingKey()).to.be.instanceOf(Uint8Array);
      expect(km.getNullifierKey()).to.be.instanceOf(Uint8Array);
      expect(km.getShieldedAddress()).to.be.instanceOf(Uint8Array);
    });

    it("should reject invalid mnemonic", () => {
      expect(() => {
        KeyManager.fromMnemonic("invalid mnemonic phrase");
      }).to.throw();
    });

    it("should return 32-byte keys", () => {
      const km = KeyManager.generate();

      expect(km.getSpendingKey().length).to.equal(32);
      expect(km.getViewingKey().length).to.equal(32);
      expect(km.getNullifierKey().length).to.equal(32);
      expect(km.getShieldedAddress().length).to.equal(32);
    });
  });

  describe("NoteManager", () => {
    let noteManager: NoteManager;
    let spendingKey: Uint8Array;

    beforeEach(() => {
      const km = KeyManager.generate();
      spendingKey = km.getSpendingKey();

      noteManager = new NoteManager({
        seed: new Uint8Array(32),
        spendingKey: km.getSpendingKey(),
        viewingKey: km.getViewingKey(),
        nullifierKey: km.getNullifierKey(),
        shieldedAddress: km.getShieldedAddress(),
      });
    });

    it("should start with zero balance", () => {
      const balance = noteManager.calculateBalance();
      expect(balance).to.equal(0n);
    });

    it("should create valid notes", async () => {
      const note = await noteManager.createNote(1000n, spendingKey);

      expect(note).to.exist;
      expect(note.value).to.equal(1000n);
      expect(note.owner).to.equal(spendingKey);
      expect(note.commitment).to.be.instanceOf(Uint8Array);
      expect(note.nullifier).to.be.instanceOf(Uint8Array);
      expect(note.randomness).to.be.instanceOf(Uint8Array);
    });

    it("should track added notes", async () => {
      const note1 = await noteManager.createNote(1000n, spendingKey);
      const note2 = await noteManager.createNote(2000n, spendingKey);

      noteManager.addNote(note1);
      noteManager.addNote(note2);

      const balance = noteManager.calculateBalance();
      expect(balance).to.equal(3000n);
    });

    it("should select notes for spending", async () => {
      const note1 = await noteManager.createNote(1000n, spendingKey);
      const note2 = await noteManager.createNote(2000n, spendingKey);
      const note3 = await noteManager.createNote(3000n, spendingKey);

      noteManager.addNote(note1);
      noteManager.addNote(note2);
      noteManager.addNote(note3);

      const selected = noteManager.selectNotes(4000n);

      expect(selected.length).to.be.at.least(2);
      const total = selected.reduce((sum, n) => sum + n.value, 0n);
      expect(total >= 4000n).to.be.true;
    });

    it("should throw when insufficient balance", async () => {
      const note = await noteManager.createNote(1000n, spendingKey);
      noteManager.addNote(note);

      expect(() => {
        noteManager.selectNotes(2000n);
      }).to.throw();
    });

    it("should mark notes as spent", async () => {
      const note = await noteManager.createNote(1000n, spendingKey);
      noteManager.addNote(note);

      expect(noteManager.calculateBalance()).to.equal(1000n);

      noteManager.markSpent(note.commitment);

      expect(noteManager.calculateBalance()).to.equal(0n);
    });
  });

  describe("Cryptographic Functions", () => {
    it("should generate random bytes", () => {
      const { randomBytes } = require("../src/crypto");

      const bytes1 = randomBytes(32);
      const bytes2 = randomBytes(32);

      expect(bytes1).to.be.instanceOf(Uint8Array);
      expect(bytes1.length).to.equal(32);
      expect(bytes2.length).to.equal(32);

      // Should be different
      expect(Buffer.from(bytes1).toString("hex")).to.not.equal(
        Buffer.from(bytes2).toString("hex")
      );
    });

    it("should hash consistently", () => {
      const { sha256 } = require("../src/crypto");

      const data = Buffer.from("test data");
      const hash1 = sha256(data);
      const hash2 = sha256(data);

      expect(Buffer.from(hash1).toString("hex")).to.equal(
        Buffer.from(hash2).toString("hex")
      );
    });

    it("should compute commitments", async () => {
      const { computeCommitment } = require("../src/crypto");

      const value = 1000n;
      const owner = new Uint8Array(32).fill(1);
      const randomness = new Uint8Array(32).fill(2);

      const commitment = await computeCommitment(value, owner, randomness);

      expect(commitment).to.be.instanceOf(Uint8Array);
      expect(commitment.length).to.equal(32);
    });

    it("should compute nullifiers", async () => {
      const { computeNullifier } = require("../src/crypto");

      const commitment = new Uint8Array(32).fill(1);
      const nullifierKey = new Uint8Array(32).fill(2);

      const nullifier = await computeNullifier(commitment, nullifierKey);

      expect(nullifier).to.be.instanceOf(Uint8Array);
      expect(nullifier.length).to.equal(32);
    });
  });
});
