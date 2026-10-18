import type { Address } from "viem";
import { usdcBalance, type PublicClient } from "./chain.js";
import { checkPurchase } from "./policy.js";
import type { MeiConfig, Store } from "./store.js";
import { formatUsdc } from "./usdc.js";
import type { InvoiceStatus, X402Store } from "./x402store.js";

export interface GiftCardDeps {
  store: Store;
  config: MeiConfig;
  shop: X402Store;
  agent: Address;
  publicClient: PublicClient;
  /** Asks the human to approve; resolves false if declined or unavailable. */
  confirm: (message: string) => Promise<boolean>;
}

export interface GiftCardResult {
  invoiceId: string;
  /** USDC charged, including Bitrefill's fee. */
  charged: string;
  delivered: boolean;
  status: InvoiceStatus;
}

export class PurchaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseRefused";
  }
}

const DELIVERED = "all_delivered";

export async function waitForDelivery(
  shop: X402Store,
  invoiceId: string,
  { timeoutMs = 90_000, intervalMs = 5_000 } = {},
): Promise<InvoiceStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await shop.status(invoiceId);
  while (status.delivery_status !== DELIVERED && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    status = await shop.status(invoiceId);
  }
  return status;
}

// One purchase at a time, so the daily cap can't be raced by parallel tool calls.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Gift cards through Bitrefill's wallet-only x402 API: no account, gasless, and the
 * invoice quotes an exact USDC amount that the payment is pinned to.
 * invoice → policy + balance check on the quoted price → human approval if over
 * threshold → pay from the agent wallet → poll for the code.
 */
export function buyGiftCard(
  deps: GiftCardDeps,
  item: { product_id: string; package_value: string; refill_input?: string },
): Promise<GiftCardResult> {
  const run = queue.then(() => buyGiftCardNow(deps, item));
  queue = run.catch(() => {});
  return run;
}

async function buyGiftCardNow(
  deps: GiftCardDeps,
  item: { product_id: string; package_value: string; refill_input?: string },
): Promise<GiftCardResult> {
  const { store, config, shop, agent, publicClient } = deps;

  const invoice = await shop.createInvoice([item]);
  const amount = BigInt(invoice.price_usdc);
  const priceText = `${formatUsdc(amount)} USDC`;

  const decision = checkPurchase(config.policy, { productId: item.product_id, amount }, store.spendHistory());
  if (!decision.allowed) throw new PurchaseRefused(decision.reason);

  const balance = await usdcBalance(publicClient, agent);
  if (balance < amount) {
    throw new PurchaseRefused(
      `This costs ${priceText} but the agent wallet ${agent} holds ${formatUsdc(balance)} USDC on Base. Ask the user to send more.`,
    );
  }

  if (decision.needsApproval) {
    const approved = await deps.confirm(`Approve buying ${item.product_id} (${item.package_value}) for ${priceText}?`);
    if (!approved) throw new PurchaseRefused("The human declined (or could not be asked to approve) this purchase.");
  }

  const record = {
    at: Date.now(),
    invoiceId: invoice.invoice_id,
    productId: item.product_id,
    packageValue: item.package_value,
    amount: amount.toString(),
  };
  try {
    await shop.pay(invoice.invoice_id, amount);
  } catch (err) {
    // The authorization may have been submitted before the error, so this still counts toward the daily cap.
    store.appendPurchase({ ...record, status: "failed", error: (err as Error).message });
    throw err;
  }
  store.appendPurchase({ ...record, status: "paid" });

  const status = await waitForDelivery(shop, invoice.invoice_id);
  return {
    invoiceId: invoice.invoice_id,
    charged: formatUsdc(amount),
    delivered: status.delivery_status === DELIVERED,
    status,
  };
}
