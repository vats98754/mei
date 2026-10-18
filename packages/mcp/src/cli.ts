#!/usr/bin/env node
import {
  DEFAULT_POLICY,
  encryptKey,
  formatUsdc,
  makePublicClient,
  parseUsdc,
  spentInLastDay,
  Store,
  usdcBalance,
  type Policy,
} from "@mei/core";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { serve } from "./server.js";

const USAGE = `mei: an agent wallet that buys gift cards through Bitrefill

Usage:
  mei init [--rpc <url>]        create the agent wallet and print its address
  mei status                    show the wallet balance, policy and 24h spend
  mei policy [key=value ...]    show or change spending policy  mei serve                     run the MCP server on stdio

Environment:
  MEI_HOME        state directory (default ~/.mei)
  MEI_PASSPHRASE  encrypts the agent key at rest (recommended)`;

// Secrets live in mei/.env (gitignored); real environment variables take precedence.
const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const POLICY_AMOUNTS = ["maxPerPurchase", "maxPerDay", "approvalAbove"] as const;

function init(args: string[]) {
  const { values } = parseArgs({ args, options: { rpc: { type: "string" } } });
  const store = new Store();
  const existing = store.readConfig();

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

  store.writeConfig({
    rpcUrl: values.rpc ?? existing?.rpcUrl,
    policy: existing?.policy ?? DEFAULT_POLICY,
  });

  console.log(`\nFund it by sending USDC on Base to:\n  ${address}`);
  console.log("No ETH is needed: payments are gasless USDC authorizations.");
}

async function status() {
  const store = new Store();
  const config = store.requireConfig();
  const address = store.agentAddress();
  if (!address) throw new Error("No agent wallet; run `mei init`.");
  const usdc = await usdcBalance(makePublicClient(config.rpcUrl), address);
  const spent = spentInLastDay(store.spendHistory(), Date.now());
  console.log(`Agent        ${address} (Base)`);
  console.log(`Balance      ${formatUsdc(usdc)} USDC`);
  console.log(`Policy       ${JSON.stringify(config.policy)}`);
  console.log(`Spent (24h)  ${formatUsdc(spent)} USDC`);
}

function keyValues(args: string[]): [string, string][] {
  return args.map((arg) => {
    const i = arg.indexOf("=");
    if (i < 1) throw new Error(`Expected key=value, got ${arg}`);
    return [arg.slice(0, i), arg.slice(i + 1)];
  });
}

function policy(args: string[]) {
  const store = new Store();
  const config = store.requireConfig();
  const next: Policy = { ...config.policy };
  for (const [key, value] of keyValues(args)) {
    if ((POLICY_AMOUNTS as readonly string[]).includes(key)) {
      parseUsdc(value);
      next[key as (typeof POLICY_AMOUNTS)[number]] = value;
    } else {
      throw new Error(`Unknown policy key ${key}; use ${POLICY_AMOUNTS.join(", ")}.`);
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
