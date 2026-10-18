import { formatUsdc, parseUsdc } from "./usdc.js";

/**
 * Local spending rules, enforced before any money moves. These sit on top of the
 * agent wallet's USDC balance, which is the hard cap the agent cannot exceed.
 * Amounts are decimal USD strings.
 */
export interface Policy {
  maxPerPurchase: string;
  maxPerDay: string;
  /** Purchases above this amount need explicit human confirmation. */
  approvalAbove: string;
  /** Product slugs the agent may buy; a trailing "*" matches a prefix. Empty or absent = any. */
  allowProducts?: string[];
  denyProducts?: string[];
}

export const DEFAULT_POLICY: Policy = {
  maxPerPurchase: "50",
  maxPerDay: "100",
  approvalAbove: "25",
};

export interface SpendRecord {
  at: number;
  amount: bigint;
}

export type PolicyDecision =
  | { allowed: true; needsApproval: boolean }
  | { allowed: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function matches(patterns: string[], productId: string): boolean {
  return patterns.some((p) =>
    p.endsWith("*") ? productId.startsWith(p.slice(0, -1)) : p === productId,
  );
}

export function spentInLastDay(history: SpendRecord[], now: number): bigint {
  return history
    .filter((r) => now - r.at < DAY_MS)
    .reduce((sum, r) => sum + r.amount, 0n);
}

export function checkPurchase(
  policy: Policy,
  request: { productId: string; amount: bigint },
  history: SpendRecord[],
  now = Date.now(),
): PolicyDecision {
  const { productId, amount } = request;

  if (policy.denyProducts?.length && matches(policy.denyProducts, productId)) {
    return { allowed: false, reason: `Product ${productId} is on the deny list.` };
  }
  if (policy.allowProducts?.length && !matches(policy.allowProducts, productId)) {
    return { allowed: false, reason: `Product ${productId} is not on the allow list.` };
  }

  const maxPerPurchase = parseUsdc(policy.maxPerPurchase);
  if (amount > maxPerPurchase) {
    return {
      allowed: false,
      reason: `Price ${formatUsdc(amount)} USDC exceeds the per-purchase limit of ${policy.maxPerPurchase} USDC.`,
    };
  }

  const spent = spentInLastDay(history, now);
  const maxPerDay = parseUsdc(policy.maxPerDay);
  if (spent + amount > maxPerDay) {
    return {
      allowed: false,
      reason: `Purchase would bring 24h spend to ${formatUsdc(spent + amount)} USDC, over the daily limit of ${policy.maxPerDay} USDC.`,
    };
  }

  return { allowed: true, needsApproval: amount > parseUsdc(policy.approvalAbove) };
}
