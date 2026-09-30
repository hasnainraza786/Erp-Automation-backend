import { Prisma } from '@prisma/client';
import { D, Decimal } from '../common/money';
import { ACCOUNTS } from './journal.service';
import { PrismaService, Tx } from './prisma.service';

type Db = PrismaService | Tx;

async function accountId(db: Db, code: string) {
  const acc = await db.account.findUniqueOrThrow({ where: { code } });
  return acc.id;
}

/** Receivable balance (debit - credit on AR) for a client, optionally narrowed to site/project. */
export async function arBalance(
  db: Db,
  filter: { clientId?: string; siteId?: string; projectId?: string },
): Promise<Decimal> {
  const agg = await db.journalLine.aggregate({
    where: { accountId: await accountId(db, ACCOUNTS.AR), ...filter },
    _sum: { debit: true, credit: true },
  });
  return D(agg._sum.debit).minus(D(agg._sum.credit));
}

/** Payable balance (credit - debit on AP) for a vendor. */
export async function apBalance(db: Db, vendorId?: string): Promise<Decimal> {
  const agg = await db.journalLine.aggregate({
    where: { accountId: await accountId(db, ACCOUNTS.AP), ...(vendorId ? { vendorId } : {}) },
    _sum: { debit: true, credit: true },
  });
  return D(agg._sum.credit).minus(D(agg._sum.debit));
}

export async function accountBalance(db: Db, code: string, where: Prisma.JournalLineWhereInput = {}) {
  const agg = await db.journalLine.aggregate({
    where: { accountId: await accountId(db, code), ...where },
    _sum: { debit: true, credit: true },
  });
  return D(agg._sum.debit).minus(D(agg._sum.credit));
}

/** Balances grouped by a dimension column in one query. */
export async function arBalancesBy(db: Db, dim: 'clientId' | 'siteId' | 'projectId', where: Prisma.JournalLineWhereInput = {}) {
  const rows = await db.journalLine.groupBy({
    by: [dim],
    where: { accountId: await accountId(db, ACCOUNTS.AR), ...where },
    _sum: { debit: true, credit: true },
  });
  return new Map(rows.map((r) => [r[dim] as string, D(r._sum.debit).minus(D(r._sum.credit))]));
}

export async function apBalancesByVendor(db: Db) {
  const rows = await db.journalLine.groupBy({
    by: ['vendorId'],
    where: { accountId: await accountId(db, ACCOUNTS.AP) },
    _sum: { debit: true, credit: true },
  });
  return new Map(rows.map((r) => [r.vendorId as string, D(r._sum.credit).minus(D(r._sum.debit))]));
}
