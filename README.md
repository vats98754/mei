# mei — private, bounded payments for AI agents

> Your agent gets a card. Your reusable payment identity stays invisible.

**mei** gives an AI agent a small, purpose-built payment interface. When the agent reaches a checkout, mei buys a prepaid Visa or Mastercard for the exact total and gives the generated card to the agent to finish the purchase. The agent never receives the user's reusable bank card or personal billing address, and mei never handles or stores either one.

The human establishes a budget and spending rules once. The agent can then act autonomously below the approval threshold, while per-purchase limits, a rolling daily cap, the available settlement balance, and exact payment pinning constrain what it can spend.

```text
human
  └─ one payment + spending rules
       └─> mei funding rail
              └─> policy-controlled settlement
                     └─ MCP: buy_card
                          └─> crypto payment
                                 └─> prepaid card
                                        └─> merchant checkout
```

Built for the **Make Something Agents Want** hackathon by **Ali, Anvay, and Zayaan**.

---

## 🚀 Overview

Agents can browse, compare, plan, and fill carts, but payment is still commonly where they stop and ask for a human. Giving an agent a normal credit card solves the last step by placing a reusable, high-value credential inside a system that continuously reads untrusted webpages, emails, and documents.

mei takes a narrower approach:

- **Autonomy:** the agent can make purchases inside a budget without asking for approval every time.
- **Private by design:** the agent receives a newly issued prepaid card, never the user's reusable bank card. Provider-supplied billing details keep the user's home address out of the model context and mei's storage.
- **User control:** only the local CLI can change cardholder information and spending policy. The agent-facing MCP server cannot raise its own limits.
- **Bounded authority:** each purchase must fit the configured purchase limit, rolling daily cap, and available settlement balance.

The crypto-to-card path has been tested end to end with Bitrefill. The remaining productization step is the consumer funding adapter: one familiar credit-card payment funds an intermediary settlement wallet, while the working MCP, policy, x402, and card-issuance flow remains unchanged.

---

## 💜 Why mei fits Stripe's agent economy track

Stripe's track asks for an agent that can safely participate in the economy while giving users clear control over what it can do and spend. mei is exactly that end-to-end experience: an agent can inspect its budget, obtain an exact-value payment card, and complete a real merchant checkout through three structured MCP tools.

