import { describe, expect, it } from "vitest";
import { checkPurchase, DEFAULT_POLICY, type Policy } from "../src/policy.js";
import { formatUsdc, parseUsdc } from "../src/usdc.js";

const now = Date.UTC(2026, 9, 17, 12);
const HOUR = 60 * 60 * 1000;

describe("usdc", () => {
  it("parses decimal strings to atomic units", () => {
    expect(parseUsdc("21.01")).toBe(21_010_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(formatUsdc(21_010_000n)).toBe("21.01");
  });

  it("rejects malformed or over-precise amounts", () => {
    expect(() => parseUsdc("1e3")).toThrow();
    expect(() => parseUsdc("-5")).toThrow();
    expect(() => parseUsdc("1.0000001")).toThrow();
  });
});

describe("checkPurchase", () => {
  const policy: Policy = { ...DEFAULT_POLICY, maxPerPurchase: "50", maxPerDay: "100", approvalAbove: "25" };

  it("allows small purchases without approval", () => {
    expect(checkPurchase(policy, { productId: "amazon_com-usa", amount: parseUsdc("21.01") }, [], now)).toEqual({
      allowed: true,
      needsApproval: false,
    });
  });

  it("requires approval above the threshold", () => {
    expect(checkPurchase(policy, { productId: "steam-usa", amount: parseUsdc("30") }, [], now)).toEqual({
      allowed: true,
      needsApproval: true,
    });
  });

  it("refuses purchases over the per-purchase cap", () => {
    const d = checkPurchase(policy, { productId: "steam-usa", amount: parseUsdc("50.01") }, [], now);
    expect(d.allowed).toBe(false);
  });

  it("counts only the last 24 hours toward the daily cap", () => {
    const history = [
      { at: now - 2 * HOUR, amount: parseUsdc("45") },
      { at: now - 3 * HOUR, amount: parseUsdc("45") },
      { at: now - 30 * HOUR, amount: parseUsdc("50") },
    ];
    expect(checkPurchase(policy, { productId: "x", amount: parseUsdc("10") }, history, now).allowed).toBe(true);
    expect(checkPurchase(policy, { productId: "x", amount: parseUsdc("10.01") }, history, now).allowed).toBe(false);
  });

  it("applies allow and deny lists with prefix wildcards", () => {
    const listed: Policy = { ...policy, allowProducts: ["amazon*", "steam-usa"], denyProducts: ["amazon_uk*"] };
    const amount = parseUsdc("5");
    expect(checkPurchase(listed, { productId: "amazon_com-usa", amount }, [], now).allowed).toBe(true);
    expect(checkPurchase(listed, { productId: "steam-usa", amount }, [], now).allowed).toBe(true);
    expect(checkPurchase(listed, { productId: "amazon_uk-gb", amount }, [], now).allowed).toBe(false);
    expect(checkPurchase(listed, { productId: "uber-usa", amount }, [], now).allowed).toBe(false);
  });
});
