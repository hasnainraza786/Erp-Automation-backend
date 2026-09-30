import { Injectable } from '@nestjs/common';
import { Tx } from './prisma.service';

export type DocType =
  | 'CLIENT' | 'SITE' | 'VENDOR' | 'QUOTATION' | 'PROJECT' | 'INVOICE' | 'PAYMENT'
  | 'PURCHASE_ORDER' | 'GOODS_RECEIPT' | 'VENDOR_PAYMENT' | 'EXPENSE' | 'JOURNAL';

export interface NumberFormat {
  prefix: string;
  yearly: boolean;
  padding: number;
}

export const DEFAULT_NUMBERING: Record<DocType, NumberFormat> = {
  CLIENT: { prefix: 'CL', yearly: false, padding: 5 },
  SITE: { prefix: 'ST', yearly: false, padding: 5 },
  VENDOR: { prefix: 'VN', yearly: false, padding: 4 },
  QUOTATION: { prefix: 'QT', yearly: true, padding: 4 },
  PROJECT: { prefix: 'PRJ', yearly: true, padding: 4 },
  INVOICE: { prefix: 'INV', yearly: true, padding: 4 },
  PAYMENT: { prefix: 'PAY', yearly: true, padding: 4 },
  PURCHASE_ORDER: { prefix: 'PO', yearly: true, padding: 4 },
  GOODS_RECEIPT: { prefix: 'GRN', yearly: true, padding: 4 },
  VENDOR_PAYMENT: { prefix: 'VP', yearly: true, padding: 4 },
  EXPENSE: { prefix: 'EXP', yearly: true, padding: 4 },
  JOURNAL: { prefix: 'JE', yearly: true, padding: 5 },
};

/**
 * Gap-safe, unique document numbers. The counter row is incremented inside the caller's
 * transaction, so the row lock is held until commit and a rollback releases the number.
 */
@Injectable()
export class NumberingService {
  async next(tx: Tx, type: DocType, date = new Date()): Promise<string> {
    const setting = await tx.setting.findUnique({ where: { key: 'numbering' } });
    const overrides = (setting?.value ?? {}) as Partial<Record<DocType, Partial<NumberFormat>>>;
    const fmt = { ...DEFAULT_NUMBERING[type], ...(overrides[type] ?? {}) };
    const year = date.getUTCFullYear();
    const seqId = fmt.yearly ? `${type}:${year}` : type;

    const rows = await tx.$queryRaw<{ current: number }[]>`
      INSERT INTO "NumberSequence" ("id", "current") VALUES (${seqId}, 1)
      ON CONFLICT ("id") DO UPDATE SET "current" = "NumberSequence"."current" + 1
      RETURNING "current"`;
    const n = String(rows[0].current).padStart(fmt.padding, '0');
    return fmt.yearly ? `${fmt.prefix}-${year}-${n}` : `${fmt.prefix}-${n}`;
  }
}
