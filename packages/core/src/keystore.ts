import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { Address, Hex } from "viem";

export interface KeyFile {
  version: 1;
  address: Address;
  /** Absent when the key is stored unencrypted (no passphrase configured). */
  cipher?: {
    salt: string;
    iv: string;
    tag: string;
    N: number;
  };
  data: string;
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase: string, salt: Buffer, N: number): Buffer {
  return scryptSync(passphrase, salt, 32, { ...SCRYPT, N });
}

export function encryptKey(privateKey: Hex, address: Address, passphrase?: string): KeyFile {
  if (!passphrase) return { version: 1, address, data: privateKey };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt, SCRYPT.N), iv);
  const data = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return {
    version: 1,
    address,
    cipher: {
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      N: SCRYPT.N,
    },
    data: data.toString("hex"),
  };
}

export function decryptKey(file: KeyFile, passphrase?: string): Hex {
  if (!file.cipher) return file.data as Hex;
  if (!passphrase) throw new Error("Agent key is encrypted; set MEI_PASSPHRASE.");
  const { salt, iv, tag, N } = file.cipher;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(passphrase, Buffer.from(salt, "hex"), N),
    Buffer.from(iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(file.data, "hex")), decipher.final()]).toString(
      "utf8",
    ) as Hex;
  } catch {
    throw new Error("Could not decrypt agent key: wrong MEI_PASSPHRASE.");
  }
}
