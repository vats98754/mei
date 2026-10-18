import { getPermissionStatus, prepareSpendCallData } from "@base-org/account/spend-permission";
import { getAddress, type Address, type Hash } from "viem";
import type { PublicClient, WalletClient } from "./chain.js";

/**
 * A signed spend permission as returned by `requestSpendPermission` in the web app.
 * Mirrors @base-org/account's SpendPermission type, which the package does not export.
 */
export interface SpendPermission {
  createdAt?: number;
  permissionHash?: string;
  signature: string;
  chainId?: number;
  permission: {
    account: string;
    spender: string;
    token: string;
    allowance: string;
    period: number;
    start: number;
    end: number;
    salt: string;
    extraData: string;
  };
}

export type BudgetStatus = Awaited<ReturnType<typeof getPermissionStatus>>;

/** The web app hands the signed permission to the CLI as a base64url "link code". */
export function encodeLinkCode(permission: SpendPermission): string {
  return Buffer.from(JSON.stringify(permission)).toString("base64url");
}

export function decodeLinkCode(code: string): SpendPermission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(code.trim(), "base64url").toString("utf8"));
  } catch {
    throw new Error("Link code is not valid base64url JSON.");
  }
  const p = parsed as SpendPermission;
  if (typeof p?.signature !== "string" || typeof p?.permission?.spender !== "string") {
    throw new Error("Link code does not contain a signed spend permission.");
  }
  return p;
}

export function permissionSpender(permission: SpendPermission): Address {
  return getAddress(permission.permission.spender);
}

export function permissionAccount(permission: SpendPermission): Address {
  return getAddress(permission.permission.account);
}

export async function budgetStatus(permission: SpendPermission, rpcUrl?: string): Promise<BudgetStatus> {
  return getPermissionStatus(permission, { rpcUrl });
}

/**
 * Pulls `amount` USDC from the user's smart wallet into the agent's own address.
 * On first use this also submits approveWithSignature; SpendPermissionManager rejects
 * anything over the period allowance, so this is the on-chain hard cap.
 */
export async function pullFromUser(
  permission: SpendPermission,
  amount: bigint,
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  rpcUrl?: string,
): Promise<Hash[]> {
  const calls = await prepareSpendCallData(permission, amount, undefined, { rpcUrl });
  const hashes: Hash[] = [];
  for (const call of calls) {
    const hash = await clients.walletClient.sendTransaction({
      to: call.to,
      data: call.data,
      value: call.value,
    });
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Spend permission transaction reverted: ${hash}`);
    }
    hashes.push(hash);
  }
  return hashes;
}
