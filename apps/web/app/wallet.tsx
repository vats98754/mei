"use client";

import { createBaseAccountSDK } from "@base-org/account/browser";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { getAddress, numberToHex, type Address } from "viem";
import { NETWORKS, type NetworkName } from "./lib";

type Provider = ReturnType<ReturnType<typeof createBaseAccountSDK>["getProvider"]>;

interface WalletState {
  account?: Address;
  provider?: Provider;
  connect: () => Promise<void>;
  ensureNetwork: (network: NetworkName) => Promise<void>;
  error?: string;
  setError: (error?: string) => void;
}

const WalletContext = createContext<WalletState | undefined>(undefined);

let sdk: ReturnType<typeof createBaseAccountSDK> | undefined;

function getProvider(): Provider {
  sdk ??= createBaseAccountSDK({
    appName: "mei",
    appChainIds: [NETWORKS.base.chain.id, NETWORKS["base-sepolia"].chain.id],
  });
  return sdk.getProvider();
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Address>();
  const [provider, setProvider] = useState<Provider>();
  const [error, setError] = useState<string>();

  const connect = useCallback(async () => {
    setError(undefined);
    try {
      const p = getProvider();
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      setProvider(p);
      setAccount(getAddress(accounts[0]!));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const ensureNetwork = useCallback(
    async (network: NetworkName) => {
      await provider?.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: numberToHex(NETWORKS[network].chain.id) }],
      });
    },
    [provider],
  );

  const value = useMemo(
    () => ({ account, provider, connect, ensureNetwork, error, setError }),
    [account, provider, connect, ensureNetwork, error],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}

export function ConnectButton() {
  const { account, connect } = useWallet();
  if (account) {
    return (
      <span className="pill mono" title={account}>
        {account.slice(0, 6)}…{account.slice(-4)}
      </span>
    );
  }
  return (
    <button className="primary" onClick={connect}>
      Connect smart wallet
    </button>
  );
}

export function ErrorBanner() {
  const { error, setError } = useWallet();
  if (!error) return null;
  return (
    <div className="banner error" role="alert">
      <span>{error}</span>
      <button className="ghost" onClick={() => setError(undefined)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
