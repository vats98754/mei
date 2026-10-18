import {
  BitrefillClient,
  decryptKey,
  makeClients,
  Store,
  type MeiConfig,
  type PublicClient,
  type WalletClient,
} from "@mei/core";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface AgentContext {
  store: Store;
  config: MeiConfig;
  account: LocalAccount;
  publicClient: PublicClient;
  walletClient: WalletClient;
  bitrefill: BitrefillClient;
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
    ...makeClients(config.network, account, config.rpcUrl),
    bitrefill: new BitrefillClient(account),
  };
}
