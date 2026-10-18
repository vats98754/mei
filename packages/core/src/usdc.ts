import { formatUnits, parseUnits } from "viem";

export const USDC_DECIMALS = 6;

/** Parses a decimal USD string ("12.5") into atomic USDC units. */
export function parseUsdc(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) {
    throw new Error(`Invalid USDC amount: ${JSON.stringify(value)}`);
  }
  const [, fraction = ""] = value.trim().split(".");
  if (fraction.length > USDC_DECIMALS) {
    throw new Error(`USDC supports at most ${USDC_DECIMALS} decimals: ${value}`);
  }
  return parseUnits(value.trim(), USDC_DECIMALS);
}

export function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}
