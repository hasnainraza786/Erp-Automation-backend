import { BadRequestException, Injectable } from '@nestjs/common';
import { AccountType, PaymentMethod } from '@prisma/client';
import { D, money, sum, type DecimalInput } from '../common/money';
import { NumberingService } from './numbering.service';
import { Tx } from './prisma.service';

export const ACCOUNTS = {
  CASH: '1000',
  BANK: '1010',
  AR: '1100',
  INVENTORY: '1200',
  AP: '2000',
  TAX_PAYABLE: '2100',
  EQUITY: '3000',
  SALES: '4000',
  INSTALLATION_INCOME: '4010',
  PROGRAMMING_INCOME: '4020',
  ENGINEERING_INCOME: '4030',
  TRANSPORT_INCOME: '4040',
  OTHER_INCOME: '4090',
  COGS: '5000',
  INSTALLATION_LABOR: '5100',
  PROGRAMMING_COST: '5110',
  TRANSPORT_EXPENSE: '5120',
  SALARIES: '5200',
  OFFICE_EXPENSE: '5300',
  OTHER_EXPENSE: '5900',
} as const;

export const CHART_OF_ACCOUNTS: { code: string; name: string; type: AccountType }[] = [
  { code: ACCOUNTS.CASH, name: 'Cash', type: 'ASSET' },
  { code: ACCOUNTS.BANK, name: 'Bank', type: 'ASSET' },
  { code: ACCOUNTS.AR, name: 'Accounts Receivable', type: 'ASSET' },
  { code: ACCOUNTS.INVENTORY, name: 'Inventory', type: 'ASSET' },
  { code: ACCOUNTS.AP, name: 'Accounts Payable', type: 'LIABILITY' },
  { code: ACCOUNTS.TAX_PAYABLE, name: 'Tax Payable', type: 'LIABILITY' },
  { code: ACCOUNTS.EQUITY, name: "Owner's Equity", type: 'EQUITY' },
  { code: ACCOUNTS.SALES, name: 'Product Sales', type: 'INCOME' },
  { code: ACCOUNTS.INSTALLATION_INCOME, name: 'Installation Income', type: 'INCOME' },
  { code: ACCOUNTS.PROGRAMMING_INCOME, name: 'Programming Income', type: 'INCOME' },
  { code: ACCOUNTS.ENGINEERING_INCOME, name: 'Engineering Income', type: 'INCOME' },
  { code: ACCOUNTS.TRANSPORT_INCOME, name: 'Transportation Income', type: 'INCOME' },
  { code: ACCOUNTS.OTHER_INCOME, name: 'Other Income', type: 'INCOME' },
  { code: ACCOUNTS.COGS, name: 'Purchase Cost / COGS', type: 'EXPENSE' },
  { code: ACCOUNTS.INSTALLATION_LABOR, name: 'Installation Labor', type: 'EXPENSE' },
  { code: ACCOUNTS.PROGRAMMING_COST, name: 'Programming Cost', type: 'EXPENSE' },
  { code: ACCOUNTS.TRANSPORT_EXPENSE, name: 'Transport', type: 'EXPENSE' },
  { code: ACCOUNTS.SALARIES, name: 'Salaries', type: 'EXPENSE' },
  { code: ACCOUNTS.OFFICE_EXPENSE, name: 'Office Expense', type: 'EXPENSE' },
  { code: ACCOUNTS.OTHER_EXPENSE, name: 'Other Expenses', type: 'EXPENSE' },
];

export const EXPENSE_CATEGORY_ACCOUNT: Record<string, string> = {
  TRANSPORT: ACCOUNTS.TRANSPORT_EXPENSE,
  INSTALLATION_LABOR: ACCOUNTS.INSTALLATION_LABOR,
  PROGRAMMING: ACCOUNTS.PROGRAMMING_COST,
  SALARIES: ACCOUNTS.SALARIES,
  OFFICE: ACCOUNTS.OFFICE_EXPENSE,
  OTHER: ACCOUNTS.OTHER_EXPENSE,
};

