import { BitrefillClient, DEFAULT_POLICY, makeClients, Store } from "@mei/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../src/context.js";
import { createServer } from "../src/server.js";

const fakeBitrefill: typeof fetch = async (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  if (url.endsWith("/x402/connect")) {
    if (headers.get("sign-in-with-x")) return Response.json({ token: "t", expires_in: 7200 });
    return Response.json(
      {
        extensions: {
          "sign-in-with-x": {
            info: {
              domain: "api.bitrefill.com",
              uri: url,
              version: "1",
              nonce: "abcdef0123456789",
              issuedAt: new Date().toISOString(),
            },
            supportedChains: [{ chainId: "eip155:8453", type: "eip191" }],
          },
        },
      },
      { status: 402 },
    );
  }
  if (url.includes("/x402/gift-cards/search")) {
    return Response.json({
      products: [{ slug: "steam-usa", name: "Steam USA", countries: ["US"], currency: "USD", in_stock: true, categories: ["games"] }],
      found: 1,
      page: 1,
      per_page: 20,
    });
  }
  return new Response("not found", { status: 404 });
};

async function connect(network: "base" | "base-sepolia") {
  const account = privateKeyToAccount(generatePrivateKey());
  const store = new Store(mkdtempSync(join(tmpdir(), "mei-mcp-")));
  const ctx: AgentContext = {
    store,
    config: { network, policy: DEFAULT_POLICY },
    account,
    ...makeClients(network, account),
    bitrefill: new BitrefillClient(account, { fetch: fakeBitrefill }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first!.text);
}

describe("mei MCP server", () => {
  it("exposes the agent tools", async () => {
    const client = await connect("base");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "budget_status",
      "get_order",
      "get_product",
      "purchase",
      "search_products",
    ]);
  });

  it("searches the no-account catalog", async () => {
    const client = await connect("base");
    const result = await client.callTool({ name: "search_products", arguments: { query: "steam", country: "us" } });
    expect(result.isError).toBeFalsy();
    expect(body(result).products[0].slug).toBe("steam-usa");
  });

  it("refuses to purchase without a linked permission", async () => {
    const client = await connect("base");
    const result = await client.callTool({
      name: "purchase",
      arguments: { product_id: "steam-usa", package_value: "20" },
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ refused: true });
    expect(body(result).error).toMatch(/mei link/);
  });

  it("refuses to purchase off Base mainnet", async () => {
    const client = await connect("base-sepolia");
    const result = await client.callTool({
      name: "purchase",
      arguments: { product_id: "steam-usa", package_value: "20" },
    });
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatch(/Base mainnet/);
  });
});