Conceptually, mei builds on the direction of [Stripe Link's wallet for agents](https://stripe.com/guides/agentic-commerce-primer). Link establishes the essential privacy boundary: an agent should be able to pay without receiving the buyer's underlying payment credentials. mei carries that idea forward through three pillars:

- **Full autonomy:** the user establishes a budget once, then the agent can finish purchases below the approval threshold without waiting for a tap every time.
- **Full privacy:** the agent receives a newly issued, exact-value card—not the user's reusable card or home billing address. mei has no central card or identity vault.
- **Complete user control:** per-purchase limits, rolling daily limits, approval thresholds, available balance, and exact payment pinning define what the agent can spend.

The result is a useful economic agent rather than a payment demo: it can buy products, provision services, or pay for resources it needs to complete a task, while the human sets the authority and mei enforces it. Stripe Link or another compliant card-in provider can power the single-payment funding layer without changing mei's existing agent interface or purchase engine.

---

## ✨ The single-payment experience

The intended user experience hides the settlement machinery behind one familiar action:

1. The user chooses a budget and pays once with a credit card.
2. A compliant funding partner handles that reusable card; mei and the agent never see it.
3. The funding rail credits an intermediary settlement wallet.
4. The agent spends from that bounded balance through mei's existing MCP interface.
5. For each checkout, mei creates an exact-value card with provider-supplied billing details.
6. The agent completes the purchase without receiving the user's card number or home address.

The hackathon build already implements and validates steps 4–6. Steps 1–3 are a funding adapter over the same working settlement path, not a change to the agent interface or purchase engine.

---

## ⚡ Demo

Once mei is configured as an MCP server, ask your agent:

```text
Check your payment budget, then buy a $5 Visa card for this checkout.
```

The agent can:

1. Call `wallet_status` to inspect its balance, policy, and rolling 24-hour spend.
2. Call `buy_card` with the checkout total and preferred card brand.
3. Receive a deterministic refusal if the request exceeds policy or balance.
4. Request human confirmation if the final fee-inclusive price exceeds `approvalAbove`.
5. Receive the card details when Bitrefill finishes delivery, or poll with `get_card`.

A useful safety demo is to try three requests: one below the threshold, one above the approval threshold, and one above `maxPerPurchase`. The first proceeds autonomously, the second asks, and the third is rejected before payment.

---

## ⚙️ Core features

### 🤖 Agent-native MCP interface

- Three focused tools instead of a general-purpose wallet API.
- Detailed tool descriptions tell the agent when and how to use each operation.
- Read-only and destructive MCP annotations make intent explicit to compatible clients.
- Human approval uses MCP elicitation when the client supports it.
- Stable invoice IDs and a separate status tool let agents recover from delayed delivery.

### 💳 Just-in-time prepaid cards

- Buys a virtual Visa or Mastercard loaded with the checkout total.
- Uses Bitrefill's account MCP to create and track the card invoice.
- Uses the issued card's provider-supplied billing details instead of exposing the user's home address to the agent.
- Returns the generated card number, CVV, and expiry only after delivery.
- Never writes card credentials to mei's local purchase log.

### 💸 Gasless USDC payments over x402

- Holds and spends USDC on Base.
- Uses an EIP-3009 authorization, so the wallet does not need ETH for gas.
- Reads the complete fee-inclusive price before signing.
- Pins the authorization to the exact amount, USDC contract, Base network, and expected recipient.

### 🛡 Layered spending controls

| Control | What it prevents |
|---|---|
| Available settlement balance | Spending more than the budget established by the user |
| `maxPerPurchase` | A single oversized card purchase |
| `maxPerDay` | Repeated purchases exceeding the rolling 24-hour budget |
| `approvalAbove` | Higher-value purchases proceeding without human confirmation |
| Exact payment pinning | Paying a different token, network, recipient, or amount than quoted |
| Serialized purchases | Parallel tool calls racing the daily limit |

Policy is checked twice: first against the requested card value, then against the actual USDC charge including Bitrefill's fee.

### 🔐 Local-first key storage

- Generates a standard Ethereum private key locally.
- Encrypts it with scrypt and AES-256-GCM when `MEI_PASSPHRASE` is set.
- Stores configuration, key material, and purchase metadata under `~/.mei`, or `$MEI_HOME`.
- Uses owner-only filesystem modes where the operating system supports them.
- Does not send the private key or passphrase to Bitrefill or a mei-operated service.

---

## 🧠 How a purchase works

1. The agent requests a card brand and face value.
2. mei checks the requested value against `maxPerPurchase` and `maxPerDay`.
3. mei starts the provider's card-issuance flow using its local configuration.
4. Bitrefill creates an invoice and returns an x402 payment URL.
5. mei reads the exact USDC price, including provider fees, without paying it.
6. mei checks the fee-inclusive price against policy a second time.
7. mei confirms that the settlement balance can cover the purchase.
8. If the price exceeds `approvalAbove`, mei asks the human to approve it.
9. mei signs an authorization for only the quoted amount and expected recipient.
10. Bitrefill submits the transaction and pays the gas.
11. mei polls the invoice until the card is delivered or the wait times out.
12. The card is returned to the agent and the spend metadata is recorded locally.

Purchases are serialized so concurrent calls cannot race the rolling daily cap. A failed payment attempt is conservatively counted toward that cap because an authorization might have been submitted before the error was observed.

---

## 🛠 Tech stack

### Agent interface

- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- MCP server over stdio
- MCP elicitation for threshold approvals
- Zod tool input schemas

### Payments

- USDC on Base
- EIP-3009 gasless transfer authorizations
- x402 payment protocol
- Bitrefill account MCP and prepaid-card products
- viem for accounts and Base RPC access

### Local security and development

- Node.js 22 and TypeScript
- scrypt + AES-256-GCM encrypted key files
- pnpm workspaces
- Vitest tests for policy, key storage, payment pinning, card flow, and the MCP server

---

## 🏎 Running the current implementation

The commands below expose the working crypto settlement path directly for development and demos. In the consumer flow, the card-in funding adapter replaces the manual funding step while the MCP server and purchase flow stay the same.

### 1. Prerequisites

You need:

- Node.js 22 or newer
- pnpm 9
- A [Bitrefill](https://www.bitrefill.com) account and API key
- USDC on **Base** for the agent's budget

US prepaid cards also require the user and purchase to satisfy Bitrefill's eligibility rules.

### 2. Install and build

```sh
pnpm install
pnpm build
```

### 3. Configure the environment

```sh
cp .env.example .env
```

Add the following values:

| Variable | Purpose |
|---|---|
| `MEI_PASSPHRASE` | Encrypts the wallet key at rest. Choose a strong value and do not lose it. |
| `BITREFILL_API_KEY` | Available from Bitrefill Account → Developers. Required to create card orders. |
| `MEI_HOME` | Optional state directory. Defaults to `~/.mei`. |

### 4. Initialize and configure settlement

```sh
node packages/mcp/dist/cli.js init
node packages/mcp/dist/cli.js cardholder first_name=Jane last_name=Doe
node packages/mcp/dist/cli.js policy maxPerPurchase=50 maxPerDay=100 approvalAbove=25
node packages/mcp/dist/cli.js status
```

If Bitrefill asks for additional cardholder fields, add them with the same `key=value` form:

```sh
node packages/mcp/dist/cli.js cardholder zip_code=94107
```

For the current developer build, send USDC **on Base** to the address printed by `init`. No ETH is required. The product flow replaces this manual step with the single credit-card funding experience described above.

### 5. Connect an MCP client

For Claude Code:

```sh
claude mcp add mei -- node "$PWD/packages/mcp/dist/cli.js" serve
```

Restart the client, ask it to check `wallet_status`, and then request a small card.

---

## 🧰 CLI reference

| Command | Description |
|---|---|
| `mei init [--rpc <url>]` | Create the agent wallet and print its Base address |
| `mei status` | Show address, USDC balance, policy, rolling 24-hour spend, cardholder status, and API-key status |
| `mei policy [key=value ...]` | Show or change `maxPerPurchase`, `maxPerDay`, and `approvalAbove` |
| `mei cardholder [key=value ...]` | Show or change the fields used for Bitrefill's cardholder form |
| `mei serve` | Start the MCP server over stdio |

Only the CLI can change policy and cardholder configuration. These operations are deliberately absent from the agent-facing MCP server.

## 🔌 MCP tool reference

| Tool | Inputs | Result |
|---|---|---|
| `wallet_status` | None | Wallet address, Base USDC balance, policy, rolling 24-hour spend, and cardholder readiness |
| `buy_card` | `amount`, plus `brand` as `visa` or `mastercard` | Invoice ID, face value, final USDC charge, delivery status, and card details when ready |
| `get_card` | `invoice_id` | Current invoice status and card details after delivery |

---

## 🧩 Why these choices

### Why MCP?

MCP gives agents a structured payment action instead of making them discover an undocumented API or manipulate another financial dashboard. The same server can be connected to Claude Code and other MCP-compatible clients, while policy enforcement remains concentrated at one narrow boundary.

### Why Base, USDC, and x402?

USDC provides dollar-denominated budgets, Base keeps transaction costs suitable for small purchases, and EIP-3009 over x402 lets Bitrefill submit the transaction without requiring the agent wallet to hold ETH. The 402 response also exposes a concrete price that mei can validate before signing.

### Why Bitrefill?

Bitrefill bridges crypto settlement to prepaid cards that work at ordinary online checkouts. mei pays with crypto, receives the issued card and its provider-supplied billing details, and gives the agent only what it needs to complete the purchase. The user's reusable funding card and personal billing address never enter this card-issuance path.

---

## 📁 Project structure

```text
packages/
├── core/                 wallet, policy, storage, Bitrefill client, and x402 payer
│   ├── src/
│   │   ├── bitrefill.ts  Bitrefill MCP client and pinned x402 payments
│   │   ├── card.ts       end-to-end card purchase flow
│   │   ├── chain.ts      Base and USDC access
│   │   ├── keystore.ts   local key encryption
│   │   ├── policy.ts     spending-policy decisions
│   │   └── store.ts      local configuration and purchase log
│   └── test/
└── mcp/
    ├── src/
    │   ├── cli.ts        human-facing configuration CLI
    │   ├── context.ts    runtime dependency setup
    │   └── server.ts     agent-facing MCP tools
    └── test/
```

---

## 🧪 Development

```sh
pnpm typecheck
pnpm build
pnpm test
```

The test suite covers:

- USDC parsing and formatting
- Per-purchase, daily, approval, allow-list, and deny-list policy decisions
- Encrypted key round trips and local file permissions
- x402 quote parsing and exact payment pinning
- Cardholder form handling, invoice creation, balance checks, approval, and delivery
- MCP tool discovery, status reporting, refusals, and card retrieval

---

## 🪪 Bitrefill card rules

These are provider restrictions, not rules created by mei:

- US prepaid cards are for eligible US residents.
- Cards work online at US merchants only.
- They are not intended for subscriptions or money transfers.
- Bitrefill documents a $1,000 limit per seven-day period.
- The card must cover the complete checkout; merchants generally cannot split the remainder onto another card.
- Bitrefill adds its fee on top of the requested face value. mei applies policy to that final charge.

Always verify the current product terms in Bitrefill before funding a purchase.

---

## ⚠️ Limitations and privacy boundaries

mei is a hackathon prototype with a working, end-to-end-tested crypto-to-card purchase path. The remaining work is primarily productization: putting a familiar card-in funding experience in front of that rail, hardening key management, and expanding provider and merchant coverage.

### Integration status

- The complete Bitrefill flow has been tested successfully: card creation, crypto payment over x402, delivery polling, and card retrieval.
- The consumer card-in adapter and intermediary funding wallet are the next UX layer; the current developer build exposes crypto settlement directly.
- Provider response formats are not fully documented, so the integration uses defensive parsing and may require maintenance as the upstream API evolves.
- Product identifiers, availability, fees, eligibility, and card terms are controlled by Bitrefill and can change independently of mei.

### Privacy boundaries

- mei has no hosted identity or card vault. It never receives or stores the user's reusable bank-card credentials or home billing address.
- In the single-payment product flow, a compliant funding partner handles the reusable card and credits only the intermediary settlement balance. Neither mei nor the agent receives the original credential.
- Card purchases settle with crypto. Reusable bank-card details are not passed into the Bitrefill card-issuance path.
- The issued card uses provider-supplied billing details, so the user's personal billing address is not shown to the agent or stored by mei.
- The model receives the newly issued prepaid-card credentials because it needs them for checkout, but it never receives the user's reusable card or personal billing identity.
- Base settlement is publicly visible, but it does not contain the user's reusable card number or home address.
- A merchant may still require shipping or delivery information for physical goods; mei does not provide that information automatically.
- Local purchase records contain invoice IDs, product IDs, timestamps, and amounts, but not card numbers, CVVs, or expiry dates.

### Policy and signer boundaries

- `maxPerPurchase`, `maxPerDay`, product rules, and approval thresholds are enforced by the current local MCP runtime.
- The available settlement balance is an independent ceiling: the payment rail cannot spend funds it does not hold.
- The production design moves signing into the intermediary rail so the agent receives spending capability without direct access to settlement keys.
- Approval depends on MCP elicitation support. When a client cannot elicit approval, above-threshold purchases fail closed.
- Key isolation through an OS keychain, hardware-backed signer, or separately permissioned signing service is not yet implemented.

### Operational limitations

- The current developer build does not yet include the one-step credit-card funding adapter or an automated withdrawal experience.
- Losing `MEI_PASSPHRASE` means losing access to an encrypted key. There is no password reset or hosted recovery.
- If no passphrase is configured, mei stores the private key unencrypted in an owner-only local file and prints a warning.
- The MCP server is local and stdio-only. There is no remote deployment, multi-user account system, device synchronization, or team administration.
- The server handles one purchase at a time and has no refund, dispute, chargeback, or subscription-management workflow.
- Checkout completion still depends on the surrounding agent having browser or merchant tools. mei produces the payment card; it does not operate the merchant checkout itself.
- Some merchants may reject prepaid cards, require 3-D Secure, apply address checks, or use anti-bot controls that the current flow cannot resolve.

---

## 🗺 Roadmap

- Add the single-payment card-in adapter and intermediary funding wallet
- Productionize and monitor the validated Bitrefill integration
- Add `mei withdraw`
- Move signing into an OS-backed or separately permissioned signer
- Add an on-chain or smart-account hard allowance independent of the local MCP process
- Support additional card and gift-card providers behind a common interface
- Package the CLI for simple npm installation
- Allow first-run setup without a separate `init` step
- Add a local demo checkout and end-to-end agent evaluation
- Explore a secure remote MCP deployment without turning mei into a custodial service

---

## 👥 Team

**Ali · Anvay · Zayaan**

Built at **Make Something Agents Want** for a future where agents can finish economic tasks without being handed a user's reusable financial identity.
