"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { NETWORKS, usdcBalance, type NetworkName } from "./lib";
import { useWallet } from "./wallet";

export default function WalletPage() {
  const { account, setError } = useWallet();
  const [network, setNetwork] = useState<NetworkName>("base");
  const [balance, setBalance] = useState<bigint>();
  const [copied, setCopied] = useState(false);
  const [buying, setBuying] = useState(false);

  const refresh = useCallback(async () => {
    if (!account) return;
    try {
      setBalance(await usdcBalance(network, account));
    } catch (err) {
      setError(`Could not read balance: ${(err as Error).message}`);
    }
  }, [account, network, setError]);

  useEffect(() => {
    setBalance(undefined);
    refresh();
  }, [refresh]);

  async function buyWithCard() {
    if (!account) return;
    setBuying(true);
    try {
      const res = await fetch("/api/onramp/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: account }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? `Onramp unavailable (${res.status})`);
      window.open(body.url, "_blank", "noopener");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBuying(false);
    }
  }

  async function copyAddress() {
    if (!account) return;
    await navigator.clipboard.writeText(account);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <h1>Your wallet</h1>
      <p className="lede">
        You hold the keys. Fund it with USDC on Base, then give each agent a capped budget it can pull from. mei never
        holds your money or asks who you are.
      </p>

      {!account ? (
        <div className="card">
          <p className="muted">Connect a Coinbase smart wallet to get started. Agent budgets use its spend permissions.</p>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="row spread">
              <h2>USDC balance</h2>
              <select value={network} onChange={(e) => setNetwork(e.target.value as NetworkName)} aria-label="Network">
                <option value="base">Base</option>
                <option value="base-sepolia">Base Sepolia (test)</option>
              </select>
            </div>
            <div className="row spread">
              <span className="big">{balance === undefined ? "…" : `${formatUnits(balance, 6)} USDC`}</span>
              <button onClick={refresh}>Refresh</button>
            </div>
          </div>

          <div className="card">
            <h2>Add funds</h2>
            <p className="muted small">Send USDC on {NETWORKS[network].chain.name} from any wallet or exchange to:</p>
            <pre className="code mono">{account}</pre>
            <div className="row">
              <button onClick={copyAddress}>{copied ? "Copied" : "Copy address"}</button>
              {network === "base" && (
                <button className="primary" onClick={buyWithCard} disabled={buying}>
                  {buying ? "Opening…" : "Buy USDC with card"}
                </button>
              )}
            </div>
            {network === "base" && (
              <p className="muted small">
                Card purchases are handled by Coinbase Onramp, which runs its own checks. mei only passes your wallet
                address.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
