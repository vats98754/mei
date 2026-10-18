import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { BITREFILL_PAY_TO, X402Payer } from "../src/bitrefill.js";
import { header, mockFetch, paymentRequired } from "./helpers.js";

const account = privateKeyToAccount(generatePrivateKey());
const PAY_URL = "https://api.bitrefill.com/x402/invoice/pay?invoice_id=inv-1";

describe("X402Payer", () => {
  it("quotes the Base USDC price without paying", async () => {
    const { fetch, calls } = mockFetch((url) => paymentRequired(url, "21010000"));
    const quote = await new X402Payer(account, { fetch }).quote(PAY_URL);
    expect(quote).toEqual({ method: "GET", amount: 21_010_000n, payTo: BITREFILL_PAY_TO });
    expect(calls.some((c) => header(c.init, "payment-signature"))).toBe(false);
  });

  it("falls back to POST when the pay URL rejects GET", async () => {
    const { fetch } = mockFetch((url, init) =>
      init.method === "POST" ? paymentRequired(url, "5000000") : new Response("", { status: 405 }),
    );
    const quote = await new X402Payer(account, { fetch }).quote(PAY_URL);
    expect(quote.method).toBe("POST");
  });

  it("refuses a payment to an address other than Bitrefill's", async () => {
    const { fetch } = mockFetch((url) => paymentRequired(url, "5000000", "0x000000000000000000000000000000000000dEaD"));
    await expect(new X402Payer(account, { fetch }).quote(PAY_URL)).rejects.toThrow(/refusing/);
  });

  it("pays only when Bitrefill asks for exactly the quoted amount", async () => {
    let asked = "21010000";
    const { fetch, calls } = mockFetch((url, init) => {
      if (header(init, "payment-signature")) return Response.json({ success: true });
      return paymentRequired(url, asked);
    });
    const payer = new X402Payer(account, { fetch });
    const quote = await payer.quote(PAY_URL);

    asked = "99000000";
    await expect(payer.pay(PAY_URL, quote)).rejects.toThrow(/refusing to pay/);
    expect(calls.some((c) => header(c.init, "payment-signature"))).toBe(false);

    asked = "21010000";
    await expect(payer.pay(PAY_URL, quote)).resolves.toMatchObject({ success: true });
    const paid = calls.find((c) => header(c.init, "payment-signature"))!;
    const payload = JSON.parse(Buffer.from(header(paid.init, "payment-signature")!, "base64").toString("utf8"));
    expect(payload.accepted.amount).toBe("21010000");
    expect(payload.payload.authorization.from).toBe(account.address);
    expect(payload.payload.authorization.to).toBe(BITREFILL_PAY_TO);
  });
});
