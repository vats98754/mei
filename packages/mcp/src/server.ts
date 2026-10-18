import {
  BitrefillError,
  buyCard,
  CARD_PRODUCTS,
  formatUsdc,
  getCard,
  PurchaseRefused,
  spentInLastDay,
  usdcBalance,
} from "@mei/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadContext, type AgentContext } from "./context.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown) {
  if (err instanceof BitrefillError) {
    return { ...text({ error: err.message, tool: err.tool, detail: err.detail }), isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ...text({ error: message, refused: err instanceof PurchaseRefused }), isError: true };
}

const CARD_NOTE =
  "Prepaid US card: works online at US merchants only, not for subscriptions. It must cover the whole checkout total; most merchants won't split the rest onto another card.";

export function createServer(ctx: AgentContext): McpServer {
  const server = new McpServer({ name: "mei", version: "0.2.0" });

  async function confirm(message: string): Promise<boolean> {
    if (!server.server.getClientCapabilities()?.elicitation) return false;
    const result = await server.server.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: { approve: { type: "boolean", title: "Approve this purchase" } },
        required: ["approve"],
      },
    });
    return result.action === "accept" && result.content?.approve === true;
  }

  server.registerTool(
    "wallet_status",
    {
      description:
        "Show the agent wallet's USDC balance on Base, the spending policy and how much was spent in the last 24h. The user tops up by sending USDC on Base to the agent address.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { config, store, account, publicClient } = ctx;
        const held = await usdcBalance(publicClient, account.address);
        const spent = spentInLastDay(store.spendHistory(), Date.now());
        return text({
          agent: account.address,
          usdc_on_base: formatUsdc(held),
          policy: { ...config.policy, spent_last_24h: formatUsdc(spent) },
          cardholder_set: Boolean(config.cardholder?.first_name && config.cardholder?.last_name),
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "buy_card",
    {
      description: `Buy a prepaid virtual Visa or Mastercard loaded with \`amount\` USD, paid from the agent's USDC wallet, to finish a checkout. Set amount to the checkout total (taxes and shipping included). Bitrefill adds a fee on top. Enforces the user's spending policy, may ask the human to approve, and returns the card number, CVV and expiry once delivered. ${CARD_NOTE}`,
      inputSchema: {
        amount: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .describe("USD to load on the card, e.g. '42.17'"),
        brand: z.enum(Object.keys(CARD_PRODUCTS) as [keyof typeof CARD_PRODUCTS]).default("visa"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ amount, brand }) => {
      try {
        const result = await buyCard(
          {
            store: ctx.store,
            config: ctx.config,
            bitrefill: ctx.bitrefill,
            payer: ctx.payer,
            agent: ctx.account.address,
            publicClient: ctx.publicClient,
            confirm,
          },
          { brand, amount },
        );
        return text({
          ...result,
          note: result.delivered
            ? `Delivered. Use these card details only for the user's checkout and don't repeat them unnecessarily. Billing name is the configured cardholder. ${CARD_NOTE}`
            : "Paid but the card isn't ready yet; call get_card with this invoiceId shortly.",
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_card",
    {
      description: "Fetch status and card details (number, CVV, expiry) for a card bought with buy_card.",
      inputSchema: { invoice_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ invoice_id }) => {
      try {
        return text(await getCard(ctx.bitrefill, invoice_id));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

export async function serve(): Promise<void> {
  const server = createServer(loadContext());
  await server.connect(new StdioServerTransport());
}
