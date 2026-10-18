"use client";

import { fetchPermissions, getPermissionStatus, requestRevoke } from "@base-org/account/spend-permission/browser";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, isAddress, type Address } from "viem";
import { forgetSpender, NETWORKS, rememberedSpenders, rememberSpender, type NetworkName } from "../lib";
import { useWallet } from "../wallet";

type Permission = Awaited<ReturnType<typeof fetchPermissions>>[number];
type Status = Awaited<ReturnType<typeof getPermissionStatus>>;

interface Row {
  spender: Address;
  permission: Permission;
  status?: Status;
}

export default function AgentsPage() {
  const { account, provider, ensureNetwork, setError } = useWallet();
  const [network, setNetwork] = useState<NetworkName>("base");
  const [rows, setRows] = useState<Row[]>();
  const [spenders, setSpenders] = useState<Address[]>([]);
  const [newSpender, setNewSpender] = useState("");

  useEffect(() => setSpenders(rememberedSpenders()), []);

  const load = useCallback(async () => {
    if (!account || !provider) return;
    setRows(undefined);
    try {
      const chainId = NETWORKS[network].chain.id;
      const found: Row[] = [];
      for (const spender of spenders) {
        const permissions = await fetchPermissions({ account, chainId, spender, provider });
        for (const permission of permissions) {
          found.push({ spender, permission, status: await getPermissionStatus(permission).catch(() => undefined) });
        }
      }
      setRows(found);
    } catch (err) {
      setError((err as Error).message);
      setRows([]);
    }
  }, [account, provider, network, spenders, setError]);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(row: Row) {
    if (!provider) return;
    try {
      await ensureNetwork(network);
      await requestRevoke({ provider, permission: row.permission });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function addSpender() {
    if (!isAddress(newSpender)) return;
    rememberSpender(newSpender);
    setSpenders(rememberedSpenders());
    setNewSpender("");
  }

  function forget(spender: Address) {
    forgetSpender(spender);
    setSpenders(rememberedSpenders());
  }

  return (
    <>
      <div className="row spread">
        <h1>Agents</h1>
        <Link href="/agents/new">
          <button className="primary">New budget</button>
        </Link>
      </div>
      <p className="lede">Budgets you have granted, how much is left this period, and a revoke switch for each.</p>

      {!account ? (
        <div className="card muted">Connect your wallet to see your agents.</div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 16 }}>
            <select value={network} onChange={(e) => setNetwork(e.target.value as NetworkName)} aria-label="Network">
              <option value="base">Base</option>
              <option value="base-sepolia">Base Sepolia (test)</option>
            </select>
            <button onClick={load}>Refresh</button>
          </div>

          {rows === undefined && <div className="card muted">Loading…</div>}
          {rows?.length === 0 && (
            <div className="card muted">
              No budgets found on {NETWORKS[network].chain.name} for the agents this browser knows about.
            </div>
          )}
          {rows?.map((row) => {
            const p = row.permission.permission;
            const active = row.status?.isActive;
            return (
              <div className="card" key={row.permission.permissionHash ?? `${row.spender}-${p.salt}`}>
                <div className="row spread">
                  <span className="mono">{row.spender}</span>
                  <span className={`pill ${active ? "ok" : "off"}`}>
                    {row.status ? (row.status.isRevoked ? "revoked" : active ? "active" : "inactive") : "unknown"}
                  </span>
                </div>
                <p>
                  {formatUnits(BigInt(p.allowance), 6)} USDC every {p.period / 86400} day(s)
                  {row.status && (
                    <>
                      {" · "}
                      <strong>{formatUnits(row.status.remainingSpend, 6)} USDC left</strong>, resets{" "}
                      {row.status.nextPeriodStart.toLocaleString()}
                    </>
                  )}
                </p>
                {!row.status?.isRevoked && (
                  <button className="danger" onClick={() => revoke(row)}>
                    Revoke
                  </button>
                )}
              </div>
            );
          })}

          <div className="card">
            <h2>Known agents</h2>
            <ul className="plain">
              {spenders.map((s) => (
                <li key={s} className="row spread">
                  <span className="mono small">{s}</span>
                  <button className="ghost" onClick={() => forget(s)} aria-label={`Forget ${s}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="row" style={{ marginTop: 10 }}>
              <input
                className="mono"
                style={{ flex: 1 }}
                placeholder="Add an agent address 0x…"
                value={newSpender}
                onChange={(e) => setNewSpender(e.target.value.trim())}
              />
              <button onClick={addSpender} disabled={!isAddress(newSpender)}>
                Add
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
