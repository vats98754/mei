# mei

Give an AI agent its own USDC wallet. When it reaches a checkout, it buys a prepaid Visa or Mastercard for the exact total, pays from its wallet, and uses the card details to finish the purchase.

```
you ──USDC on Base──▶ agent wallet ──x402──▶ Bitrefill ──▶ prepaid card ──▶ merchant checkout
```

## Quick start

You need:
- Node 22+.
- A [Bitrefill](https://www.bitrefill.com) account.
- Some USDC on **Base**.

```sh
pnpm install && pnpm build

cp .env.example .env        # add MEI_PASSPHRASE and BITREFILL_API_KEY
```

| Variable | Where to get it |
|---|---|
| `MEI_PASSPHRASE` | Make one up. It encrypts the wallet key. If you lose it, you lose the funds. |
| `BITREFILL_API_KEY` | bitrefill.com → Account → [Developers](https://www.bitrefill.com/account/developers) |

```sh
node packages/mcp/dist/cli.js init                                   # creates the wallet, prints its address
node packages/mcp/dist/cli.js cardholder first_name=Jane last_name=Doe
node packages/mcp/dist/cli.js status
```

Send USDC **on Base** to the printed address. No ETH is needed. Then connect it to Claude Code:

```sh
claude mcp add mei -- node "$PWD/packages/mcp/dist/cli.js" serve
```

Restart Claude Code and ask it to buy a $5 Visa.

## CLI

| Command | Does |
|---|---|
| `mei init` | Create the agent wallet (`~/.mei`, or `$MEI_HOME`) |
| `mei status` | Address, USDC balance, policy, 24h spend |
| `mei cardholder key=value …` | Name on the card (`first_name`, `last_name`, and anything else Bitrefill's form asks for) |
| `mei policy key=value …` | `maxPerPurchase`, `maxPerDay`, `approvalAbove` (USD) |
| `mei serve` | Run the MCP server on stdio |

Only you can change the cardholder and the policy, from the CLI. The agent can't change its own limits.

## MCP tools

| Tool | Does |
|---|---|
| `wallet_status` | Balance, policy, 24h spend |
| `buy_card` | `amount` (the checkout total) + `brand` (`visa` or `mastercard`). Returns the card number, CVV and expiry. |
| `get_card` | Re-fetches a card if delivery took longer than `buy_card` waited |

## How it works

**Wallet.** A plain Ethereum key, generated locally and encrypted with your passphrase (scrypt + AES-256-GCM). It never leaves your machine. The USDC balance is the budget, so the agent can't spend more than you sent.

**Buying a card.**
1. Check the policy against the face value.
2. Submit the cardholder form to Bitrefill.
3. Create the invoice.
4. Read the exact USDC price, fee included.
5. Check the policy again against that price.
6. Check the wallet balance.
7. Ask you to approve if the price is over `approvalAbove`.
8. Sign the payment.
9. Wait for the card.

**Payment.** An EIP-3009 USDC authorization, sent over x402. Bitrefill submits it and pays the gas. mei signs only for the exact quoted amount, in USDC on Base, to Bitrefill's address.

**Why a Bitrefill account.** US prepaid cards need a cardholder form, and only Bitrefill's account API accepts it. The wallet-only x402 API rejects these cards. The account only creates orders; the money always comes from the agent wallet.

**Safety.**

| Layer | Stops |
|---|---|
| Wallet balance | Spending more than you funded |
| `maxPerPurchase` / `maxPerDay` | Large or repeated buys |
| `approvalAbove` | Anything over the threshold without your yes |
| Payment pinning | Paying the wrong amount, token or recipient |

Purchases run one at a time, and card details are never written to disk.

## Card rules (Bitrefill's)

- US residents only. Your cardholder name is printed on the card.
- Online, US merchants only. Not for subscriptions or money transfers.
- $1,000 per 7 days.
- The card must cover the full checkout. Bitrefill's fee is added on top of the face value.

## Project layout

```
packages/core   wallet, x402 payer, Bitrefill MCP client, card flow, policy
packages/mcp    mei CLI + MCP server
```

## Development

```sh
pnpm build
pnpm test       # policy, keystore, payment pinning, card flow, MCP server
```

## Status

Early. Not yet run end-to-end against Bitrefill: its account MCP response formats aren't documented, so the parsing is lenient. Bitrefill has no testnet, so the first real check is a small card on mainnet.

**Planned:**
- `mei withdraw`
- Running the server without a separate `init` step
- An npm package
- A local demo checkout
