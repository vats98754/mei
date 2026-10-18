import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { X402Payer, type BitrefillApi } from "../src/bitrefill.js";
import { buyCard, PurchaseRefused, type CardDeps } from "../src/card.js";
import type { PublicClient } from "../src/chain.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { Store } from "../src/store.js";
import { header, mockFetch, paymentRequired } from "./helpers.js";

const account = privateKeyToAccount(generatePrivateKey());
const PAY_URL = "https://api.bitrefill.com/x402/invoice/pay?invoice_id=inv-1";
const CARD = { card_number: "4111111111111111", cvv: "123", expiration_date: "12/30" };

function fakeBitrefill(overrides: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    "submit-prepayment-step": () => ({ step: "final", bill_payment_id: "bp-1" }),
    "buy-products": () => ({ invoice_id: "inv-1", x402_payment_url: PAY_URL }),
    "get-invoice-by-id": () => ({ status: "complete", orders: [{ redemption_info: CARD }] }),
    ...overrides,
  };
  const api: BitrefillApi = {
    async call(tool, args) {
      calls.push({ tool, args });
      return handlers[tool]!(args) as Record<string, unknown>;
    },
  };
  return { api, calls };
}

function deps(opts: { price?: string; balance?: bigint; approve?: boolean; api?: BitrefillApi } = {}) {
  const { fetch, calls: payCalls } = mockFetch((url, init) =>
    header(init, "payment-signature") ? Response.json({ success: true }) : paymentRequired(url, opts.price ?? "21050000"),
  );
  const bitrefill = opts.api ? { api: opts.api, calls: [] } : fakeBitrefill();
  const confirms: string[] = [];
  const d: CardDeps = {
    store: new Store(mkdtempSync(join(tmpdir(), "mei-card-"))),
    config: { policy: DEFAULT_POLICY, cardholder: { first_name: "Jane", last_name: "Doe" } },
    bitrefill: bitrefill.api,
    payer: new X402Payer(account, { fetch }),
    agent: account.address,
    publicClient: { readContract: async () => opts.balance ?? 100_000_000n } as unknown as PublicClient,
    confirm: async (m) => {
      confirms.push(m);
      return opts.approve ?? false;
    },
  };
  return { d, payCalls, bitrefillCalls: bitrefill.calls, confirms };
}

describe("buyCard", () => {
  it("submits the cardholder, pays the invoice from the agent wallet and returns the card", async () => {
    const { d, payCalls, bitrefillCalls } = deps();
    const result = await buyCard(d, { brand: "visa", amount: "20" });

    expect(result).toMatchObject({ invoiceId: "inv-1", charged: "21.05", delivered: true, card: CARD });
    expect(bitrefillCalls[0]).toEqual({
      tool: "submit-prepayment-step",
      args: { product_id: "virtual-prepaid-visa-usa", step_number: 1, form_data: { first_name: "Jane", last_name: "Doe" } },
    });
    expect(bitrefillCalls[1]!.args).toMatchObject({
      cart_items: [{ product_id: "virtual-prepaid-visa-usa", package_id: "20", bill_payment_id: "bp-1" }],
      payment_method: "usdc_base",
    });
    expect(payCalls.some((c) => header(c.init, "payment-signature"))).toBe(true);
    expect(d.store.purchases()).toMatchObject([{ status: "paid", amount: "21050000" }]);
    expect(JSON.stringify(d.store.purchases())).not.toContain(CARD.card_number);
  });

  it("checks the policy against the charged price, fee included", async () => {
    const { d, payCalls } = deps({ price: "50500000" });
    await expect(buyCard(d, { brand: "visa", amount: "48" })).rejects.toThrow(/per-purchase limit/);
    expect(payCalls.some((c) => header(c.init, "payment-signature"))).toBe(false);
  });

  it("refuses before calling Bitrefill when the face value is already over the cap", async () => {
    const { d, bitrefillCalls } = deps();
    await expect(buyCard(d, { brand: "visa", amount: "500" })).rejects.toBeInstanceOf(PurchaseRefused);
    expect(bitrefillCalls).toEqual([]);
  });

  it("refuses when the agent wallet can't cover the price", async () => {
    const { d } = deps({ balance: 10_000_000n });
    await expect(buyCard(d, { brand: "visa", amount: "20" })).rejects.toThrow(/holds 10 USDC/);
  });

  it("asks the human above the approval threshold and stops on decline", async () => {
    const { d, confirms, payCalls } = deps({ price: "31000000" });
    await expect(buyCard(d, { brand: "mastercard", amount: "30" })).rejects.toThrow(/declined/);
    expect(confirms[0]).toMatch(/\$30 prepaid mastercard card for 31 USDC/);
    expect(payCalls.some((c) => header(c.init, "payment-signature"))).toBe(false);
  });

  it("answers a follow-up cardholder form step from the configured fields", async () => {
    let step = 0;
    const { api, calls } = fakeBitrefill({
      "submit-prepayment-step": () =>
        ++step === 1 ? { step: 2, form: { fields: [{ name: "zip_code" }] } } : { step: "final", bill_payment_id: "bp-2" },
    });
    const { d } = deps({ api });
    d.config.cardholder = { first_name: "Jane", last_name: "Doe", zip_code: "94107" };
    await buyCard(d, { brand: "visa", amount: "20" });
    expect(calls[1]!.args).toMatchObject({ step_number: 2, form_data: { zip_code: "94107" } });
  });

  it("names missing cardholder fields instead of guessing", async () => {
    const { api } = fakeBitrefill({
      "submit-prepayment-step": () => ({ step: 2, form: { fields: [{ name: "email" }] } }),
    });
    const { d } = deps({ api });
    await expect(buyCard(d, { brand: "visa", amount: "20" })).rejects.toThrow(/needs email/);
  });
});
