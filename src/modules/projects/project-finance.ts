import { D, Decimal, money } from '../../common/money';
import { arBalance } from '../../infra/balances';
import { ACCOUNTS } from '../../infra/journal.service';
import { PrismaService, Tx } from '../../infra/prisma.service';

type Db = PrismaService | Tx;

/** Marks milestones received in schedule order based on the total allocated to the project. */
export async function recomputeMilestones(tx: Tx, projectId: string) {
  const [milestones, agg] = await Promise.all([
    tx.paymentMilestone.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' }, include: { invoice: true } }),
    tx.paymentAllocation.aggregate({ where: { projectId, status: 'POSTED' }, _sum: { amount: true } }),
  ]);
  const received = D(agg._sum.amount);
  let cumulative = new Decimal(0);
  for (const m of milestones) {
    const start = cumulative;
    cumulative = cumulative.plus(D(m.amount));
    const hasInvoice = m.invoice && m.invoice.status !== 'CANCELLED';
    const status = received.gte(cumulative)
      ? 'RECEIVED'
      : received.gt(start)
        ? 'PARTIALLY_RECEIVED'
        : hasInvoice
          ? 'INVOICED'
          : 'PENDING';
    if (status !== m.status) await tx.paymentMilestone.update({ where: { id: m.id }, data: { status } });
  }
}

/** Contract, collection and profitability figures for a project. Profit uses product cost, never selling price. */
export async function projectFinancials(db: Db, projectId: string) {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { items: true, quotation: { include: { revisions: true } } },
  });
  const rev = project.quotation.revisions.find((r) => r.revisionNo === project.revisionNo)!;
  const [invoiced, received, expenses, cogsAcc] = await Promise.all([
    db.invoice.aggregate({ where: { projectId, status: { notIn: ['DRAFT', 'CANCELLED'] } }, _sum: { total: true } }),
    db.paymentAllocation.aggregate({ where: { projectId, status: 'POSTED' }, _sum: { amount: true } }),
    db.expense.groupBy({ by: ['category'], where: { projectId, status: 'POSTED' }, _sum: { amount: true } }),
    db.account.findUniqueOrThrow({ where: { code: ACCOUNTS.COGS } }),
  ]);
  const cogs = await db.journalLine.aggregate({ where: { projectId, accountId: cogsAcc.id }, _sum: { debit: true, credit: true } });

  const contractValue = D(project.contractValue);
  const revenue = contractValue.minus(D(rev.taxTotal));
  const estimatedProductCost = project.items.reduce((a, i) => a.plus(D(i.requiredQty).times(D(i.unitCost))), new Decimal(0));
  const actualProductCost = D(cogs._sum.debit).minus(D(cogs._sum.credit));
  const expenseTotal = expenses.reduce((a, e) => a.plus(D(e._sum.amount)), new Decimal(0));
  const receivedAmount = D(received._sum.amount);

  const estimatedProfit = revenue.minus(estimatedProductCost).minus(expenseTotal);
  // Until all products are delivered, actual product cost is incomplete; use the larger of estimate/actual for a prudent figure.
  const costForActual = Decimal.max(actualProductCost, estimatedProductCost);
  const actualProfit = revenue.minus(costForActual).minus(expenseTotal);
  const pct = (v: Decimal) => (revenue.isZero() ? '0.00' : v.div(revenue).times(100).toFixed(2));

  return {
    contractValue: money(contractValue),
    revenueExTax: money(revenue),
    taxTotal: money(rev.taxTotal),
    invoiced: money(invoiced._sum.total),
    received: money(receivedAmount),
    balanceToCollect: money(contractValue.minus(receivedAmount)),
    outstanding: money(await arBalance(db, { projectId })),
    estimatedProductCost: money(estimatedProductCost),
    actualProductCost: money(actualProductCost),
    expenses: money(expenseTotal),
    expensesByCategory: expenses.map((e) => ({ category: e.category, amount: money(e._sum.amount) })),
    estimatedCost: money(estimatedProductCost.plus(expenseTotal)),
    estimatedProfit: money(estimatedProfit),
    estimatedMargin: pct(estimatedProfit),
    actualProfit: money(actualProfit),
    actualMargin: pct(actualProfit),
  };
}
