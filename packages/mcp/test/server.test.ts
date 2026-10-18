import { DEFAULT_POLICY, Store, X402Store, type PublicClient } from "@mei/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../src/context.js";
import { createServer } from "../src/server.js";


const fakeShop: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/x402/connect")) {
    if (new Headers(init?.headers).get("sign-in-with-x")) return Response.json({ token: "t", expires_in: 7200 });
    return Response.json(
      {
        extensions: {
          "sign-in-with-x": {
            info: { domain: "api.bitrefill.com", uri: url, version: "1", nonce: "abcdef0123456789", issuedAt: new Date().toISOString() },
            supportedChains: [{ chainId: "eip155:8453", type: "eip191" }],
          },
        },
      },
      { status: 402 },
    );
  }
  if (url.includes("/x402/gift-cards/search")) {
    return Response.json({
      products: [{ slug: "starbucks-usa", name: "Starbucks USA", countries: ["US"], currency: "USD", in_stock: true, categories: ["food"] }],
      found: 1,
      page: 1,
      per_page: 20,
    });
  }
  return new Response("not found", { status: 404 });
};

async function connect() {
  const account = privateKeyToAccount(generatePrivateKey());
  const ctx: AgentContext = {
    store: new Store(mkdtempSync(join(tmpdir(), "mei-mcp-"))),
    config: { policy: DEFAULT_POLICY },
    account,
    publicClient: { readContract: async () => 12_500_000n } as unknown as PublicClient,
    shop: new X402Store(account, { fetch: fakeShop }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return { client, account };
}

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first!.text);
}

describe("mei MCP server", () => {
  it("exposes the agent tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "buy_gift_card",
      "get_gift_card_order",
      "get_gift_card_product",
      "search_gift_cards",
      "wallet_status",
    ]);
  });

  it("reports the agent wallet balance", async () => {
    const { client, account } = await connect();
    const result = await client.callTool({ name: "wallet_status", arguments: {} });
    expect(body(result)).toMatchObject({ agent: account.address, usdc_on_base: "12.5" });
  });

  it("searches gift cards without an account", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "search_gift_cards", arguments: { query: "starbucks", country: "us" } });
    expect(result.isError).toBeFalsy();
    expect(body(result).products[0].slug).toBe("starbucks-usa");
  });
});
