import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { decryptKey, encryptKey } from "../src/keystore.js";
import { decodeLinkCode, encodeLinkCode, type SpendPermission } from "../src/spend.js";
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

describe("link codes", () => {
  const permission: SpendPermission = {
    signature: "0xabc",
    chainId: 8453,
    permission: {
      account: "0x1111111111111111111111111111111111111111",
      spender: "0x2222222222222222222222222222222222222222",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      allowance: "50000000",
      period: 86400,
      start: 0,
      end: 281474976710655,
      salt: "0x1",
      extraData: "0x",
    },
  };

  it("round-trips a signed permission", () => {
    expect(decodeLinkCode(encodeLinkCode(permission))).toEqual(permission);
  });

  it("rejects garbage", () => {
    expect(() => decodeLinkCode("not-a-code")).toThrow();
    expect(() => decodeLinkCode(Buffer.from('{"foo":1}').toString("base64url"))).toThrow(/signed spend permission/);
  });
});
