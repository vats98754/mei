import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { isAddress } from "viem";

const HOST = "api.developer.coinbase.com";
const PATH = "/onramp/v1/token";

/**
 * Mints a single-use Coinbase Onramp session token for the user's wallet address.
 * Stateless: nothing about the user is stored. Coinbase runs its own checks on the purchase.
 */
export async function POST(request: Request) {
  const { CDP_API_KEY_ID, CDP_API_KEY_SECRET } = process.env;
  if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
    return Response.json(
      { error: "Card funding is not configured on this server. Send USDC on Base to your address instead." },
      { status: 501 },
    );
  }

  const { address } = (await request.json().catch(() => ({}))) as { address?: string };
  if (!address || !isAddress(address)) {
    return Response.json({ error: "A valid wallet address is required." }, { status: 400 });
  }

  const jwt = await generateJwt({
    apiKeyId: CDP_API_KEY_ID,
    apiKeySecret: CDP_API_KEY_SECRET,
    requestMethod: "POST",
    requestHost: HOST,
    requestPath: PATH,
  });

  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const res = await fetch(`https://${HOST}${PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      addresses: [{ address, blockchains: ["base"] }],
      assets: ["USDC"],
      ...(clientIp ? { clientIp } : {}),
    }),
  });
  if (!res.ok) {
    return Response.json({ error: `Coinbase Onramp error ${res.status}: ${await res.text()}` }, { status: 502 });
  }

  const { token } = (await res.json()) as { token: string };
  const url = new URL("https://pay.coinbase.com/buy/select-asset");
  url.searchParams.set("sessionToken", token);
  url.searchParams.set("defaultNetwork", "base");
  url.searchParams.set("defaultAsset", "USDC");
  return Response.json({ url: url.toString() });
}
