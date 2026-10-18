# mei

Give an AI agent a capped USDC budget it can spend through Bitrefill without handing it your card, and without you or the agent creating an account anywhere.

```
your smart wallet (USDC on Base)
   │  spend permission: N USDC per period, on-chain, revocable
   ▼
agent wallet (key stays on your machine)
   │  x402: sign in with wallet, pay invoice in USDC
   ▼
Bitrefill (no account) → gift card code / card details → merchant
```

## Privacy model

- **mei holds no money and no personal data.** You keep your wallet keys. The agent's key lives in `~/.mei` on your machine. The web app stores nothing on a server.
- **No Bitrefill account.** The agent pays through Bitrefill's wallet-only x402 API.
- **Merchants and the agent never see who you are.** The merchant sees a gift card.
- **Card funding is optional.** Buying USDC with a card goes through Coinbase Onramp, which runs its own checks. Sending USDC on Base from any wallet works too.
- **Out of scope:** mixing or hiding where funds came from, custody, rotating wallets to get around Bitrefill limits, and resale. Bitrefill's terms count every agent purchase as your own.

### What Bitrefill sells without an account (checked 2026-10-17)

Merchant gift cards, eSIMs and mobile top-ups can be bought. Some non-US payment cards also work, for example `the-visa-digital-gift-card-australia` and `prepaid-mastercard-south-africa`.

The US prepaid cards are **not** sold on the x402 path: `virtual-prepaid-visa-usa`, `virtual-prepaid-mastercard-usa` and `physical-prepaid-visa-usa`. Bitrefill classes them as "bill payment" products, and `invoice/create` returns `INVALID_PACKAGE: Bill payment is not available on x402`.

`get_product` reports this as `buyable_without_account: false`. If Bitrefill changes it, nothing in mei needs to change.

## Packages

| Path | What |
|---|---|
| `packages/core` | Spend permissions (Coinbase SpendPermissionManager), Bitrefill x402 client, policy engine, local key store |
| `packages/mcp` | `mei` CLI and stdio MCP server the agent talks to |
| `apps/web` | Next.js app: connect a Coinbase smart wallet, fund it, grant and revoke agent budgets |

## Setup

```sh
pnpm install && pnpm build

# 1. Create the agent wallet (set a passphrase so the key is encrypted at rest)
export MEI_PASSPHRASE='…'
node packages/mcp/dist/cli.js init --network base

# 2. Grant a budget: run the web app, open the link `init` printed
pnpm --filter @mei/web dev          # http://localhost:3000
#    → "Grant budget" in your wallet → copy the `mei link …` command
#    → optionally "Send 0.0002 ETH" so the agent can pay gas

# 3. Link it and check
node packages/mcp/dist/cli.js link <code>
node packages/mcp/dist/cli.js status
node packages/mcp/dist/cli.js policy maxPerPurchase=30 maxPerDay=60 approvalAbove=20 'allowProducts=amazon*,steam*'

# 4. Give it to your agent
claude mcp add mei -e MEI_PASSPHRASE="$MEI_PASSPHRASE" -- node "$PWD/packages/mcp/dist/cli.js" serve
```

For card funding in the web app, set `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (see `apps/web/.env.example`).

## MCP tools

| Tool | Does |
|---|---|
| `budget_status` | Remaining on-chain allowance this period, USDC held by the agent, policy and 24h spend |
| `search_products` | Search the no-account catalog |
| `get_product` | Denominations, prices, `buyable_without_account`, redemption instructions |
| `purchase` | The full flow below |
| `get_order` | Delivery status and redemption details (signed by the paying wallet) |

`purchase` runs these steps:
1. Create the invoice.
2. Check the local policy: per-purchase cap, daily cap, and allow/deny lists.
3. Check the on-chain allowance.
4. Ask the human through MCP elicitation if the price is above `approvalAbove`. Clients that can't ask are treated as a decline.
5. Pull only the shortfall from your wallet.
6. Pay with an EIP-3009 authorization. It is only signed if Bitrefill asks for exactly the invoice amount, in USDC on Base, to Bitrefill's address.
7. Poll until delivered.

Redemption codes are returned to the agent but never written to disk.

## Tests

```sh
pnpm test        # policy, keystore, Bitrefill client (SIWX + payment pinning), MCP server
```

Not yet exercised: a real funded purchase on Base mainnet, and granting or revoking in the browser with a real smart wallet. Bitrefill has no testnet, so the first real check is a small gift card on mainnet.
