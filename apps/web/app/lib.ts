import { createPublicClient, erc20Abi, http, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { base, baseSepolia } from "viem/chains";

// Mirrors packages/core/src/chain.ts; @mei/core pulls in node:fs so it is not imported in the browser.
export const NETWORKS = {
  base: { chain: base, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address },
  "base-sepolia": { chain: baseSepolia, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address },
};

export type NetworkName = keyof typeof NETWORKS;

export function asNetwork(value: string | null | undefined): NetworkName {
  return value === "base-sepolia" ? "base-sepolia" : "base";
}

const clients = new Map<NetworkName, PublicClient<Transport, Chain>>();

export function publicClient(network: NetworkName): PublicClient<Transport, Chain> {
  let client = clients.get(network);
  if (!client) {
    const chain: Chain = NETWORKS[network].chain;
    client = createPublicClient({ chain, transport: http() });
    clients.set(network, client);
  }
  return client;
}

export async function usdcBalance(network: NetworkName, owner: Address): Promise<bigint> {
  return publicClient(network).readContract({
    address: NETWORKS[network].usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

/** Same format as encodeLinkCode in packages/core/src/spend.ts: base64url of the permission JSON. */
export function encodeLinkCode(permission: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(permission));
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SPENDERS_KEY = "mei.spenders";

/** Agent addresses this browser has granted to, so the agents page can look them up. */
export function rememberedSpenders(): Address[] {
  try {
    return JSON.parse(localStorage.getItem(SPENDERS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function rememberSpender(spender: Address) {
  try {
    const list = rememberedSpenders();
    if (!list.some((s) => s.toLowerCase() === spender.toLowerCase())) {
      localStorage.setItem(SPENDERS_KEY, JSON.stringify([...list, spender]));
    }
  } catch {}
}

export function forgetSpender(spender: Address) {
  try {
    localStorage.setItem(
      SPENDERS_KEY,
      JSON.stringify(rememberedSpenders().filter((s) => s.toLowerCase() !== spender.toLowerCase())),
    );
  } catch {}
}
