import { createDto } from './dto';
import { z } from 'zod';

/** Money is accepted as number or decimal string and always returned as a string ("1500000.00"). */
export const zMoneyInput = z.union([
  z.number().finite(),
  z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Must be a decimal with up to 2 places'),
]);
export const zQtyInput = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^\d+(\.\d{1,3})?$/, 'Must be a decimal with up to 3 places'),
]);
export const zPercentInput = z.union([
  z.number().min(0).max(100),
  z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
]);
export const zMoney = z.string().describe('Decimal amount as string, e.g. "1500000.00"');
export const zQty = z.string().describe('Decimal quantity as string');
export const zDate = z.string().describe('ISO date (YYYY-MM-DD) or datetime');
export const zDateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Expected YYYY-MM-DD')
  .transform((v) => new Date(v.slice(0, 10) + 'T00:00:00.000Z'));
export const zUuid = z.string().uuid();

export const zPageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().optional(),
  sort: z.string().optional(),
});
export type PageQuery = z.infer<typeof zPageQuery>;

export const zDateRange = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const zPageMeta = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), meta: zPageMeta });
}

export function pageArgs(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function pageMeta(q: { page: number; pageSize: number }, total: number) {
  return { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

export function dateRangeWhere(r: { dateFrom?: string; dateTo?: string }) {
  if (!r.dateFrom && !r.dateTo) return undefined;
  return {
    ...(r.dateFrom ? { gte: new Date(r.dateFrom + 'T00:00:00.000Z') } : {}),
    ...(r.dateTo ? { lte: new Date(r.dateTo + 'T23:59:59.999Z') } : {}),
  };
}

export const zOk = z.object({ ok: z.boolean() });
export class OkDto extends createDto(zOk) {}

export const zVoidBody = z.object({ reason: z.string().min(3).max(500) });
export class VoidDto extends createDto(zVoidBody) {}

export const zUserRef = z.object({ id: z.string(), name: z.string() }).nullable();

/** Converts Prisma rows (Decimal, Date) to plain JSON-compatible values for typed responses. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
