#!/usr/bin/env node
import {
  budgetStatus,
  decodeLinkCode,
  DEFAULT_POLICY,
  encryptKey,
  formatUsdc,
  isNetworkName,
  NETWORKS,
  parseUsdc,
  permissionAccount,
  permissionSpender,
  spentInLastDay,
  Store,
  usdcBalance,
  type Policy,
} from "@mei/core";
import { parseArgs } from "node:util";
import { formatEther, isAddressEqual } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadContext } from "./context.js";
import { serve } from "./server.js";

const USAGE = `mei: delegated USDC budgets for AI agents, spent through Bitrefill

Usage:
  mei init [--network base|base-sepolia] [--rpc <url>]   create the agent wallet
  mei link <code>                                        save the spend permission from the web app
  mei status                                             show budget, balances and policy
  mei policy [key=value ...]                             show or change spending policy
  mei serve                                              run the MCP server on stdio

Environment:
  MEI_HOME        state directory (default ~/.mei)
  MEI_PASSPHRASE  encrypts the agent key at rest (recommended)
  MEI_WEB_URL     web app used for granting permissions (default http://localhost:3000)`;

const POLICY_AMOUNTS = ["maxPerPurchase", "maxPerDay", "approvalAbove"] as const;
const POLICY_LISTS = ["allowProducts", "denyProducts"] as const;

function init(args: string[]) {
  const { values } = parseArgs({ args, options: { network: { type: "string" }, rpc: { type: "string" } } });
  const store = new Store();
  const existing = store.readConfig();
  const network = values.network ?? existing?.network ?? "base";
  if (!isNetworkName(network)) throw new Error(`Unknown network ${network}; use base or base-sepolia.`);

  let address = store.agentAddress();
  if (!address) {
    const pk = generatePrivateKey();
    address = privateKeyToAccount(pk).address;
    store.writeKey(encryptKey(pk, address, process.env.MEI_PASSPHRASE));
    console.log(`Created agent wallet ${address}`);
    if (!process.env.MEI_PASSPHRASE) {
      console.warn("warning: MEI_PASSPHRASE is not set, so the agent key is stored unencrypted (file mode 600).");
    }
  } else {
    console.log(`Agent wallet ${address} already exists`);
  }

  const networkChanged = existing && existing.network !== network;
  store.writeConfig({
    network,
    rpcUrl: values.rpc ?? existing?.rpcUrl,
    policy: existing?.policy ?? DEFAULT_POLICY,
    permission: networkChanged ? undefined : existing?.permission,
  });

  const web = process.env.MEI_WEB_URL ?? "http://localhost:3000";
  console.log(`\nGrant this agent a budget from your wallet:\n  ${web}/agents/new?spender=${address}&network=${network}`);
  console.log("\nThen run `mei link <code>` with the code the web app shows.");
}

function link(args: string[]) {
  const code = args[0];
  if (!code) throw new Error("Usage: mei link <code>");
  const store = new Store();
  const config = store.requireConfig();
  const agent = store.agentAddress();
  const permission = decodeLinkCode(code);

  if (!agent || !isAddressEqual(permissionSpender(permission), agent)) {
    throw new Error(`This permission is for spender ${permission.permission.spender}, not this agent (${agent}).`);
  }
  const chainId = NETWORKS[config.network].chain.id;
  if (permission.chainId !== undefined && permission.chainId !== chainId) {
    throw new Error(`Permission is for chain ${permission.chainId}, but mei is configured for ${config.network} (${chainId}).`);
  }
  if (!isAddressEqual(permission.permission.token as `0x${string}`, NETWORKS[config.network].usdc)) {
    throw new Error(`Permission token ${permission.permission.token} is not USDC on ${config.network}.`);
  }

  store.writeConfig({ ...config, permission: { ...permission, chainId } });
  const days = permission.permission.period / 86400;
  console.log(
    `Linked: ${formatUsdc(BigInt(permission.permission.allowance))} USDC every ${days} day(s) from ${permissionAccount(permission)}`,
  );
}

async function status() {
  const { config, store, account, publicClient } = loadContext();
  const [usdc, eth] = await Promise.all([
    usdcBalance(publicClient, config.network, account.address),
    publicClient.getBalance({ address: account.address }),
  ]);
  console.log(`Agent        ${account.address} (${config.network})`);
  console.log(`Agent funds  ${formatUsdc(usdc)} USDC, ${formatEther(eth)} ETH for gas`);
  if (config.permission) {
    const budget = await budgetStatus(config.permission, config.rpcUrl);
    const p = config.permission.permission;
    console.log(`User wallet  ${permissionAccount(config.permission)}`);
    console.log(`Allowance    ${formatUsdc(BigInt(p.allowance))} USDC per ${p.period / 86400} day(s)`);
    console.log(
      `Remaining    ${formatUsdc(budget.remainingSpend)} USDC this period (${budget.isActive ? "active" : "INACTIVE"}, resets ${budget.nextPeriodStart.toISOString()})`,
    );
  } else {
    console.log("Permission   not linked (run `mei init` for the grant link)");
  }
  const spent = spentInLastDay(store.spendHistory(), Date.now());
  console.log(`Policy       ${JSON.stringify(config.policy)}`);
  console.log(`Spent (24h)  ${formatUsdc(spent)} USDC`);
  if (eth === 0n && config.permission) {
    console.log("\nwarning: the agent has no ETH for gas; pulling funds from your wallet will fail. Send a small amount on Base.");
  }
}

function policy(args: string[]) {
  const store = new Store();
  const config = store.requireConfig();
  const next: Policy = { ...config.policy };
  for (const arg of args) {
    const [key, value = ""] = arg.split("=", 2);
    if ((POLICY_AMOUNTS as readonly string[]).includes(key!)) {
      parseUsdc(value);
      next[key as (typeof POLICY_AMOUNTS)[number]] = value;
    } else if ((POLICY_LISTS as readonly string[]).includes(key!)) {
      next[key as (typeof POLICY_LISTS)[number]] = value ? value.split(",").map((s) => s.trim()) : undefined;
    } else {
      throw new Error(`Unknown policy key ${key}; use ${[...POLICY_AMOUNTS, ...POLICY_LISTS].join(", ")}.`);
    }
  }
  if (args.length) store.writeConfig({ ...config, policy: next });
  console.log(JSON.stringify(next, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "init":
      return init(args);
    case "link":
      return link(args);
    case "status":
      return status();
    case "policy":
      return policy(args);
    case "serve":
      return serve();
    default:
      console.log(USAGE);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
