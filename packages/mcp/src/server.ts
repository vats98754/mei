import {
  BitrefillError,
  budgetStatus,
  formatUsdc,
  purchase,
  PurchaseRefused,
  spentInLastDay,
  usdcBalance,
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
  if (err instanceof BitrefillError) {
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
    // Bitrefill rejects "bill payment" products (those with a prepayment form) on the no-account path.
    buyable_without_account: !p.prepayment,
    recipient_required: p.recipient_required,
    packages: p.packages,
    custom_range: p.range,
    instructions: stripHtml(p.instructions),
  };
}

export function createServer(ctx: AgentContext): McpServer {
  const server = new McpServer({ name: "mei", version: "0.1.0" });

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
    "budget_status",
    {
      description:
        "Show how much the agent can still spend: remaining on-chain allowance from the user's wallet this period, USDC already held by the agent, and local policy limits.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { config, store, account, publicClient } = ctx;
        const held = await usdcBalance(publicClient, config.network, account.address);
        const spent = spentInLastDay(store.spendHistory(), Date.now());
        const budget = config.permission ? await budgetStatus(config.permission, config.rpcUrl) : undefined;
        return text({
          agent: account.address,
          network: config.network,
          agent_usdc: formatUsdc(held),
          permission: budget
            ? {
                active: budget.isActive,
                remaining_this_period: formatUsdc(budget.remainingSpend),
                next_period_start: budget.nextPeriodStart.toISOString(),
              }
            : "not linked",
          policy: { ...config.policy, spent_last_24h: formatUsdc(spent) },
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "search_products",
    {
      description:
        "Search Bitrefill's catalog of gift cards and vouchers that can be bought without an account. Returns product slugs to pass to get_product.",
      inputSchema: {
        query: z.string().min(1).describe("Brand or product, e.g. 'amazon', 'steam', 'uber'"),
        country: z.string().length(2).optional().describe("ISO 3166 country code, e.g. 'US'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, country }) => {
      try {
        const result = await ctx.bitrefill.search(query, country?.toUpperCase());
        return text({
          found: result.found,
          products: result.products.map((p) => ({
            slug: p.slug,
            name: p.name,
            countries: p.countries,
            currency: p.currency,
            in_stock: p.in_stock,
            categories: p.categories,
          })),
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_product",
    {
      description:
        "Get a product's denominations (package_value), USD prices, whether it can be bought without an account, and redemption instructions.",
      inputSchema: { slug: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ slug }) => {
      try {
        return text(summarizeProduct(await ctx.bitrefill.product(slug)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "purchase",
    {
      description:
        "Buy one Bitrefill product with the user's delegated USDC budget. Enforces the user's spending policy and on-chain allowance, may ask the human to approve, pays, and returns the redemption code or card details once delivered. Use package_value exactly as returned by get_product.",
      inputSchema: {
        product_id: z.string().min(1).describe("Product slug from search_products/get_product"),
        package_value: z.string().min(1).describe("Exact package_value string from get_product"),
        refill_input: z.string().optional().describe("Phone number, only for top-ups that require a recipient"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ product_id, package_value, refill_input }) => {
      try {
        const result = await purchase(
          {
            store: ctx.store,
            config: ctx.config,
            bitrefill: ctx.bitrefill,
            agent: ctx.account.address,
            publicClient: ctx.publicClient,
            walletClient: ctx.walletClient,
            confirm,
          },
          { product_id, package_value, ...(refill_input ? { refill_input } : {}) },
        );
        return text({
          ...result,
          note: result.delivered
            ? "Delivered. Treat redemption details as secrets: use them for the user's purchase and do not repeat them unnecessarily."
            : "Paid but not yet delivered; call get_order with this invoice_id later.",
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      description: "Check delivery status of a paid invoice and fetch its redemption code or card details.",
      inputSchema: { invoice_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ invoice_id }) => {
      try {
        return text(await ctx.bitrefill.status(invoice_id));
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
