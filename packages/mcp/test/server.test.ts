import { DEFAULT_POLICY, Store, X402Payer, type BitrefillApi, type PublicClient } from "@mei/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../src/context.js";
import { createServer } from "../src/server.js";

const bitrefill: BitrefillApi = {
  async call(tool) {
    if (tool === "get-invoice-by-id") return { status: "complete", orders: [{ redemption_info: { cvv: "123" } }] };
    throw new Error(`unexpected ${tool}`);
  },
};

async function connect(cardholder?: Record<string, string>) {
  const account = privateKeyToAccount(generatePrivateKey());
  const ctx: AgentContext = {
    store: new Store(mkdtempSync(join(tmpdir(), "mei-mcp-"))),
    config: { policy: DEFAULT_POLICY, cardholder },
    account,
    publicClient: { readContract: async () => 12_500_000n } as unknown as PublicClient,
    bitrefill,
    payer: new X402Payer(account),
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
    expect(tools.map((t) => t.name).sort()).toEqual(["buy_card", "get_card", "wallet_status"]);
  });

  it("reports the agent wallet balance", async () => {
    const { client, account } = await connect();
    const result = await client.callTool({ name: "wallet_status", arguments: {} });
    expect(body(result)).toMatchObject({ agent: account.address, usdc_on_base: "12.5", cardholder_set: false });
  });

  it("refuses to buy a card without a cardholder", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "buy_card", arguments: { amount: "20" } });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ refused: true });
    expect(body(result).error).toMatch(/mei cardholder/);
  });

  it("fetches card details for an invoice", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "get_card", arguments: { invoice_id: "inv-1" } });
    expect(body(result)).toEqual({ status: "complete", delivered: true, card: { cvv: "123" } });
  });
});
