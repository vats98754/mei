import type { Address } from "viem";
import { BITREFILL_PAY_TO, BitrefillError, type BitrefillApi, type X402Payer } from "./bitrefill.js";
import { usdcBalance, type PublicClient } from "./chain.js";
import { checkPurchase } from "./policy.js";
import type { MeiConfig, Store } from "./store.js";
import { formatUsdc, parseUsdc } from "./usdc.js";

export const CARD_PRODUCTS = {
  visa: "virtual-prepaid-visa-usa",
  mastercard: "virtual-prepaid-mastercard-usa",
} as const;

export type CardBrand = keyof typeof CARD_PRODUCTS;

export interface CardDeps {
  store: Store;
  config: MeiConfig;
  bitrefill: BitrefillApi;
  payer: X402Payer;
  agent: Address;
  publicClient: PublicClient;
  /** Asks the human to approve; resolves false if declined or unavailable. */
  confirm: (message: string) => Promise<boolean>;
}

export interface CardResult {
  invoiceId: string;
  /** USDC charged, including Bitrefill's fee. */
  charged: string;
  faceValue: string;
  status: string;
  delivered: boolean;
  /** Card number, CVV, expiry etc. as Bitrefill returns them; never written to disk. */
  card?: unknown;
}

export class PurchaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseRefused";
  }
}

