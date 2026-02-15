import { beforeEach, describe, expect, it } from "vitest";
import {
  clearNat64PrefixStats,
  rankNat64Prefixes,
  recordNat64PrefixResult,
} from "../../src/socket/nat64-health.js";

describe("nat64-health", () => {
  beforeEach(() => {
    clearNat64PrefixStats();
  });

  it("should keep input order when there is no health data", () => {
    const prefixes = ["p1", "p2", "p3"];
    expect(rankNat64Prefixes(prefixes)).toEqual(prefixes);
  });

  it("should prefer healthy/fast prefixes", () => {
    const prefixes = ["p1", "p2", "p3"];

    recordNat64PrefixResult("p1", false, 900);
    recordNat64PrefixResult("p2", true, 80);

    const ranked = rankNat64Prefixes(prefixes);
    expect(ranked[0]).toBe("p2");
  });

  it("should reset ranking after clear", () => {
    const prefixes = ["p1", "p2", "p3"];

    recordNat64PrefixResult("p1", false, 900);
    recordNat64PrefixResult("p2", true, 80);
    clearNat64PrefixStats();

    expect(rankNat64Prefixes(prefixes)).toEqual(prefixes);
  });
});