export function cashAccountFor(method: PaymentMethod) {
  return method === 'CASH' ? ACCOUNTS.CASH : ACCOUNTS.BANK;
}

export interface JournalLineInput {
  account: string;
  debit?: DecimalInput;
  credit?: DecimalInput;
  memo?: string;
  clientId?: string | null;
  siteId?: string | null;
  projectId?: string | null;
  vendorId?: string | null;
}

export interface JournalInput {
  date: Date;
  description: string;
  sourceType: string;
  sourceId?: string;
  reference?: string;
  createdBy?: string;
  lines: JournalLineInput[];
}

@Injectable()
export class JournalService {
  constructor(private readonly numbering: NumberingService) {}

  async post(tx: Tx, input: JournalInput) {
    const lines = input.lines.filter((l) => !D(l.debit).isZero() || !D(l.credit).isZero());
    const debit = sum(lines.map((l) => l.debit));
    const credit = sum(lines.map((l) => l.credit));
    if (!debit.equals(credit)) {
      throw new BadRequestException(`Unbalanced journal: debit ${debit.toFixed(2)} != credit ${credit.toFixed(2)}`);
    }
    if (lines.length === 0) return null;
    if (lines.some((l) => D(l.debit).isNegative() || D(l.credit).isNegative())) {
      throw new BadRequestException('Journal lines cannot be negative');
    }

    const accounts = await tx.account.findMany({ where: { code: { in: lines.map((l) => l.account) } } });
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));

    return tx.journalEntry.create({
      data: {
        number: await this.numbering.next(tx, 'JOURNAL', input.date),
        entryDate: input.date,
        description: input.description,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        reference: input.reference,
        createdBy: input.createdBy,
        lines: {
          create: lines.map((l) => {
            const accountId = byCode.get(l.account);
            if (!accountId) throw new BadRequestException(`Unknown account ${l.account}`);
            return {
              accountId,
              debit: money(l.debit),
              credit: money(l.credit),
              memo: l.memo,
              clientId: l.clientId ?? undefined,
              siteId: l.siteId ?? undefined,
              projectId: l.projectId ?? undefined,
              vendorId: l.vendorId ?? undefined,
            };
          }),
        },
      },
    });
  }

  /** Posts a mirror entry for every posted journal of the given source and marks them voided. */
  async reverseSource(tx: Tx, sourceType: string, sourceId: string, reason: string, userId?: string) {
    const entries = await tx.journalEntry.findMany({
      where: { sourceType, sourceId, status: 'POSTED', reversalOfId: null },
      include: { lines: true },
    });
    for (const entry of entries) {
      if (await tx.journalEntry.findUnique({ where: { reversalOfId: entry.id } })) continue;
      const accounts = await tx.account.findMany({ where: { id: { in: entry.lines.map((l) => l.accountId) } } });
      const codeById = new Map(accounts.map((a) => [a.id, a.code]));
      const reversal = await this.post(tx, {
        date: new Date(),
        description: `Reversal of ${entry.number}: ${reason}`,
        sourceType: 'REVERSAL',
        sourceId: entry.id,
        reference: entry.reference ?? undefined,
        createdBy: userId,
        lines: entry.lines.map((l) => ({
          account: codeById.get(l.accountId)!,
          debit: l.credit,
          credit: l.debit,
          memo: l.memo ?? undefined,
          clientId: l.clientId,
          siteId: l.siteId,
          projectId: l.projectId,
          vendorId: l.vendorId,
        })),
      });
      if (reversal) {
        await tx.journalEntry.update({ where: { id: reversal.id }, data: { reversalOfId: entry.id } });
      }
      await tx.journalEntry.update({ where: { id: entry.id }, data: { status: 'VOIDED' } });
    }
  }
}
