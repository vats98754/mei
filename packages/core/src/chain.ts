import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Account,
  type Address,
  type Chain,
  type LocalAccount,
  type PublicClient as ViemPublicClient,
  type Transport,
  type WalletClient as ViemWalletClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";

/** Coinbase SpendPermissionManager; same address on Base mainnet and Base Sepolia. */
export const SPEND_PERMISSION_MANAGER: Address = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";

export const NETWORKS = {
  base: { chain: base, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "base-sepolia": { chain: baseSepolia, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
} as const satisfies Record<string, { chain: Chain; usdc: Address }>;

export type NetworkName = keyof typeof NETWORKS;

export function isNetworkName(value: string): value is NetworkName {
  return value in NETWORKS;
}

export type PublicClient = ViemPublicClient<Transport, Chain>;
export type WalletClient = ViemWalletClient<Transport, Chain, Account>;

export function makeClients(
  network: NetworkName,
  account: LocalAccount,
  rpcUrl?: string,
): { publicClient: PublicClient; walletClient: WalletClient } {
  const chain: Chain = NETWORKS[network].chain;
  const transport = http(rpcUrl);
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport, account }),
  };
}

export async function usdcBalance(
  publicClient: PublicClient,
  network: NetworkName,
  owner: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: NETWORKS[network].usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}
