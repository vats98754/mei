import { decryptKey, makePublicClient, Store, X402Store, type MeiConfig, type PublicClient } from "@mei/core";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface AgentContext {
  store: Store;
  config: MeiConfig;
  account: LocalAccount;
  publicClient: PublicClient;
  /** Bitrefill's wallet-only storefront; needs no account or API key. */
  shop: X402Store;
}

export function loadContext(store = new Store()): AgentContext {
  const config = store.requireConfig();
  const key = store.readKey();
  if (!key) throw new Error(`No agent key in ${store.home}; run \`mei init\` first.`);
  const account = privateKeyToAccount(decryptKey(key, process.env.MEI_PASSPHRASE));
  return {
    store,
    config,
    account,
    publicClient: makePublicClient(config.rpcUrl),
    shop: new X402Store(account),
  };
}
