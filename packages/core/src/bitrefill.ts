import { ExactEvmScheme } from "@x402/evm";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { isAddressEqual, type Address, type LocalAccount } from "viem";
import { NETWORKS } from "./chain.js";

/**
 * Client for Bitrefill's wallet-only x402 API: no Bitrefill account, the agent's
 * wallet signs in with SIWX and pays invoices in USDC on Base.
 * https://docs.cdp.coinbase.com/coinbase-for-agents/wallet-mcp/plugins/bitrefill
 */
export const BITREFILL_API = "https://api.bitrefill.com";
export const BITREFILL_PAY_TO: Address = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";
const BASE_CAIP2 = "eip155:8453";
const SIWX = "sign-in-with-x";

export interface ProductSummary {
  slug: string;
  name: string;
  countries: string[];
  currency: string;
  in_stock: boolean;
  categories: string[];
  type?: string;
}

export interface SearchResult {
  products: ProductSummary[];
  found: number;
  page: number;
  per_page: number;
}

export interface ProductPackage {
  package_value: string;
  package_currency: string;
  payment_price: string;
  payment_currency: string;
}

export interface ProductDetail {
  id: string;
  name: string;
  country_code: string;
  currency: string;
  in_stock: boolean;
  categories: string[];
  packages: ProductPackage[];
  range?: { min: number; max: number; step: number; currency: string; note?: string };
  recipient_required: boolean;
  /** Present on "bill payment" products, which x402 does not sell. */
  prepayment?: unknown;
  instructions?: string;
}

export interface InvoiceItem {
  product_id: string;
  package_value: string;
  refill_input?: string;
}

export interface Invoice {
  invoice_id: string;
  /** Atomic USDC units. */
  price_usdc: string;
  price_usd: number;
  expires_in_minutes: number;
}

export interface RedemptionInfo {
  code?: string;
  pin?: string;
  link?: string;
  instructions?: string;
  expiration_date?: string;
  extra_fields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InvoiceStatus {
  status?: string;
  delivery_status?: string;
  redemption_info?: { orders?: { product_id?: string; redemption_info?: RedemptionInfo }[] };
  [key: string]: unknown;
}

export class BitrefillError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string | undefined,
    readonly agentInstructions: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "BitrefillError";
  }
}

async function errorFrom(res: Response): Promise<BitrefillError> {
  const text = await res.text();
  let body: { error_code?: string; agent_instructions?: string; error?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {}
  const detail = body.agent_instructions ?? body.error ?? text.slice(0, 300);
  return new BitrefillError(
    res.status,
    body.error_code,
    body.agent_instructions,
    `Bitrefill ${res.status}${body.error_code ? ` ${body.error_code}` : ""}: ${detail}`,
  );
}

interface SIWxChallenge {
  info: Record<string, unknown>;
  supportedChains: { chainId: string; type: string }[];
}

/** Reads the SIWX challenge from a 402, from the JSON body or the payment-required header. */
async function readChallenge(res: Response): Promise<SIWxChallenge> {
  let body: { extensions?: Record<string, SIWxChallenge> } | undefined;
  try {
    body = await res.json();
  } catch {}
  let challenge = body?.extensions?.[SIWX];
  const header = res.headers.get("payment-required");
  if (!challenge && header) {
    challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")).extensions?.[SIWX];
  }
  if (!challenge) throw new BitrefillError(res.status, undefined, undefined, "Expected a SIWX challenge.");
  return challenge;
}

export class BitrefillClient {
  private token?: { value: string; expiresAt: number };
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(
    private readonly account: LocalAccount,
    options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
  ) {
    this.baseUrl = options.baseUrl ?? BITREFILL_API;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** Answers a 402 SIWX challenge for `url` by signing with the agent wallet, then retries. */
  private async withSIWx(url: string, init: RequestInit): Promise<Response> {
    const first = await this.fetch(url, init);
    if (first.status !== 402) return first;
    const challenge = await readChallenge(first);
    const chain = challenge.supportedChains.find((c) => c.chainId === BASE_CAIP2);
    if (!chain) throw new Error("Bitrefill SIWX challenge does not offer Base.");
    const payload = await createSIWxPayload(
      { ...challenge.info, chainId: chain.chainId, type: chain.type } as Parameters<
        typeof createSIWxPayload
      >[0],
      this.account,
      url,
    );
    return this.fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), [SIWX]: encodeSIWxHeader(payload) },
    });
  }

  /** Mints a session token (~2h) that waives micro-fees on every route except invoice/pay. */
  async connect(): Promise<void> {
    const res = await this.withSIWx(`${this.baseUrl}/x402/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw await errorFrom(res);
    const { token, expires_in } = (await res.json()) as { token: string; expires_in?: number };
    this.token = { value: token, expiresAt: Date.now() + ((expires_in ?? 7200) - 60) * 1000 };
  }

  private async authed<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    if (!this.token || Date.now() >= this.token.expiresAt) await this.connect();
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        "X-Access-Token": this.token!.value,
      },
    });
    if ((res.status === 401 || res.status === 402) && !retried) {
      this.token = undefined;
      return this.authed(path, init, true);
    }
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as T;
  }

  search(query: string, country?: string): Promise<SearchResult> {
    const params = new URLSearchParams({ q: query });
    if (country) params.set("country", country);
    return this.authed(`/x402/gift-cards/search?${params}`);
  }

  product(slug: string): Promise<ProductDetail> {
    return this.authed(`/x402/products/detail?${new URLSearchParams({ slug })}`);
  }

  createInvoice(items: InvoiceItem[]): Promise<Invoice> {
    return this.authed("/x402/invoice/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
  }

  /**
   * Pays an invoice with an EIP-3009 authorization from the agent wallet. Only a
   * requirement for exactly `expectedAmount` USDC on Base to Bitrefill is accepted.
   */
  async pay(invoiceId: string, expectedAmount: bigint): Promise<Record<string, unknown>> {
    const usdc = NETWORKS.base.usdc;
    const payFetch = wrapFetchWithPaymentFromConfig(this.fetch, {
      schemes: [{ network: BASE_CAIP2, client: new ExactEvmScheme(this.account) }],
      // The selector below pins the exact amount, which is a tighter bound than a USD cap.
      spendControls: false,
      paymentRequirementsSelector: (_version, requirements) => {
        const match = requirements.find(
          (r) =>
            r.scheme === "exact" &&
            r.network === BASE_CAIP2 &&
            isAddressEqual(r.asset as Address, usdc) &&
            isAddressEqual(r.payTo as Address, BITREFILL_PAY_TO) &&
            BigInt(r.amount) === expectedAmount,
        );
        if (!match) {
          throw new Error(
            `Bitrefill did not request exactly ${expectedAmount} atomic USDC on Base; refusing to pay.`,
          );
        }
        return match;
      },
    });
    const res = await payFetch(`${this.baseUrl}/x402/invoice/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoice_id: invoiceId }),
    });
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Invoice status. Redemption codes are only returned to the wallet that paid,
   * so this signs a SIWX challenge for the exact status URL.
   */
  async status(invoiceId: string): Promise<InvoiceStatus> {
    const url = `${this.baseUrl}/x402/invoice/status?${new URLSearchParams({ invoice_id: invoiceId })}`;
    const res = await this.withSIWx(url, { method: "GET" });
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as InvoiceStatus;
  }
}
