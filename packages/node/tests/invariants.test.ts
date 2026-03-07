import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair } from "@wpm/shared";
import { createGenesisBlock } from "../src/genesis.js";
import { ChainState } from "../src/state.js";
import {
  checkPostBlockInvariants,
  checkPoolKInvariant,
  checkPriceSumInvariant,
  handleViolations,
} from "../src/invariants.js";

describe("Invariant checks", () => {
  let poaPublicKey: string;
  let poaPrivateKey: string;

  beforeAll(() => {
    const keys = generateKeyPair();
    poaPublicKey = keys.publicKey;
    poaPrivateKey = keys.privateKey;
  });

  function buildState(): ChainState {
    const state = new ChainState(poaPublicKey);
    const genesis = createGenesisBlock(poaPublicKey, poaPrivateKey);
    state.applyBlock(genesis);
    return state;
  }

  describe("INV-1: Total supply conservation", () => {
    it("passes after genesis with 10M supply", () => {
      const state = buildState();
      const violations = checkPostBlockInvariants(state);
      expect(violations).toEqual([]);
    });

    it("passes after a transfer (zero-sum)", () => {
      const state = buildState();
      state.debit(poaPublicKey, 100);
      state.credit("alice", 100);
      const violations = checkPostBlockInvariants(state);
      expect(violations).toEqual([]);
    });

    it("detects supply mismatch", () => {
      const state = buildState();
      // Artificially create WPM out of thin air
      state.credit("alice", 1);
      const violations = checkPostBlockInvariants(state);
      const inv1 = violations.find((v) => v.id === "INV-1");
      expect(inv1).toBeDefined();
      expect(inv1!.critical).toBe(true);
      expect(inv1!.message).toContain("10000001");
    });

    it("accounts for wpmLocked in pools", () => {
      const state = buildState();
      // Simulate market creation: debit treasury, lock in pool
      state.debit(poaPublicKey, 1000);
      state.pools.set("market-1", {
        marketId: "market-1",
        sharesA: 500,
        sharesB: 500,
        k: 250000,
        wpmLocked: 1000,
      });
      const violations = checkPostBlockInvariants(state);
      expect(violations).toEqual([]);
    });
  });

  describe("INV-3: No negative balances", () => {
    it("detects negative balance", () => {
      const state = buildState();
      state.setBalance("bob", -5);
      const violations = checkPostBlockInvariants(state);
      const inv3 = violations.find((v) => v.id === "INV-3");
      expect(inv3).toBeDefined();
      expect(inv3!.critical).toBe(false);
      expect(inv3!.message).toContain("bob");
      expect(inv3!.message).toContain("-5");
    });

    it("passes with zero balance", () => {
      const state = buildState();
      state.setBalance("bob", 0);
      const violations = checkPostBlockInvariants(state);
      expect(violations).toEqual([]);
    });
  });

  describe("INV-4: No negative shares", () => {
    it("detects negative shares", () => {
      const state = buildState();
      state.setSharePosition("alice", "market-1", "A", {
        shares: -1,
        costBasis: 0,
      });
      const violations = checkPostBlockInvariants(state);
      const inv4 = violations.find((v) => v.id === "INV-4");
      expect(inv4).toBeDefined();
      expect(inv4!.critical).toBe(false);
      expect(inv4!.message).toContain("alice");
      expect(inv4!.message).toContain("-1");
    });

    it("passes with zero shares", () => {
      const state = buildState();
      state.setSharePosition("alice", "market-1", "A", {
        shares: 0,
        costBasis: 0,
      });
      const violations = checkPostBlockInvariants(state);
      expect(violations).toEqual([]);
    });
  });

  describe("INV-5: Pool k only increases", () => {
    it("passes when k increases", () => {
      const result = checkPoolKInvariant(250000, 260000, "market-1");
      expect(result).toBeNull();
    });

    it("passes when k stays the same", () => {
      const result = checkPoolKInvariant(250000, 250000, "market-1");
      expect(result).toBeNull();
    });

    it("detects k decrease", () => {
      const result = checkPoolKInvariant(260000, 250000, "market-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("INV-5");
      expect(result!.message).toContain("market-1");
    });
  });

  describe("INV-2: Price sum equals 1.00", () => {
    it("passes with balanced pool", () => {
      const result = checkPriceSumInvariant("market-1", 500, 500);
      expect(result).toBeNull();
    });

    it("passes with imbalanced pool (math still sums to 1)", () => {
      const result = checkPriceSumInvariant("market-1", 300, 700);
      expect(result).toBeNull();
    });

    it("detects violation when pool is broken", () => {
      // This can't naturally happen with the formula, but test the guard
      // sharesA=0 would cause division issues - use a proxy test
      const result = checkPriceSumInvariant("market-1", 0, 0);
      // 0/0 = NaN, so sum would be NaN which is not within tolerance
      expect(result).not.toBeNull();
      expect(result!.id).toBe("INV-2");
    });
  });

  describe("handleViolations", () => {
    it("throws on critical violation (INV-1)", () => {
      const violations = [
        { id: "INV-1", message: "supply mismatch", critical: true },
      ];
      expect(() => handleViolations(violations, 5)).toThrow(
        "Critical invariant violation INV-1",
      );
    });

    it("does not throw on non-critical violations", () => {
      const violations = [
        { id: "INV-3", message: "negative balance", critical: false },
        { id: "INV-4", message: "negative shares", critical: false },
      ];
      expect(() => handleViolations(violations, 5)).not.toThrow();
    });
  });
});
