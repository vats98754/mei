"use client";

import { requestSpendPermission } from "@base-org/account/spend-permission/browser";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { isAddress, numberToHex, parseEther, parseUnits, type Address } from "viem";
import { asNetwork, encodeLinkCode, NETWORKS, rememberSpender } from "../../lib";
import { useWallet } from "../../wallet";

const GAS_TOP_UP = "0.0002";

function GrantForm() {
  const params = useSearchParams();
  const { account, provider, ensureNetwork, setError } = useWallet();
  const [spender, setSpender] = useState(params.get("spender") ?? "");
  const [network, setNetwork] = useState(asNetwork(params.get("network")));
  const [allowance, setAllowance] = useState("50");
  const [periodInDays, setPeriodInDays] = useState("7");
  const [linkCode, setLinkCode] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [gasSent, setGasSent] = useState(false);

  const validSpender = isAddress(spender);

  async function grant() {
    if (!account || !provider || !validSpender) return;
    setBusy(true);
    setError(undefined);
    try {
      await ensureNetwork(network);
      const permission = await requestSpendPermission({
        account,
        spender,
        token: NETWORKS[network].usdc,
        chainId: NETWORKS[network].chain.id,
        allowance: parseUnits(allowance, 6),
        periodInDays: Number(periodInDays),
        provider,
      });
      rememberSpender(spender as Address);
      setLinkCode(encodeLinkCode({ ...permission, chainId: NETWORKS[network].chain.id }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendGas() {
    if (!account || !provider || !validSpender) return;
    try {
      await ensureNetwork(network);
      await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: spender, value: numberToHex(parseEther(GAS_TOP_UP)) }],
      });
      setGasSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Give an agent a budget</h1>
      <p className="lede">
        The agent can pull up to this much USDC from your wallet each period, and nothing more. The limit is enforced
        on-chain and you can revoke it any time from the Agents page.
      </p>

      <div className="card">
        <label>
          Agent address (printed by <span className="mono">mei init</span>)
          <input className="mono" value={spender} onChange={(e) => setSpender(e.target.value.trim())} placeholder="0x…" />
        </label>
        {spender && !validSpender && <p className="small" style={{ color: "var(--danger)" }}>Not a valid address.</p>}

        <div className="grid2" style={{ marginTop: 12 }}>
          <label>
            Allowance (USDC)
            <input inputMode="decimal" value={allowance} onChange={(e) => setAllowance(e.target.value)} />
          </label>
          <label>
            Every (days)
            <input inputMode="numeric" value={periodInDays} onChange={(e) => setPeriodInDays(e.target.value)} />
          </label>
          <label>
            Network
            <select value={network} onChange={(e) => setNetwork(asNetwork(e.target.value))}>
              <option value="base">Base</option>
              <option value="base-sepolia">Base Sepolia (test)</option>
            </select>
          </label>
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button
            className="primary"
            onClick={grant}
            disabled={!account || !validSpender || busy || !(Number(allowance) > 0) || !(Number(periodInDays) >= 1)}
          >
            {busy ? "Waiting for wallet…" : "Grant budget"}
          </button>
          {!account && <span className="muted small">Connect your wallet first.</span>}
        </div>
      </div>

      {linkCode && (
        <div className="card">
          <h2>Link it to the agent</h2>
          <p className="muted small">Run this where the agent runs:</p>
          <pre className="code mono">mei link {linkCode}</pre>
          <div className="row">
            <button onClick={() => navigator.clipboard.writeText(`mei link ${linkCode}`)}>Copy command</button>
          </div>

          <h2 style={{ marginTop: 18 }}>Gas for the agent</h2>
          <p className="muted small">
            The agent pays a tiny amount of ETH on Base to pull funds from your wallet. Send it {GAS_TOP_UP} ETH (a few
            cents) if it has none.
          </p>
          <button onClick={sendGas} disabled={gasSent}>
            {gasSent ? "Sent" : `Send ${GAS_TOP_UP} ETH`}
          </button>
        </div>
      )}
    </>
  );
}

export default function NewAgentPage() {
  return (
    <Suspense>
      <GrantForm />
    </Suspense>
  );
}
