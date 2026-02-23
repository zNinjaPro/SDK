/**
 * Tests for NoteStore persistence layer
 *
 * Covers:
 * - Serialization round-trips (Note ↔ SerializedNote)
 * - EncryptedFileStore (encryption, atomic writes, wrong-key rejection)
 * - InMemoryStore (basic ops)
 * - NoteManager + NoteStore integration (auto-persist, load-from-store)
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PublicKey } from "@solana/web3.js";
import {
  serializeNoteForStorage,
  deserializeNoteFromStorage,
  serializeStoreData,
  deserializeStoreData,
  EncryptedFileStore,
  InMemoryStore,
} from "../src/noteStore";
import { NoteManager } from "../src/noteManager";
import { randomBytes } from "../src/crypto";
import { Note, SpendingKeys } from "../src/types";
import { KeyManager } from "../src/keyManager";

function mockNote(overrides: Partial<Note> = {}): Note {
  return {
    value: 1000n,
    token: PublicKey.default,
    owner: randomBytes(32),
    blinding: randomBytes(32),
    commitment: randomBytes(32),
    nullifier: randomBytes(32),
    randomness: randomBytes(32),
    spent: false,
    ...overrides,
  };
}

function mockKeys(): SpendingKeys {
  const km = KeyManager.fromSeed(randomBytes(32));
  return {
    seed: randomBytes(32),
    spendingKey: km.getSpendingKey(),
    viewingKey: km.getViewingKey(),
    nullifierKey: km.getNullifierKey(),
    shieldedAddress: km.getShieldedAddress(),
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zninja-notestore-test-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("NoteStore", () => {
  // ─── Serialization ────────────────────────────────────────────

  describe("Serialization helpers", () => {
    it("round-trips a Note through serialize/deserialize", () => {
      const note = mockNote({
        leafIndex: 7,
        epoch: 42n,
        spent: false,
        memo: "test deposit",
      });

      const serialized = serializeNoteForStorage(note);
      const restored = deserializeNoteFromStorage(serialized);

      expect(restored.value).to.equal(note.value);
      expect(restored.token.toBase58()).to.equal(note.token.toBase58());
      expect(Buffer.from(restored.owner).toString("hex")).to.equal(
        Buffer.from(note.owner).toString("hex"),
      );
      expect(Buffer.from(restored.blinding).toString("hex")).to.equal(
        Buffer.from(note.blinding).toString("hex"),
      );
      expect(Buffer.from(restored.commitment).toString("hex")).to.equal(
        Buffer.from(note.commitment).toString("hex"),
      );
      expect(Buffer.from(restored.nullifier).toString("hex")).to.equal(
        Buffer.from(note.nullifier).toString("hex"),
      );
      expect(Buffer.from(restored.randomness).toString("hex")).to.equal(
        Buffer.from(note.randomness).toString("hex"),
      );
      expect(restored.leafIndex).to.equal(7);
      expect(restored.epoch).to.equal(42n);
      expect(restored.spent).to.equal(false);
      expect(restored.memo).to.equal("test deposit");
    });

    it("handles missing optional fields", () => {
      const note = mockNote(); // no leafIndex, epoch, memo
      const serialized = serializeNoteForStorage(note);
      const restored = deserializeNoteFromStorage(serialized);

      expect(restored.leafIndex).to.be.undefined;
      expect(restored.epoch).to.be.undefined;
      expect(restored.memo).to.be.undefined;
    });

    it("preserves bigint precision for large values", () => {
      const largeValue = 2n ** 64n - 1n; // max u64
      const note = mockNote({ value: largeValue, epoch: 999999n });

      const serialized = serializeNoteForStorage(note);
      const restored = deserializeNoteFromStorage(serialized);

      expect(restored.value).to.equal(largeValue);
      expect(restored.epoch).to.equal(999999n);
    });

    it("preserves non-default token PublicKey", () => {
      const token = new PublicKey(
        "So11111111111111111111111111111111111111112",
      );
      const note = mockNote({ token });

      const serialized = serializeNoteForStorage(note);
      const restored = deserializeNoteFromStorage(serialized);

      expect(restored.token.toBase58()).to.equal(token.toBase58());
    });
  });

  describe("serializeStoreData / deserializeStoreData", () => {
    it("round-trips full state", () => {
      const notes = [mockNote({ epoch: 1n }), mockNote({ epoch: 2n })];
      const pending = [mockNote()];

      const data = serializeStoreData(notes, pending, 42n);
      expect(data.version).to.equal(1);
      expect(data.notes).to.have.length(2);
      expect(data.pendingNotes).to.have.length(1);
      expect(data.currentEpoch).to.equal("42");

      const {
        notes: rNotes,
        pendingNotes: rPending,
        currentEpoch,
      } = deserializeStoreData(data);
      expect(rNotes).to.have.length(2);
      expect(rPending).to.have.length(1);
      expect(currentEpoch).to.equal(42n);
      expect(rNotes[0].epoch).to.equal(1n);
      expect(rNotes[1].epoch).to.equal(2n);
    });

    it("handles empty arrays", () => {
      const data = serializeStoreData([], [], 0n);
      const { notes, pendingNotes, currentEpoch } = deserializeStoreData(data);
      expect(notes).to.have.length(0);
      expect(pendingNotes).to.have.length(0);
      expect(currentEpoch).to.equal(0n);
    });
  });

  // ─── EncryptedFileStore ───────────────────────────────────────

  describe("EncryptedFileStore", () => {
    let testDir: string;
    let store: EncryptedFileStore;
    let key: Uint8Array;

    beforeEach(() => {
      testDir = makeTempDir();
      key = randomBytes(32);
      store = new EncryptedFileStore(path.join(testDir, "notes.enc"), key);
    });

    afterEach(() => {
      cleanDir(testDir);
    });

    it("rejects non-32-byte keys", () => {
      expect(
        () => new EncryptedFileStore("/tmp/test.enc", randomBytes(16)),
      ).to.throw("32 bytes");
    });

    it("returns null when no file exists", async () => {
      expect(await store.load()).to.be.null;
    });

    it("save then load round-trips data", async () => {
      const data = serializeStoreData(
        [mockNote({ epoch: 5n, leafIndex: 3 })],
        [mockNote()],
        5n,
      );
      await store.save(data);
      const loaded = await store.load();

      expect(loaded).to.not.be.null;
      expect(loaded!.version).to.equal(1);
      expect(loaded!.notes).to.have.length(1);
      expect(loaded!.pendingNotes).to.have.length(1);
      expect(loaded!.currentEpoch).to.equal("5");
      expect(loaded!.notes[0].epoch).to.equal("5");
      expect(loaded!.notes[0].leafIndex).to.equal(3);
    });

    it("encrypts file contents (not plaintext JSON on disk)", async () => {
      await store.save(serializeStoreData([mockNote()], [], 1n));
      const raw = fs.readFileSync(path.join(testDir, "notes.enc"));

      // First 24 bytes are nonce, rest is ciphertext
      expect(raw.length).to.be.greaterThan(24);

      // Should not be parseable as JSON
      expect(() => JSON.parse(raw.toString())).to.throw();
    });

    it("fails to load with wrong key", async () => {
      await store.save(serializeStoreData([mockNote()], [], 1n));
      const wrongStore = new EncryptedFileStore(
        path.join(testDir, "notes.enc"),
        randomBytes(32),
      );
      expect(await wrongStore.load()).to.be.null;
    });

    it("atomic write survives rapid sequential saves", async () => {
      for (let i = 0; i < 10; i++) {
        await store.save(serializeStoreData([mockNote()], [], BigInt(i)));
      }
      const loaded = await store.load();
      expect(loaded).to.not.be.null;
      expect(loaded!.currentEpoch).to.equal("9");
    });

    it("clear removes the file", async () => {
      await store.save(serializeStoreData([], [], 0n));
      expect(fs.existsSync(path.join(testDir, "notes.enc"))).to.be.true;
      await store.clear();
      expect(fs.existsSync(path.join(testDir, "notes.enc"))).to.be.false;
      expect(await store.load()).to.be.null;
    });

    it("clear is idempotent (no error on missing file)", async () => {
      await store.clear(); // no file yet
      await store.clear(); // still no file
    });

    it("creates parent directories if missing", async () => {
      const nestedPath = path.join(testDir, "a", "b", "c", "notes.enc");
      const nestedStore = new EncryptedFileStore(nestedPath, key);
      await nestedStore.save(serializeStoreData([], [], 0n));
      expect(fs.existsSync(nestedPath)).to.be.true;
    });
  });

  // ─── InMemoryStore ────────────────────────────────────────────

  describe("InMemoryStore", () => {
    it("returns null initially", async () => {
      const store = new InMemoryStore();
      expect(await store.load()).to.be.null;
    });

    it("save then load round-trips", async () => {
      const store = new InMemoryStore();
      const data = serializeStoreData([mockNote()], [], 7n);
      await store.save(data);
      const loaded = await store.load();
      expect(loaded).to.not.be.null;
      expect(loaded!.currentEpoch).to.equal("7");
      expect(loaded!.notes).to.have.length(1);
    });

    it("clear resets to null", async () => {
      const store = new InMemoryStore();
      await store.save(serializeStoreData([], [], 0n));
      expect(await store.load()).to.not.be.null;
      await store.clear();
      expect(await store.load()).to.be.null;
    });

    it("deep clones data (mutations don't leak)", async () => {
      const store = new InMemoryStore();
      const data = serializeStoreData([mockNote()], [], 1n);
      await store.save(data);

      // Mutate the original data
      data.currentEpoch = "999";
      data.notes.push(serializeNoteForStorage(mockNote()));

      // Loaded data should be unaffected
      const loaded = await store.load();
      expect(loaded!.currentEpoch).to.equal("1");
      expect(loaded!.notes).to.have.length(1);
    });
  });

  // ─── NoteManager + NoteStore integration ──────────────────────

  describe("NoteManager + NoteStore integration", () => {
    it("persists notes after addNote() + persistNow()", async () => {
      const store = new InMemoryStore();
      const keys = mockKeys();
      const nm = new NoteManager(keys, undefined, store);

      const note = mockNote({ value: 1000n, owner: keys.shieldedAddress });
      nm.addNote(note);
      await nm.persistNow(); // flush debounce

      const data = await store.load();
      expect(data).to.not.be.null;
      expect(data!.notes).to.have.length(1);
      expect(data!.notes[0].value).to.equal("1000");
    });

    it("loads persisted notes on init via loadFromStore()", async () => {
      const store = new InMemoryStore();
      const keys = mockKeys();

      // Save some notes via first NoteManager
      const nm1 = new NoteManager(keys, undefined, store);
      nm1.addNote(mockNote({ value: 500n, owner: keys.shieldedAddress }));
      nm1.addNote(mockNote({ value: 700n, owner: keys.shieldedAddress }));
      await nm1.persistNow();

      // Create second NoteManager with same store
      const nm2 = new NoteManager(keys, undefined, store);
      const loaded = await nm2.loadFromStore();
      expect(loaded).to.be.true;
      expect(nm2.calculateBalance()).to.equal(1200n);
      expect(nm2.getNotes()).to.have.length(2);
    });

    it("persists spent status after markSpent()", async () => {
      const store = new InMemoryStore();
      const keys = mockKeys();
      const nm = new NoteManager(keys, undefined, store);

      const note = mockNote({ value: 1000n });
      nm.addNote(note);
      nm.markSpent(note.commitment);
      await nm.persistNow();

      const data = await store.load();
      expect(data!.notes[0].spent).to.be.true;
    });

    it("persists pending notes", async () => {
      const store = new InMemoryStore();
      const keys = mockKeys();
      const nm = new NoteManager(keys, undefined, store);

      nm.addPendingNote(mockNote({ value: 250n }));
      await nm.persistNow();

      const data = await store.load();
      expect(data!.pendingNotes).to.have.length(1);
      expect(data!.pendingNotes[0].value).to.equal("250");
    });

    it("persists epoch updates", async () => {
      const store = new InMemoryStore();
      const keys = mockKeys();
      const nm = new NoteManager(keys, undefined, store);

      nm.setCurrentEpoch(42n);
      await nm.persistNow();

      const data = await store.load();
      expect(data!.currentEpoch).to.equal("42");
    });

    it("getStats() returns correct counts", () => {
      const keys = mockKeys();
      const nm = new NoteManager(keys);

      nm.addNote(mockNote({ value: 100n }));
      nm.addNote(mockNote({ value: 200n }));
      const spentNote = mockNote({ value: 50n });
      nm.addNote(spentNote);
      nm.markSpent(spentNote.commitment);
      nm.addPendingNote(mockNote({ value: 25n }));

      const stats = nm.getStats();
      expect(stats.confirmed).to.equal(2);
      expect(stats.spent).to.equal(1);
      expect(stats.pending).to.equal(1);
      expect(stats.total).to.equal(300n); // 100 + 200 (spent not counted)
    });

    it("clearStore() removes persisted data", async () => {
      const store = new InMemoryStore();
      const keys = mockKeys();
      const nm = new NoteManager(keys, undefined, store);

      nm.addNote(mockNote());
      await nm.persistNow();
      expect(await store.load()).to.not.be.null;

      await nm.clearStore();
      expect(await store.load()).to.be.null;
    });

    it("works without a store (no regression)", () => {
      const keys = mockKeys();
      const nm = new NoteManager(keys);

      nm.addNote(mockNote({ value: 100n }));
      nm.addPendingNote(mockNote({ value: 50n }));
      nm.setCurrentEpoch(5n);

      expect(nm.calculateBalance()).to.equal(100n);
      expect(nm.getPendingNotes()).to.have.length(1);
      expect(nm.getCurrentEpoch()).to.equal(5n);
    });

    it("loadFromStore returns false without a store", async () => {
      const nm = new NoteManager(mockKeys());
      expect(await nm.loadFromStore()).to.be.false;
    });
  });
});
