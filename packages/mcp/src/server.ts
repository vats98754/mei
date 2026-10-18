import {
  buyGiftCard,
  formatUsdc,
  PurchaseRefused,
  spentInLastDay,
  usdcBalance,
  X402StoreError,
  type ProductDetail,
} from "@mei/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadContext, type AgentContext } from "./context.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(err: unknown) {
  if (err instanceof X402StoreError) {
    return { ...text({ error: err.message, code: err.code, instructions: err.agentInstructions }), isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ...text({ error: message, refused: err instanceof PurchaseRefused }), isError: true };
}

function stripHtml(html: string | undefined, max = 1200): string | undefined {
  return html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Bitrefill product detail includes reviews and translations; keep what an agent needs to buy. */
function summarizeProduct(p: ProductDetail) {
  return {
    slug: p.id,
    name: p.name,
    country: p.country_code,
    currency: p.currency,
    in_stock: p.in_stock,
    // "Bill payment" products (with a prepayment form) are refused on the wallet-only path.
    buyable: !p.prepayment,
    recipient_required: p.recipient_required,
    packages: p.packages,
    custom_range: p.range,
    instructions: stripHtml(p.instructions),
  };
}

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
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "search_gift_cards",
    {
      description:
        "Search Bitrefill's gift cards (e.g. 'starbucks', 'amazon', 'walmart'). Returns product slugs to pass to get_gift_card_product.",
      inputSchema: {
        query: z.string().min(1).describe("Brand or product, e.g. 'starbucks'"),
        country: z.string().length(2).optional().describe("ISO 3166 country code, e.g. 'US'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, country }) => {
      try {
        const result = await ctx.shop.search(query, country?.toUpperCase());
        return text({
          found: result.found,
          products: result.products.map((p) => ({
            slug: p.slug,
            name: p.name,
            countries: p.countries,
            currency: p.currency,
            in_stock: p.in_stock,
          })),
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_gift_card_product",
    {
      description:
        "Get a gift card's denominations (package_value), custom amount range, USD prices and redemption instructions.",
      inputSchema: { slug: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ slug }) => {
      try {
        return text(summarizeProduct(await ctx.shop.product(slug)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "buy_gift_card",
    {
      description:
        "Buy one gift card with the agent's USDC wallet. Enforces the user's spending policy, may ask the human to approve, pays (Bitrefill adds a small fee), and returns the redemption code/PIN once delivered. Use a package_value from get_gift_card_product, or any amount inside its custom_range.",
      inputSchema: {
        product_id: z.string().min(1).describe("Product slug, e.g. 'starbucks-usa'"),
        package_value: z.string().min(1).describe("Denomination, e.g. '5'"),
        refill_input: z.string().optional().describe("Only for products that need a recipient (phone/account)"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ product_id, package_value, refill_input }) => {
      try {
        const result = await buyGiftCard(
          {
            store: ctx.store,
            config: ctx.config,
            shop: ctx.shop,
            agent: ctx.account.address,
            publicClient: ctx.publicClient,
            confirm,
          },
          { product_id, package_value, ...(refill_input ? { refill_input } : {}) },
        );
        return text({
          ...result,
          note: result.delivered
            ? "Delivered. Treat the code and PIN as secrets: use them for the user's purchase and don't repeat them unnecessarily."
            : "Paid but not yet delivered; call get_gift_card_order with this invoiceId shortly.",
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_gift_card_order",
    {
      description: "Check delivery of a paid gift card and fetch its code/PIN (signed by the paying wallet).",
      inputSchema: { invoice_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ invoice_id }) => {
      try {
        return text(await ctx.shop.status(invoice_id));
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
