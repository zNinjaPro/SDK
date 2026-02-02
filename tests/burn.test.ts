/**
 * Burn Calculation Tests
 *
 * Tests for the burn mechanism (0.1% default) applied on deposits and withdrawals.
 * Per TESTING_STRATEGY.md - these are critical paths requiring 100% coverage.
 */

import { expect } from "chai";
import {
  calculateBurnAmount,
  calculateAmountAfterBurn,
  calculateGrossAmount,
  DEFAULT_BURN_RATE_BPS,
} from "../src/types";

describe("Burn Calculations", () => {
  describe("calculateBurnAmount", () => {
    it("should calculate burn amount correctly at default rate (0.1%)", () => {
      // 1,000,000,000 lamports at 10 bps = 1,000,000 burn
      const burn = calculateBurnAmount(1_000_000_000n, 10);
      expect(burn).to.equal(1_000_000n);
    });

    it("should use DEFAULT_BURN_RATE_BPS = 10", () => {
      expect(DEFAULT_BURN_RATE_BPS).to.equal(10);
    });

    it("should handle zero amount", () => {
      const burn = calculateBurnAmount(0n, 10);
      expect(burn).to.equal(0n);
    });

    it("should handle dust amounts (rounds down)", () => {
      // 999 lamports at 10 bps = 0 burn (rounds down)
      const burn = calculateBurnAmount(999n, 10);
      expect(burn).to.equal(0n);
    });

    it("should round down on non-exact division", () => {
      // 10001 at 10 bps = 10001 * 10 / 10000 = 100010 / 10000 = 10.001 → 10
      const burn = calculateBurnAmount(10001n, 10);
      expect(burn).to.equal(10n);
    });

    it("should handle small amounts just above dust threshold", () => {
      // 1000 lamports at 10 bps = 1 burn (exactly at threshold)
      const burn = calculateBurnAmount(1000n, 10);
      expect(burn).to.equal(1n);
    });

    it("should handle max burn rate (10% = 1000 bps)", () => {
      const burn = calculateBurnAmount(1_000_000_000n, 1000);
      expect(burn).to.equal(100_000_000n);
    });

    it("should handle zero burn rate", () => {
      const burn = calculateBurnAmount(1_000_000_000n, 0);
      expect(burn).to.equal(0n);
    });

    it("should handle 1 bps (0.01%)", () => {
      // 1,000,000 at 1 bps = 100
      const burn = calculateBurnAmount(1_000_000n, 1);
      expect(burn).to.equal(100n);
    });

    it("should handle 100 bps (1%)", () => {
      const burn = calculateBurnAmount(1_000_000_000n, 100);
      expect(burn).to.equal(10_000_000n);
    });

    it("should handle large amounts without overflow", () => {
      // 10 billion tokens (10^19 lamports)
      const largeAmount = 10_000_000_000_000_000_000n;
      const burn = calculateBurnAmount(largeAmount, 10);
      expect(burn).to.equal(10_000_000_000_000_000n);
    });

    it("should handle maximum safe integer-like values", () => {
      // Near max u64: 2^63 - 1
      const nearMax = 9_223_372_036_854_775_807n;
      const burn = calculateBurnAmount(nearMax, 10);
      // Should not throw, and should be roughly nearMax / 1000
      expect(burn > 0n).to.be.true;
      expect(burn).to.equal(9_223_372_036_854_775n);
    });
  });

  describe("calculateAmountAfterBurn", () => {
    it("should calculate amount after burn correctly", () => {
      const net = calculateAmountAfterBurn(1_000_000_000n, 10);
      expect(net).to.equal(999_000_000n);
    });

    it("should handle zero amount", () => {
      const net = calculateAmountAfterBurn(0n, 10);
      expect(net).to.equal(0n);
    });

    it("should handle dust amounts (full amount preserved)", () => {
      // 999 at 10 bps → burn = 0, net = 999
      const net = calculateAmountAfterBurn(999n, 10);
      expect(net).to.equal(999n);
    });

    it("should handle zero burn rate (full amount)", () => {
      const net = calculateAmountAfterBurn(1_000_000_000n, 0);
      expect(net).to.equal(1_000_000_000n);
    });

    it("should handle max burn rate (90% remaining)", () => {
      const net = calculateAmountAfterBurn(1_000_000_000n, 1000);
      expect(net).to.equal(900_000_000n);
    });

    it("should satisfy: amount = afterBurn + burnAmount", () => {
      const amount = 1_234_567_890n;
      const rate = 10;
      const burnAmount = calculateBurnAmount(amount, rate);
      const afterBurn = calculateAmountAfterBurn(amount, rate);
      expect(burnAmount + afterBurn).to.equal(amount);
    });
  });

  describe("calculateGrossAmount", () => {
    it("should calculate gross amount for target net", () => {
      const net = 1_000_000_000n;
      const gross = calculateGrossAmount(net, 10);
      // gross should be slightly more than net
      expect(gross > net).to.be.true;
    });

    it("should produce net amount >= target after burn", () => {
      const targetNet = 1_000_000_000n;
      const gross = calculateGrossAmount(targetNet, 10);
      const actualNet = calculateAmountAfterBurn(gross, 10);
      expect(actualNet >= targetNet).to.be.true;
    });

    it("should handle zero net amount", () => {
      const gross = calculateGrossAmount(0n, 10);
      expect(gross).to.equal(0n);
    });

    it("should handle zero burn rate", () => {
      const gross = calculateGrossAmount(1_000_000_000n, 0);
      expect(gross).to.equal(1_000_000_000n);
    });

    it("should handle max burn rate", () => {
      const net = 900_000_000n;
      const gross = calculateGrossAmount(net, 1000);
      expect(gross).to.equal(1_000_000_000n);
    });

    it("should be inverse of calculateAmountAfterBurn (approximately)", () => {
      const original = 1_000_000_000n;
      const rate = 10;
      const afterBurn = calculateAmountAfterBurn(original, rate);
      const reconstructed = calculateGrossAmount(afterBurn, rate);
      // Due to rounding, reconstructed should be >= original - 1
      expect(reconstructed >= original - 1n).to.be.true;
      expect(reconstructed <= original + 1n).to.be.true;
    });

    it("should handle various burn rates correctly", () => {
      const testCases = [
        { net: 1_000_000n, rate: 1 },
        { net: 1_000_000n, rate: 5 },
        { net: 1_000_000n, rate: 10 },
        { net: 1_000_000n, rate: 50 },
        { net: 1_000_000n, rate: 100 },
        { net: 1_000_000n, rate: 500 },
      ];

      for (const { net, rate } of testCases) {
        const gross = calculateGrossAmount(BigInt(net), rate);
        const actualNet = calculateAmountAfterBurn(gross, rate);
        expect(actualNet >= BigInt(net), `Failed for rate=${rate}`).to.be.true;
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle minimum non-zero burn (1 lamport)", () => {
      // Find minimum amount that produces 1 lamport burn at 10 bps
      // burn = amount * 10 / 10000 >= 1
      // amount >= 1000
      expect(calculateBurnAmount(1000n, 10)).to.equal(1n);
      expect(calculateBurnAmount(999n, 10)).to.equal(0n);
    });

    it("should maintain consistency across all functions", () => {
      const amounts = [
        1n,
        100n,
        1000n,
        10000n,
        1_000_000n,
        1_000_000_000n,
        1_000_000_000_000n,
      ];
      const rates = [0, 1, 5, 10, 50, 100, 500, 1000];

      for (const amount of amounts) {
        for (const rate of rates) {
          const burn = calculateBurnAmount(amount, rate);
          const afterBurn = calculateAmountAfterBurn(amount, rate);

          // Invariant: burn + afterBurn = amount
          expect(burn + afterBurn).to.equal(
            amount,
            `Invariant violated for amount=${amount}, rate=${rate}`,
          );

          // Invariant: burn >= 0
          expect(burn >= 0n).to.be.true;

          // Invariant: afterBurn <= amount
          expect(afterBurn <= amount).to.be.true;
        }
      }
    });
  });

  describe("Real-world Scenarios", () => {
    it("should calculate correctly for 1 SOL deposit", () => {
      const oneSOL = 1_000_000_000n; // 1 SOL = 10^9 lamports
      const burn = calculateBurnAmount(oneSOL, DEFAULT_BURN_RATE_BPS);
      const credited = calculateAmountAfterBurn(oneSOL, DEFAULT_BURN_RATE_BPS);

      expect(burn).to.equal(1_000_000n); // 0.001 SOL burned
      expect(credited).to.equal(999_000_000n); // 0.999 SOL credited
    });

    it("should calculate correctly for 100 SOL deposit", () => {
      const hundredSOL = 100_000_000_000n;
      const burn = calculateBurnAmount(hundredSOL, DEFAULT_BURN_RATE_BPS);
      const credited = calculateAmountAfterBurn(
        hundredSOL,
        DEFAULT_BURN_RATE_BPS,
      );

      expect(burn).to.equal(100_000_000n); // 0.1 SOL burned
      expect(credited).to.equal(99_900_000_000n); // 99.9 SOL credited
    });

    it("should calculate gross amount for desired 1 SOL net", () => {
      const desiredNet = 1_000_000_000n;
      const grossNeeded = calculateGrossAmount(
        desiredNet,
        DEFAULT_BURN_RATE_BPS,
      );
      const actualNet = calculateAmountAfterBurn(
        grossNeeded,
        DEFAULT_BURN_RATE_BPS,
      );

      // User needs to deposit grossNeeded to receive at least desiredNet
      expect(actualNet >= desiredNet).to.be.true;
      // Gross should be approximately 1.001001... SOL
      expect(grossNeeded).to.equal(1_001_001_001n);
    });
  });
});
