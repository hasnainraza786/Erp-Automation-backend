import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type DecimalInput = Decimal.Value | Prisma.Decimal | null | undefined;

export function D(value: DecimalInput): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(value.toString());
}

export const ZERO = new Decimal(0);

export function round2(value: DecimalInput): Decimal {
  return D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function round3(value: DecimalInput): Decimal {
  return D(value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

export function sum(values: DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));
}

export function minD(a: DecimalInput, b: DecimalInput): Decimal {
  return Decimal.min(D(a), D(b));
}

export function maxD(a: DecimalInput, b: DecimalInput): Decimal {
  return Decimal.max(D(a), D(b));
}

/** Converts to a Prisma-compatible decimal string with fixed 2 places. */
export function money(value: DecimalInput): string {
  return round2(value).toFixed(2);
}

export function qty(value: DecimalInput): string {
  return round3(value).toFixed(3);
}

export { Decimal };
