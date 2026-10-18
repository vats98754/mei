import { BITREFILL_PAY_TO } from "../src/bitrefill.js";
import { USDC_BASE } from "../src/chain.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

export function mockFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const merged = input instanceof Request ? { method: input.method, headers: Object.fromEntries(input.headers), ...init } : init;
    calls.push({ url, init: merged });
    return handler(url, merged);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export function header(init: RequestInit, name: string): string | undefined {
  return new Headers(init.headers as HeadersInit).get(name) ?? undefined;
}

export function paymentRequired(url: string, amount: string, payTo: string = BITREFILL_PAY_TO) {
  const body = {
    x402Version: 2,
    error: "Payment required",
    resource: { url, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount,
        asset: USDC_BASE,
        payTo,
        maxTimeoutSeconds: 1800,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
    },
  });
}
