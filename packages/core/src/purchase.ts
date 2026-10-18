import type { Address } from "viem";
import { usdcBalance, type NetworkName, type PublicClient, type WalletClient } from "./chain.js";
import type { BitrefillClient, InvoiceItem, InvoiceStatus } from "./bitrefill.js";
import { checkPurchase } from "./policy.js";
import { budgetStatus, pullFromUser } from "./spend.js";
import type { MeiConfig, Store } from "./store.js";
import { formatUsdc } from "./usdc.js";

export interface PurchaseDeps {
  store: Store;
  config: MeiConfig;
  bitrefill: BitrefillClient;
  agent: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Asks the human to approve; resolves false if declined or unavailable. */
  confirm: (message: string) => Promise<boolean>;
}

export interface PurchaseResult {
  invoiceId: string;
  amount: string;
  spendTxs: string[];
  status: InvoiceStatus;
  delivered: boolean;
}

export class PurchaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseRefused";
  }
}

const DELIVERED = "all_delivered";

export async function waitForDelivery(
  bitrefill: BitrefillClient,
  invoiceId: string,
  { timeoutMs = 90_000, intervalMs = 5_000 } = {},
): Promise<InvoiceStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await bitrefill.status(invoiceId);
  while (status.delivery_status !== DELIVERED && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    status = await bitrefill.status(invoiceId);
  }
  return status;
}

/**
 * policy check → on-chain budget check → human approval if over threshold →
 * pull only the shortfall from the user's wallet → pay the invoice → poll delivery.
 */
export async function purchase(deps: PurchaseDeps, item: InvoiceItem): Promise<PurchaseResult> {
  const { store, config, bitrefill, agent, publicClient, walletClient } = deps;
  const network: NetworkName = config.network;
  if (network !== "base") {
    throw new PurchaseRefused("Bitrefill only accepts USDC on Base mainnet; switch network to `base`.");
  }
  if (!config.permission) {
    throw new PurchaseRefused("No spend permission linked; run `mei link <code>`.");
  }

  const invoice = await bitrefill.createInvoice([item]);
  const amount = BigInt(invoice.price_usdc);
  const priceText = `${formatUsdc(amount)} USDC`;

  const decision = checkPurchase(config.policy, { productId: item.product_id, amount }, store.spendHistory());
  if (!decision.allowed) throw new PurchaseRefused(decision.reason);

  const balance = await usdcBalance(publicClient, network, agent);
  const shortfall = amount > balance ? amount - balance : 0n;
  if (shortfall > 0n) {
    const budget = await budgetStatus(config.permission, config.rpcUrl);
    if (!budget.isActive) throw new PurchaseRefused("The spend permission is revoked, expired or not yet active.");
    if (budget.remainingSpend < shortfall) {
      throw new PurchaseRefused(
        `Needs ${formatUsdc(shortfall)} USDC from the user's wallet but only ${formatUsdc(budget.remainingSpend)} USDC remains this period (resets ${budget.nextPeriodStart.toISOString()}).`,
      );
    }
  }

  if (decision.needsApproval) {
    const approved = await deps.confirm(
      `Approve buying ${item.product_id} (${item.package_value}) for ${priceText}?`,
    );
    if (!approved) throw new PurchaseRefused("The human declined (or could not be asked to approve) this purchase.");
  }

  const record = {
    at: Date.now(),
    invoiceId: invoice.invoice_id,
    productId: item.product_id,
    packageValue: item.package_value,
    amount: amount.toString(),
    spendTxs: [] as string[],
  };

  try {
    if (shortfall > 0n) {
      record.spendTxs = await pullFromUser(config.permission, shortfall, { publicClient, walletClient }, config.rpcUrl);
    }
    await bitrefill.pay(invoice.invoice_id, amount);
  } catch (err) {
    store.appendPurchase({ ...record, status: "failed", error: (err as Error).message });
    throw err;
  }
  store.appendPurchase({ ...record, status: "paid" });

  const status = await waitForDelivery(bitrefill, invoice.invoice_id);
  return {
    invoiceId: invoice.invoice_id,
    amount: formatUsdc(amount),
    spendTxs: record.spendTxs,
    status,
    delivered: status.delivery_status === DELIVERED,
  };
}
