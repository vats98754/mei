import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { isAddressEqual, type Address, type LocalAccount } from "viem";
import { BASE_CAIP2, USDC_BASE } from "./chain.js";

/**
 * Bitrefill's account MCP server. US prepaid Visa/Mastercard need a cardholder
 * "prepayment" form, which only this API accepts; the wallet-only /x402 storefront
 * rejects them. The account only creates orders: the agent wallet pays each
 * invoice's x402_payment_url itself, so no balance is ever held at Bitrefill.
 * https://docs.bitrefill.com/docs/ecommerce-mcp
 */
export const BITREFILL_MCP = "https://api.bitrefill.com/mcp";
export const BITREFILL_PAY_TO: Address = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";

export class BitrefillError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "BitrefillError";
  }
}

/** The subset of Bitrefill's MCP tools mei uses; tool results are parsed JSON. */
export interface BitrefillApi {
  call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function parseToolText(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : { value };
  } catch {
    return { text };
  }
}

export class BitrefillMcp implements BitrefillApi {
  private client?: Promise<Client>;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = BITREFILL_MCP,
  ) {}

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: "mei", version: "0.2.0" });
      const url = new URL(`${this.baseUrl}/${encodeURIComponent(this.apiKey)}`);
      await client.connect(new StreamableHTTPClientTransport(url));
      return client;
    })().catch((err) => {
      this.client = undefined;
      throw new BitrefillError("connect", `Could not connect to Bitrefill MCP: ${(err as Error).message}`);
    });
    return this.client;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = await this.connect();
    const result = await client.callTool({ name: tool, arguments: args });
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const body = parseToolText(text);
    if (result.isError) throw new BitrefillError(tool, `Bitrefill ${tool} failed: ${text.slice(0, 500)}`, body);
    return body;
  }
}

/** A Base USDC payment requirement read from an x402 402 response. */
export interface X402Quote {
  method: "GET" | "POST";
  amount: bigint;
  payTo: Address;
}

interface Requirement {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
}

async function requirementsFrom(res: Response): Promise<Requirement[]> {
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      return JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts ?? [];
    } catch {}
  }
  try {
    return ((await res.json()) as { accepts?: Requirement[] }).accepts ?? [];
  } catch {
    return [];
  }
}

function isBaseUsdc(r: Requirement, payTo: Address[]): boolean {
  return (
    r.scheme === "exact" &&
    r.network === BASE_CAIP2 &&
    isAddressEqual(r.asset as Address, USDC_BASE) &&
    payTo.some((a) => isAddressEqual(r.payTo as Address, a))
  );
}

/**
 * Pays Bitrefill invoices over x402 from the agent wallet. Payment is an EIP-3009
 * authorization, so the agent needs USDC on Base but no ETH for gas.
 */
export class X402Payer {
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    private readonly account: LocalAccount,
    options: { fetch?: typeof globalThis.fetch } = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** Reads what `url` asks to be paid without paying it. */
  async quote(url: string, allowedPayTo: Address[] = [BITREFILL_PAY_TO]): Promise<X402Quote> {
    let method: X402Quote["method"] = "GET";
    let res = await this.fetch(url, { method });
    if (res.status === 404 || res.status === 405) {
      method = "POST";
      res = await this.fetch(url, { method, headers: { "content-type": "application/json" }, body: "{}" });
    }
    if (res.status !== 402) {
      throw new Error(`Expected a 402 payment request from ${url}, got ${res.status}.`);
    }
    const match = (await requirementsFrom(res)).find((r) => isBaseUsdc(r, allowedPayTo));
    if (!match) throw new Error("Bitrefill did not offer a USDC-on-Base payment to its own address; refusing.");
    return { method, amount: BigInt(match.amount), payTo: match.payTo as Address };
  }

  /** Pays `url`, signing only a requirement that matches `quote` exactly. */
  async pay(url: string, quote: X402Quote): Promise<Record<string, unknown>> {
    const payFetch = wrapFetchWithPaymentFromConfig(this.fetch, {
      schemes: [{ network: BASE_CAIP2, client: new ExactEvmScheme(this.account) }],
      // The selector pins asset, recipient and exact amount, a tighter bound than a USD cap.
      spendControls: false,
      paymentRequirementsSelector: (_version, requirements) => {
        const match = requirements.find(
          (r) => isBaseUsdc(r as Requirement, [quote.payTo]) && BigInt(r.amount) === quote.amount,
        );
        if (!match) {
          throw new Error(`Bitrefill did not request exactly ${quote.amount} atomic USDC on Base; refusing to pay.`);
        }
        return match;
      },
    });
    const res = await payFetch(
      url,
      quote.method === "GET"
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`x402 payment failed (${res.status}): ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
}
