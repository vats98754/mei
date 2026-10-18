import { createPublicClient, erc20Abi, http, type Address, type Chain, type PublicClient as ViemPublicClient, type Transport } from "viem";
import { base } from "viem/chains";

/** Bitrefill takes USDC on Base, so that is the only network mei uses. */
export const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CAIP2 = "eip155:8453";

export type PublicClient = ViemPublicClient<Transport, Chain>;

export function makePublicClient(rpcUrl?: string): PublicClient {
  const chain: Chain = base;
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

export async function usdcBalance(publicClient: PublicClient, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}
