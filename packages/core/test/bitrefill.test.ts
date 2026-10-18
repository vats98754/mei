import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { BITREFILL_API, BITREFILL_PAY_TO, BitrefillClient, BitrefillError } from "../src/bitrefill.js";

const account = privateKeyToAccount(generatePrivateKey());
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const merged = input instanceof Request ? { method: input.method, headers: Object.fromEntries(input.headers), ...init } : init;
    calls.push({ url, init: merged });
    return handler(url, merged);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function header(init: RequestInit, name: string): string | undefined {
  const h = new Headers(init.headers as HeadersInit);
  return h.get(name) ?? undefined;
}

function siwxChallenge(uri: string) {
  return Response.json(
    {
      x402Version: 2,
      error: "Payment required",
      accepts: [],
      extensions: {
        "sign-in-with-x": {
          info: {
            domain: "api.bitrefill.com",
            uri,
            version: "1",
            nonce: "efa48e7f389ff04993476dc5fd4c67b2",
            issuedAt: new Date().toISOString(),
            expirationTime: new Date(Date.now() + 300_000).toISOString(),
            statement: "Sign in to Bitrefill.",
            resources: [uri],
          },
          supportedChains: [{ chainId: "eip155:8453", type: "eip191" }],
        },
      },
    },
    { status: 402 },
  );
}

function paymentRequired(url: string, amount: string) {
  const body = {
    x402Version: 2,
    error: "Payment required",
    resource: { url, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount,
        asset: USDC,
        payTo: BITREFILL_PAY_TO,
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

describe("BitrefillClient", () => {
  it("signs in with SIWX, then sends the session token", async () => {
    const { fetch, calls } = mockFetch((url, init) => {
      if (url.endsWith("/x402/connect")) {
        const siwx = header(init, "sign-in-with-x");
        if (!siwx) return siwxChallenge(url);
        const payload = JSON.parse(Buffer.from(siwx, "base64").toString("utf8"));
        expect(payload.address).toBe(account.address);
        expect(payload.chainId).toBe("eip155:8453");
        expect(payload.signature).toMatch(/^0x[0-9a-f]+$/);
        return Response.json({ token: "jwt-1", token_header: "X-Access-Token", expires_in: 7200 });
      }
      expect(header(init, "X-Access-Token")).toBe("jwt-1");
      return Response.json({ products: [{ slug: "amazon_com-usa" }], found: 1, page: 1, per_page: 20 });
    });
    const client = new BitrefillClient(account, { fetch });
    const result = await client.search("amazon", "US");
    expect(result.products[0]?.slug).toBe("amazon_com-usa");
    expect(calls.map((c) => c.url)).toEqual([
      `${BITREFILL_API}/x402/connect`,
      `${BITREFILL_API}/x402/connect`,
      `${BITREFILL_API}/x402/gift-cards/search?q=amazon&country=US`,
    ]);
  });

  it("surfaces Bitrefill's agent instructions on refusal", async () => {
    const { fetch } = mockFetch((url, init) => {
      if (url.endsWith("/x402/connect")) {
        return header(init, "sign-in-with-x") ? Response.json({ token: "t" }) : siwxChallenge(url);
      }
      return Response.json(
        {
          error_code: "INVALID_PACKAGE",
          field: "bill_payment",
          agent_instructions: "Bill payment is not available on x402.",
        },
        { status: 400 },
      );
    });
    const client = new BitrefillClient(account, { fetch });
    const err = await client
      .createInvoice([{ product_id: "virtual-prepaid-visa-usa", package_value: "20" }])
      .catch((e) => e);
    expect(err).toBeInstanceOf(BitrefillError);
    expect(err.code).toBe("INVALID_PACKAGE");
    expect(err.agentInstructions).toMatch(/not available on x402/);
  });

  it("pays only when Bitrefill asks for exactly the expected amount", async () => {
    const { fetch, calls } = mockFetch((url, init) => {
      if (header(init, "payment-signature")) return Response.json({ success: true, status: "payment_confirmed" });
      return paymentRequired(url, "21010000");
    });
    const client = new BitrefillClient(account, { fetch });

    await expect(client.pay("inv-1", 21_000_000n)).rejects.toThrow(/refusing to pay/);
    expect(calls.some((c) => header(c.init, "payment-signature"))).toBe(false);

    await expect(client.pay("inv-1", 21_010_000n)).resolves.toMatchObject({ success: true });
    const paid = calls.find((c) => header(c.init, "payment-signature"))!;
    const payload = JSON.parse(Buffer.from(header(paid.init, "payment-signature")!, "base64").toString("utf8"));
    expect(payload.accepted.amount).toBe("21010000");
    expect(payload.payload.authorization.from).toBe(account.address);
    expect(payload.payload.authorization.to).toBe(BITREFILL_PAY_TO);
  });
});
