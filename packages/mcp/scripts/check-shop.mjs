// Free live check of the wallet-only gift card path: SIWX sign-in, product lookup,
// an unpaid invoice, and the pay endpoint's 402 quote. Uses a throwaway key; pays nothing.
//   node packages/mcp/scripts/check-shop.mjs [slug] [amount]
import { X402Store } from "@mei/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const [slug = "starbucks-usa", amount = "5"] = process.argv.slice(2);
const shop = new X402Store(privateKeyToAccount(generatePrivateKey()));

const product = await shop.product(slug);
console.log("product:", product.id, "| in stock:", product.in_stock, "| range:", JSON.stringify(product.range));

const invoice = await shop.createInvoice([{ product_id: slug, package_value: amount }]);
console.log("invoice:", invoice.invoice_id, "| price_usdc:", invoice.price_usdc, "| expires in", invoice.expires_in_minutes, "min");

const res = await fetch("https://api.bitrefill.com/x402/invoice/pay", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ invoice_id: invoice.invoice_id }),
});
const quote = (await res.json()).accepts?.find((a) => a.network === "eip155:8453");
console.log("pay 402:", res.status, "| Base USDC amount:", quote?.amount, "| payTo:", quote?.payTo);
console.log(quote?.amount === invoice.price_usdc ? "OK: pay quote matches the invoice exactly" : "MISMATCH: pay quote differs from invoice");