const DONE = "complete";
const FAILED = new Set(["blocked", "denied", "payment_error", "expired"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined;
}

/** Field names a non-final prepayment step asks for; Bitrefill does not document the shape. */
function requestedFields(step: Record<string, unknown>): string[] {
  const form = (step.form ?? step.next_form ?? step) as Record<string, unknown>;
  const fields = (form.fields ?? form.form_fields ?? []) as unknown;
  if (!Array.isArray(fields)) return Object.keys(fields as object);
  return fields.map((f) => (typeof f === "string" ? f : str((f as { name?: unknown }).name))).filter(Boolean) as string[];
}

/** Walks the cardholder form until Bitrefill returns a bill_payment_id. */
export async function submitCardholder(
  api: BitrefillApi,
  productId: string,
  cardholder: Record<string, string>,
): Promise<string> {
  let stepNumber = 1;
  let formData: Record<string, string> = cardholder;
  for (let i = 0; i < 6; i++) {
    const step = await api.call("submit-prepayment-step", {
      product_id: productId,
      step_number: stepNumber,
      form_data: formData,
    });
    const billPaymentId = str(step.bill_payment_id);
    if (billPaymentId) return billPaymentId;
    if (step.step === "final") {
      throw new BitrefillError("submit-prepayment-step", "Final prepayment step returned no bill_payment_id.", step);
    }
    const fields = requestedFields(step);
    const missing = fields.filter((f) => !(f in cardholder));
    if (missing.length || !fields.length) {
      throw new PurchaseRefused(
        `Bitrefill's cardholder form needs ${missing.join(", ") || "fields mei could not read"}. Set them with \`mei cardholder key=value\`. Form: ${JSON.stringify(step).slice(0, 500)}`,
      );
    }
    formData = Object.fromEntries(fields.map((f) => [f, cardholder[f]!]));
    stepNumber = typeof step.step === "number" ? step.step : stepNumber + 1;
  }
  throw new BitrefillError("submit-prepayment-step", "Cardholder form did not finish after 6 steps.");
}

function invoiceStatus(invoice: Record<string, unknown>): string {
  return str(invoice.status) ?? str((invoice.invoice as Record<string, unknown> | undefined)?.status) ?? "unknown";
}

function cardDetails(invoice: Record<string, unknown>): unknown {
  const orders = (invoice.orders ?? (invoice.invoice as Record<string, unknown> | undefined)?.orders) as
    | { redemption_info?: unknown }[]
    | undefined;
  return orders?.find((o) => o.redemption_info)?.redemption_info;
}

export async function getCard(
  api: BitrefillApi,
  invoiceId: string,
): Promise<{ status: string; delivered: boolean; card?: unknown }> {
  const invoice = await api.call("get-invoice-by-id", { invoice_id: invoiceId });
  const status = invoiceStatus(invoice);
  const card = cardDetails(invoice);
  return { status, delivered: status === DONE && card !== undefined, card };
}

export async function waitForCard(
  api: BitrefillApi,
  invoiceId: string,
  { timeoutMs = 90_000, intervalMs = 5_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let result = await getCard(api, invoiceId);
  while (!result.delivered && !FAILED.has(result.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    result = await getCard(api, invoiceId);
  }
  return result;
}

// One purchase at a time, so the daily cap can't be raced by parallel tool calls.
let queue: Promise<unknown> = Promise.resolve();

export function buyCard(deps: CardDeps, request: { brand: CardBrand; amount: string }): Promise<CardResult> {
  const run = queue.then(() => buyCardNow(deps, request));
  queue = run.catch(() => {});
  return run;
}

/**
 * policy pre-check on face value → cardholder form → invoice → read the exact x402
 * price → policy + balance check on that price → human approval if over threshold →
 * pay from the agent wallet → poll for card details.
 */
async function buyCardNow(deps: CardDeps, { brand, amount }: { brand: CardBrand; amount: string }): Promise<CardResult> {
  const { store, config, bitrefill, payer, agent, publicClient } = deps;
  const productId = CARD_PRODUCTS[brand];
  const faceValue = parseUsdc(amount);
  if (faceValue <= 0n) throw new PurchaseRefused("Amount must be positive.");

  // Bitrefill adds a fee, so a face value over the limits can never pass; fail before any API call.
  const early = checkPurchase(config.policy, { productId, amount: faceValue }, store.spendHistory());
  if (!early.allowed) throw new PurchaseRefused(early.reason);

  const cardholder = config.cardholder;
  if (!cardholder?.first_name || !cardholder?.last_name) {
    throw new PurchaseRefused("No cardholder name set; run `mei cardholder first_name=… last_name=…`.");
  }

  const billPaymentId = await submitCardholder(bitrefill, productId, cardholder);
  const invoice = await bitrefill.call("buy-products", {
    cart_items: [{ product_id: productId, package_id: amount, bill_payment_id: billPaymentId }],
    payment_method: "usdc_base",
    return_payment_link: false,
  });
  const invoiceId = str(invoice.invoice_id) ?? str(invoice.id);
  const payUrl = str(invoice.x402_payment_url);
  if (!invoiceId || !payUrl) {
    throw new BitrefillError("buy-products", "Invoice has no invoice_id or x402_payment_url.", invoice);
  }

  const paymentInfo = invoice.payment_info as { address?: string } | undefined;
  const allowedPayTo: Address[] = [BITREFILL_PAY_TO];
  if (paymentInfo?.address?.startsWith("0x")) allowedPayTo.push(paymentInfo.address as Address);
  const quote = await payer.quote(payUrl, allowedPayTo);
  const priceText = `${formatUsdc(quote.amount)} USDC`;

  const decision = checkPurchase(config.policy, { productId, amount: quote.amount }, store.spendHistory());
  if (!decision.allowed) throw new PurchaseRefused(decision.reason);

  const balance = await usdcBalance(publicClient, agent);
  if (balance < quote.amount) {
    throw new PurchaseRefused(
      `The card costs ${priceText} but the agent wallet ${agent} holds ${formatUsdc(balance)} USDC on Base. Ask the user to send more.`,
    );
  }

  if (decision.needsApproval) {
    const approved = await deps.confirm(`Approve a $${amount} prepaid ${brand} card for ${priceText}?`);
    if (!approved) throw new PurchaseRefused("The human declined (or could not be asked to approve) this purchase.");
  }

  const record = {
    at: Date.now(),
    invoiceId,
    productId,
    packageValue: amount,
    amount: quote.amount.toString(),
  };
  try {
    await payer.pay(payUrl, quote);
  } catch (err) {
    // The authorization may have been submitted before the error, so this still counts toward the daily cap.
    store.appendPurchase({ ...record, status: "failed", error: (err as Error).message });
    throw err;
  }
  store.appendPurchase({ ...record, status: "paid" });

  const result = await waitForCard(bitrefill, invoiceId);
  return {
    invoiceId,
    charged: formatUsdc(quote.amount),
    faceValue: amount,
    ...result,
  };
}
