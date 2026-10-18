import {
  BitrefillMcp,
  decryptKey,
  makePublicClient,
  Store,
  X402Payer,
  type BitrefillApi,
  type MeiConfig,
  type PublicClient,
} from "@mei/core";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface AgentContext {
  store: Store;
  config: MeiConfig;
  account: LocalAccount;
  publicClient: PublicClient;
  bitrefill: BitrefillApi;
  payer: X402Payer;
}

const missingKey: BitrefillApi = {
  call: async () => {
    throw new Error("BITREFILL_API_KEY is not set; create one at https://www.bitrefill.com/account/developers.");
  },
};

export function loadContext(store = new Store()): AgentContext {
  const config = store.requireConfig();
  const key = store.readKey();
  if (!key) throw new Error(`No agent key in ${store.home}; run \`mei init\` first.`);
  const account = privateKeyToAccount(decryptKey(key, process.env.MEI_PASSPHRASE));
  const apiKey = process.env.BITREFILL_API_KEY;
  return {
    store,
    config,
    account,
    publicClient: makePublicClient(config.rpcUrl),
    bitrefill: apiKey ? new BitrefillMcp(apiKey) : missingKey,
    payer: new X402Payer(account),
  };
}
