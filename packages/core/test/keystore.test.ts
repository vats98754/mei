import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { decryptKey, encryptKey } from "../src/keystore.js";
import { Store } from "../src/store.js";

describe("keystore", () => {
  const pk = generatePrivateKey();
  const { address } = privateKeyToAccount(pk);

  it("round-trips an encrypted key", () => {
    const file = encryptKey(pk, address, "hunter2");
    expect(file.data).not.toContain(pk.slice(2));
    expect(decryptKey(file, "hunter2")).toBe(pk);
  });

  it("rejects a wrong or missing passphrase", () => {
    const file = encryptKey(pk, address, "hunter2");
    expect(() => decryptKey(file, "wrong")).toThrow(/wrong MEI_PASSPHRASE/);
    expect(() => decryptKey(file)).toThrow(/set MEI_PASSPHRASE/);
  });

  it("stores state with owner-only permissions", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "mei-")), "home"));
    store.writeKey(encryptKey(pk, address));
    expect(statSync(store.home).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.home, "agent-key.json")).mode & 0o777).toBe(0o600);
    expect(store.agentAddress()).toBe(address);
  });
});
