import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import type { NetworkName } from "./chain.js";
import type { KeyFile } from "./keystore.js";
import { DEFAULT_POLICY, type Policy, type SpendRecord } from "./policy.js";
import type { SpendPermission } from "./spend.js";

export interface MeiConfig {
  network: NetworkName;
  rpcUrl?: string;
  permission?: SpendPermission;
  policy: Policy;
}

/** Redemption codes are never written here; they are re-fetched from Bitrefill on demand. */
export interface PurchaseRecord {
  at: number;
  invoiceId: string;
  productId: string;
  packageValue: string;
  /** Atomic USDC units. */
  amount: string;
  spendTxs: string[];
  status: "paid" | "failed";
  error?: string;
}

/** Local state under ~/.mei (or $MEI_HOME). Files are owner-only. */
export class Store {
  constructor(readonly home = process.env.MEI_HOME ?? join(homedir(), ".mei")) {}

  private path(name: string) {
    return join(this.home, name);
  }

  private ensureHome() {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
  }

  private writePrivate(name: string, contents: string) {
    this.ensureHome();
    writeFileSync(this.path(name), contents, { mode: 0o600 });
  }

  readConfig(): MeiConfig | undefined {
    const file = this.path("config.json");
    if (!existsSync(file)) return undefined;
    const config = JSON.parse(readFileSync(file, "utf8")) as MeiConfig;
    return { ...config, policy: { ...DEFAULT_POLICY, ...config.policy } };
  }

  requireConfig(): MeiConfig {
    const config = this.readConfig();
    if (!config) throw new Error(`No config in ${this.home}; run \`mei init\` first.`);
    return config;
  }

  writeConfig(config: MeiConfig) {
    this.writePrivate("config.json", JSON.stringify(config, null, 2) + "\n");
  }

  readKey(): KeyFile | undefined {
    const file = this.path("agent-key.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as KeyFile) : undefined;
  }

  writeKey(key: KeyFile) {
    this.writePrivate("agent-key.json", JSON.stringify(key, null, 2) + "\n");
  }

  agentAddress(): Address | undefined {
    return this.readKey()?.address;
  }

  appendPurchase(record: PurchaseRecord) {
    this.ensureHome();
    appendFileSync(this.path("purchases.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
  }

  purchases(): PurchaseRecord[] {
    const file = this.path("purchases.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PurchaseRecord);
  }

  spendHistory(): SpendRecord[] {
    return this.purchases()
      .filter((p) => p.status === "paid")
      .map((p) => ({ at: p.at, amount: BigInt(p.amount) }));
  }
}
