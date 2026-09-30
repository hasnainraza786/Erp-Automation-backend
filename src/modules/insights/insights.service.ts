import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth.decorators';
import { D, Decimal, money, qty, sum } from '../../common/money';
import { hasPermission, PERMISSIONS } from '../../common/permissions';
import { dateRangeWhere, pageArgs } from '../../common/schemas';
import { accountBalance, apBalance, apBalancesByVendor, arBalance, arBalancesBy } from '../../infra/balances';
import { ACCOUNTS } from '../../infra/journal.service';
import { PrismaService } from '../../infra/prisma.service';
import { ProfitabilityQueryDto, SalesReportQueryDto } from './insights.schemas';

const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / 86400_000);

type Buckets = { current: Decimal; d0_30: Decimal; d31_60: Decimal; d61_90: Decimal; d90plus: Decimal };
const emptyBuckets = (): Buckets => ({ current: D(0), d0_30: D(0), d31_60: D(0), d61_90: D(0), d90plus: D(0) });
function bucketFor(ageDays: number): keyof Buckets {
  if (ageDays < 0) return 'current';
  if (ageDays <= 30) return 'd0_30';
  if (ageDays <= 60) return 'd31_60';
  if (ageDays <= 90) return 'd61_90';
  return 'd90plus';
}
const presentBuckets = (b: Buckets) => ({
  current: money(b.current),
  d0_30: money(b.d0_30),
  d31_60: money(b.d31_60),
  d61_90: money(b.d61_90),
  d90plus: money(b.d90plus),
  total: money(sum(Object.values(b))),
});

const ACTIVITY_ACTIONS = [
  'quotation.approved', 'quotation.sent', 'quotation.revised', 'quotation.created', 'payment.created', 'payment.voided',
  'po.sent', 'po.received', 'product.price_changed', 'invoice.issued', 'project.status_changed', 'vendor_payment.created',
];

@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────── helpers ───────────

  /** Unpaid portion of each project's milestones, aged by due date (payments settle the earliest milestones first). */
  private async receivableItems() {
    const projects = await this.prisma.project.findMany({
      where: { status: { not: 'CANCELLED' } },
      include: {
        client: { select: { id: true, name: true } },
        milestones: { orderBy: { sortOrder: 'asc' } },
        allocations: { where: { status: 'POSTED' }, select: { amount: true } },
        invoices: { where: { kind: 'ADDITIONAL', status: { in: ['ISSUED', 'PARTIALLY_PAID'] } } },
      },
    });
    const items: { clientId: string; clientName: string; projectId: string; projectNumber: string; dueDate: Date | null; amount: Decimal; label: string }[] = [];
    for (const p of projects) {
      let received = sum(p.allocations.map((a) => a.amount));
      const schedule = p.milestones.length
        ? p.milestones.map((m) => ({ amount: D(m.amount), due: m.dueDate, label: m.name, id: m.id }))
        : [{ amount: D(p.contractValue), due: p.startDate, label: 'Contract', id: p.id }];
      for (const m of schedule) {
        const covered = Decimal.min(received, m.amount);
        received = received.minus(covered);
        const open = m.amount.minus(covered);
        if (open.gt(0)) items.push({ clientId: p.client.id, clientName: p.client.name, projectId: p.id, projectNumber: p.number, dueDate: m.due, amount: open, label: m.label });
      }
      for (const inv of p.invoices) {
        const open = D(inv.total).minus(D(inv.paidAmount));
        if (open.gt(0)) items.push({ clientId: p.client.id, clientName: p.client.name, projectId: p.id, projectNumber: p.number, dueDate: inv.dueDate, amount: open, label: inv.number });
      }
    }
    return items;
  }

  /** Vendor payables aged per PO due date, oldest POs settled first by vendor payments. */
  private async payableItems() {
    const [pos, payments] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: { status: { in: ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'] } },
        include: { vendor: { select: { id: true, name: true } } },
        orderBy: { orderDate: 'asc' },
      }),
      this.prisma.vendorPayment.groupBy({ by: ['vendorId'], where: { status: 'POSTED' }, _sum: { amount: true } }),
    ]);
    const paidBy = new Map(payments.map((p) => [p.vendorId, D(p._sum.amount)]));
    const items: { vendorId: string; vendorName: string; poId: string; number: string; dueDate: Date; amount: Decimal }[] = [];
    for (const po of pos) {
      let paid = paidBy.get(po.vendorId) ?? D(0);
      const covered = Decimal.min(paid, D(po.total));
      paid = paid.minus(covered);
      paidBy.set(po.vendorId, paid);
      const open = D(po.total).minus(covered);
      if (open.gt(0)) items.push({ vendorId: po.vendor.id, vendorName: po.vendor.name, poId: po.id, number: po.number, dueDate: po.dueDate ?? po.orderDate, amount: open });
    }
    return items;
  }

  private async currentRevisionTotals(where: { createdAt?: { gte?: Date; lte?: Date } } = {}) {
    const rows = await this.prisma.quotation.findMany({
      where: { status: { notIn: ['CANCELLED'] }, ...where },
      select: { id: true, createdAt: true, status: true, currentRevisionNo: true, revisions: { select: { revisionNo: true, grandTotal: true } } },
    });
    return rows.map((r) => ({ ...r, total: D(r.revisions.find((x) => x.revisionNo === r.currentRevisionNo)?.grandTotal) }));
  }

  // ─────────── dashboards ───────────

  async dashboard(user: AuthUser, range: { dateFrom?: string; dateTo?: string }) {
    const period = dateRangeWhere(range);
    const [projects, quotations, payments, receivables, payables, activeProjects, activity, recItems, payItems] = await Promise.all([
      this.prisma.project.findMany({
        where: { status: { not: 'CANCELLED' }, startDate: period },
        include: { items: true, quotation: { include: { revisions: { select: { revisionNo: true, taxTotal: true } } } } },
      }),
      this.currentRevisionTotals(period ? { createdAt: period } : {}),
      this.prisma.payment.aggregate({ where: { status: 'POSTED', paidOn: period }, _sum: { amount: true } }),
      arBalance(this.prisma, {}),
      apBalance(this.prisma),
      this.prisma.project.count({ where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
      this.prisma.auditLog.findMany({ where: { action: { in: ACTIVITY_ACTIONS } }, orderBy: { createdAt: 'desc' }, take: 15 }),
      this.receivableItems(),
      this.payableItems(),
    ]);

    const expenses = await this.prisma.expense.aggregate({
      where: { status: 'POSTED', projectId: { in: projects.map((p) => p.id) } },
      _sum: { amount: true },
    });
    const revenue = sum(
      projects.map((p) => D(p.contractValue).minus(D(p.quotation.revisions.find((r) => r.revisionNo === p.revisionNo)?.taxTotal))),
    );
    const productCost = sum(projects.flatMap((p) => p.items.map((i) => D(i.requiredQty).times(D(i.unitCost)))));
    const grossProfit = revenue.minus(productCost).minus(D(expenses._sum.amount));

    // 12-month sales overview
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1));
    const [q12, p12, pay12] = await Promise.all([
      this.currentRevisionTotals({ createdAt: { gte: since } }),
      this.prisma.project.findMany({ where: { status: { not: 'CANCELLED' }, startDate: { gte: since } }, select: { startDate: true, contractValue: true } }),
      this.prisma.payment.findMany({ where: { status: 'POSTED', paidOn: { gte: since } }, select: { paidOn: true, amount: true } }),
    ]);
    const months = Array.from({ length: 12 }, (_, i) => monthKey(new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + i, 1))));
    const salesOverview = months.map((m) => ({
      month: m,
      quotationValue: money(sum(q12.filter((q) => monthKey(q.createdAt) === m).map((q) => q.total))),
      approvedValue: money(sum(p12.filter((p) => p.startDate && monthKey(p.startDate) === m).map((p) => p.contractValue))),
      collected: money(sum(pay12.filter((p) => monthKey(p.paidOn) === m).map((p) => p.amount))),
    }));

    const t = today();
    const monthEnd = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
    const overdue = sum(recItems.filter((i) => i.dueDate && i.dueDate < t).map((i) => i.amount));
    const dueThisMonth = sum(recItems.filter((i) => i.dueDate && i.dueDate >= t && i.dueDate <= monthEnd).map((i) => i.amount));
    const payOverdue = sum(payItems.filter((i) => i.dueDate < t).map((i) => i.amount));

    return {
      kpis: {
        totalSales: money(sum(projects.map((p) => p.contractValue))),
        quotationValue: money(sum(quotations.map((q) => q.total))),
        approvedProjects: projects.length,
        amountReceived: money(payments._sum.amount),
        receivables: money(receivables),
        payables: money(payables),
        grossProfit: hasPermission(user.permissions, PERMISSIONS.PRODUCT_COST_VIEW) ? money(grossProfit) : null,
        activeProjects,
      },
      salesOverview,
      receivables: { total: money(receivables), overdue: money(overdue), dueThisMonth: money(dueThisMonth) },
      payables: { total: money(payables), overdue: money(payOverdue) },
      recentActivity: activity.map((a) => ({ id: a.id, action: a.action, summary: a.summary, actorName: a.actorName, entityType: a.entityType, entityId: a.entityId, createdAt: a.createdAt.toISOString() })),
    };
  }

  async accountsDashboard() {
    const t = today();
    const monthStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 23, 59, 59));
    const in30 = new Date(t.getTime() + 30 * 86400_000);
    const monthRange = { entry: { entryDate: { gte: monthStart, lte: monthEnd } } };

    const [cash, bank, ar, ap, collections, purchases, expenses, incomeAccts, expenseAccts, recItems, payItems, arByClient] = await Promise.all([
      accountBalance(this.prisma, ACCOUNTS.CASH),
      accountBalance(this.prisma, ACCOUNTS.BANK),
      arBalance(this.prisma, {}),
      apBalance(this.prisma),
      this.prisma.payment.aggregate({ where: { status: 'POSTED', paidOn: { gte: monthStart, lte: monthEnd } }, _sum: { amount: true } }),
      this.prisma.purchaseOrder.aggregate({ where: { status: { not: 'CANCELLED' }, confirmedAt: { gte: monthStart, lte: monthEnd } }, _sum: { total: true } }),
      this.prisma.expense.aggregate({ where: { status: 'POSTED', expenseDate: { gte: monthStart, lte: monthEnd } }, _sum: { amount: true } }),
      this.prisma.journalLine.aggregate({ where: { account: { type: 'INCOME' }, ...monthRange }, _sum: { debit: true, credit: true } }),
      this.prisma.journalLine.aggregate({ where: { account: { type: 'EXPENSE' }, ...monthRange }, _sum: { debit: true, credit: true } }),
      this.receivableItems(),
      this.payableItems(),
      arBalancesBy(this.prisma, 'clientId'),
    ]);

    const overdueBy = new Map<string, { name: string; overdue: Decimal }>();
    for (const i of recItems.filter((x) => x.dueDate && x.dueDate < t)) {
      const e = overdueBy.get(i.clientId) ?? { name: i.clientName, overdue: D(0) };
      e.overdue = e.overdue.plus(i.amount);
      overdueBy.set(i.clientId, e);
    }
    const income = D(incomeAccts._sum.credit).minus(D(incomeAccts._sum.debit));
    const expense = D(expenseAccts._sum.debit).minus(D(expenseAccts._sum.credit));

    const upcomingMilestones = await this.prisma.paymentMilestone.findMany({
      where: { status: { not: 'RECEIVED' }, dueDate: { gte: t, lte: in30 }, project: { status: { not: 'CANCELLED' } } },
      include: { project: { select: { id: true, number: true, client: { select: { name: true } } } } },
      orderBy: { dueDate: 'asc' },
      take: 20,
    });

    return {
      cash: money(cash),
      bank: money(bank),
      receivables: money(ar),
      payables: money(ap),
      netPosition: money(cash.plus(bank).plus(ar).minus(ap)),
      month: monthKey(t),
      monthlyCollections: money(collections._sum.amount),
      monthlyPurchases: money(purchases._sum.total),
      monthlyExpenses: money(expenses._sum.amount),
      profitEstimate: money(income.minus(expense)),
      topOverdueClients: [...overdueBy.entries()]
        .sort((a, b) => b[1].overdue.cmp(a[1].overdue))
        .slice(0, 10)
        .map(([clientId, v]) => ({ clientId, name: v.name, overdue: money(v.overdue), outstanding: money(arByClient.get(clientId)) })),
      upcomingVendorPayments: payItems
        .filter((i) => i.dueDate <= in30)
        .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
        .slice(0, 20)
        .map((i) => ({ poId: i.poId, number: i.number, vendorId: i.vendorId, vendorName: i.vendorName, dueDate: i.dueDate.toISOString(), amount: money(i.amount) })),
      upcomingClientPayments: upcomingMilestones.map((m) => ({
        milestoneId: m.id,
        projectId: m.project.id,
        projectNumber: m.project.number,
        clientName: m.project.client.name,
        name: m.name,
        dueDate: m.dueDate!.toISOString(),
        amount: money(m.amount),
      })),
    };
  }

  // ─────────── reports ───────────

  async salesReport(q: SalesReportQueryDto) {
    const period = dateRangeWhere(q);
    const projects = await this.prisma.project.findMany({
      where: { status: { not: 'CANCELLED' }, startDate: period },
      include: { client: { select: { id: true, name: true } }, items: { include: { product: { include: { category: true } } } } },
    });
    const rows = new Map<string, { label: string; count: number; value: Decimal }>();
    const add = (key: string, label: string, value: Decimal) => {
      const r = rows.get(key) ?? { label, count: 0, value: D(0) };
      r.count += 1;
      r.value = r.value.plus(value);
      rows.set(key, r);
    };
    for (const p of projects) {
      if (q.groupBy === 'month') add(monthKey(p.startDate ?? p.createdAt), monthKey(p.startDate ?? p.createdAt), D(p.contractValue));
      else if (q.groupBy === 'client') add(p.client.id, p.client.name, D(p.contractValue));
      else {
        for (const i of p.items) {
          const v = D(i.requiredQty).times(D(i.unitPrice));
          if (q.groupBy === 'product') add(i.productId, `${i.product.sku} ${i.product.name}`, v);
          else add(i.product.categoryId ?? 'none', i.product.category?.name ?? 'Uncategorised', v);
        }
      }
    }
    const quotes = await this.currentRevisionTotals(period ? { createdAt: period } : {});
    const approved = quotes.filter((x) => x.status === 'APPROVED');
    const sorted = [...rows.entries()].sort((a, b) => (q.groupBy === 'month' ? a[0].localeCompare(b[0]) : b[1].value.cmp(a[1].value)));
    return {
      groupBy: q.groupBy,
      rows: sorted.map(([key, r]) => ({ key, label: r.label, count: r.count, value: money(r.value) })),
      total: money(sum(sorted.map(([, r]) => r.value))),
      conversion: {
        quotations: quotes.length,
        approved: approved.length,
        rate: quotes.length ? ((approved.length / quotes.length) * 100).toFixed(2) : '0.00',
        quotedValue: money(sum(quotes.map((x) => x.total))),
        approvedValue: money(sum(approved.map((x) => x.total))),
      },
    };
  }

  async receivablesAging() {
    const t = today();
    const items = await this.receivableItems();
    const byClient = new Map<string, { name: string; b: Buckets }>();
    for (const i of items) {
      const e = byClient.get(i.clientId) ?? { name: i.clientName, b: emptyBuckets() };
      const k = i.dueDate ? bucketFor(daysBetween(t, i.dueDate)) : 'current';
      e.b[k] = e.b[k].plus(i.amount);
      byClient.set(i.clientId, e);
    }
    const totals = emptyBuckets();
    for (const { b } of byClient.values()) for (const k of Object.keys(totals) as (keyof Buckets)[]) totals[k] = totals[k].plus(b[k]);
    return {
      asOf: t.toISOString(),
      rows: [...byClient.entries()].map(([partyId, v]) => ({ partyId, name: v.name, ...presentBuckets(v.b) })).sort((a, b) => D(b.total).cmp(D(a.total))),
      totals: presentBuckets(totals),
    };
  }

  async payablesAging() {
    const t = today();
    const [items, balances] = await Promise.all([this.payableItems(), apBalancesByVendor(this.prisma)]);
    const byVendor = new Map<string, { name: string; b: Buckets }>();
    for (const i of items) {
      const e = byVendor.get(i.vendorId) ?? { name: i.vendorName, b: emptyBuckets() };
      const k = bucketFor(daysBetween(t, i.dueDate));
      e.b[k] = e.b[k].plus(i.amount);
      byVendor.set(i.vendorId, e);
    }
    const totals = emptyBuckets();
    for (const { b } of byVendor.values()) for (const k of Object.keys(totals) as (keyof Buckets)[]) totals[k] = totals[k].plus(b[k]);
    return {
      asOf: t.toISOString(),
      rows: [...byVendor.entries()]
        .filter(([id]) => D(balances.get(id)).gt(0))
        .map(([partyId, v]) => ({ partyId, name: v.name, ...presentBuckets(v.b) }))
        .sort((a, b) => D(b.total).cmp(D(a.total))),
      totals: presentBuckets(totals),
    };
  }

  async profitability(q: ProfitabilityQueryDto) {
    const where = {
      status: q.status === 'ACTIVE' ? { notIn: ['COMPLETED', 'CANCELLED'] as ('COMPLETED' | 'CANCELLED')[] } : q.status === 'COMPLETED' ? ('COMPLETED' as const) : { not: 'CANCELLED' as const },
    };
    const projects = await this.prisma.project.findMany({
      where,
      include: {
        client: { select: { name: true } },
        items: true,
        quotation: { include: { revisions: { select: { revisionNo: true, taxTotal: true } } } },
        allocations: { where: { status: 'POSTED' }, select: { amount: true } },
        expenses: { where: { status: 'POSTED' }, select: { amount: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(q),
    });
    const rows = projects.map((p) => {
      const revenue = D(p.contractValue).minus(D(p.quotation.revisions.find((r) => r.revisionNo === p.revisionNo)?.taxTotal));
      const productCost = sum(p.items.map((i) => D(i.requiredQty).times(D(i.unitCost))));
      const other = sum(p.expenses.map((e) => e.amount));
      const profit = revenue.minus(productCost).minus(other);
      return {
        projectId: p.id,
        number: p.number,
        name: p.name,
        client: p.client.name,
        status: p.status,
        contractValue: money(p.contractValue),
        revenueExTax: money(revenue),
        productCost: money(productCost),
        otherCosts: money(other),
        estimatedProfit: money(profit),
        estimatedMargin: revenue.isZero() ? '0.00' : profit.div(revenue).times(100).toFixed(2),
        received: money(sum(p.allocations.map((a) => a.amount))),
      };
    });
    const tot = (k: 'contractValue' | 'revenueExTax' | 'productCost' | 'otherCosts' | 'estimatedProfit') => sum(rows.map((r) => r[k]));
    return {
      rows,
      totals: {
        contractValue: money(tot('contractValue')),
        revenueExTax: money(tot('revenueExTax')),
        productCost: money(tot('productCost')),
        otherCosts: money(tot('otherCosts')),
        estimatedProfit: money(tot('estimatedProfit')),
        margin: tot('revenueExTax').isZero() ? '0.00' : tot('estimatedProfit').div(tot('revenueExTax')).times(100).toFixed(2),
      },
    };
  }

  async productSales(q: { dateFrom?: string; dateTo?: string }) {
    const items = await this.prisma.projectItem.findMany({
      where: { project: { status: { not: 'CANCELLED' }, startDate: dateRangeWhere(q) } },
      include: { product: { include: { category: true } } },
    });
    const by = new Map<string, { sku: string; name: string; category: string | null; qty: Decimal; revenue: Decimal; cost: Decimal; projects: number }>();
    for (const i of items) {
      const e = by.get(i.productId) ?? { sku: i.product.sku, name: i.product.name, category: i.product.category?.name ?? null, qty: D(0), revenue: D(0), cost: D(0), projects: 0 };
      e.qty = e.qty.plus(D(i.requiredQty));
      e.revenue = e.revenue.plus(D(i.requiredQty).times(D(i.unitPrice)));
      e.cost = e.cost.plus(D(i.requiredQty).times(D(i.unitCost)));
      e.projects += 1;
      by.set(i.productId, e);
    }
    return [...by.entries()]
      .map(([productId, e]) => ({
        productId,
        sku: e.sku,
        name: e.name,
        category: e.category,
        qty: qty(e.qty),
        revenue: money(e.revenue),
        cost: money(e.cost),
        margin: money(e.revenue.minus(e.cost)),
        marginPct: e.revenue.isZero() ? '0.00' : e.revenue.minus(e.cost).div(e.revenue).times(100).toFixed(2),
        projects: e.projects,
      }))
      .sort((a, b) => D(b.qty).cmp(D(a.qty)));
  }

  async paymentsReport(q: { dateFrom?: string; dateTo?: string }) {
    const payments = await this.prisma.payment.findMany({ where: { status: 'POSTED', paidOn: dateRangeWhere(q) }, select: { amount: true, method: true, paidOn: true } });
    const byMethod = new Map<string, { count: number; amount: Decimal }>();
    const byMonth = new Map<string, { count: number; amount: Decimal }>();
    for (const p of payments) {
      for (const [map, key] of [[byMethod, p.method], [byMonth, monthKey(p.paidOn)]] as const) {
        const e = map.get(key) ?? { count: 0, amount: D(0) };
        e.count += 1;
        e.amount = e.amount.plus(D(p.amount));
        map.set(key, e);
      }
    }
    return {
      total: money(sum(payments.map((p) => p.amount))),
      count: payments.length,
      byMethod: [...byMethod.entries()].map(([method, e]) => ({ method, count: e.count, amount: money(e.amount) })),
      byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, e]) => ({ month, count: e.count, amount: money(e.amount) })),
    };
  }

  // ─────────── global search ───────────

  async search(user: AuthUser, q: string) {
    const can = (p: string) => hasPermission(user.permissions, p);
    const ci = { contains: q, mode: 'insensitive' as const };
    const take = 5;
    const [clients, sites, projects, quotations, products, vendors, payments, invoices, pos] = await Promise.all([
      can(PERMISSIONS.CLIENT_VIEW) ? this.prisma.client.findMany({ where: { OR: [{ name: ci }, { code: ci }, { phone: { contains: q } }, { companyName: ci }] }, take }) : [],
      can(PERMISSIONS.SITE_VIEW) ? this.prisma.site.findMany({ where: { OR: [{ name: ci }, { code: ci }, { address: ci }] }, include: { client: { select: { name: true } } }, take }) : [],
      can(PERMISSIONS.PROJECT_VIEW) ? this.prisma.project.findMany({ where: { OR: [{ number: ci }, { name: ci }, { client: { name: ci } }] }, include: { client: { select: { name: true } } }, take }) : [],
      can(PERMISSIONS.QUOTATION_VIEW) ? this.prisma.quotation.findMany({ where: { OR: [{ number: ci }, { client: { name: ci } }, { site: { name: ci } }] }, include: { client: { select: { name: true } } }, take }) : [],
      can(PERMISSIONS.PRODUCT_VIEW) ? this.prisma.product.findMany({ where: { OR: [{ name: ci }, { sku: ci }, { brand: ci }] }, take }) : [],
      can(PERMISSIONS.VENDOR_VIEW) ? this.prisma.vendor.findMany({ where: { OR: [{ name: ci }, { code: ci }] }, take }) : [],
      can(PERMISSIONS.PAYMENT_VIEW) ? this.prisma.payment.findMany({ where: { OR: [{ number: ci }, { reference: ci }, { chequeNo: ci }, { client: { name: ci } }] }, include: { client: { select: { name: true } } }, take }) : [],
      can(PERMISSIONS.INVOICE_VIEW) ? this.prisma.invoice.findMany({ where: { OR: [{ number: ci }, { client: { name: ci } }] }, include: { client: { select: { name: true } } }, take }) : [],
      can(PERMISSIONS.PURCHASE_VIEW) ? this.prisma.purchaseOrder.findMany({ where: { OR: [{ number: ci }, { vendor: { name: ci } }] }, include: { vendor: { select: { name: true } } }, take }) : [],
    ]);
    return [
      ...clients.map((c) => ({ type: 'CLIENT' as const, id: c.id, title: c.name, subtitle: [c.code, c.phone].filter(Boolean).join(' · ') })),
      ...sites.map((s) => ({ type: 'SITE' as const, id: s.id, title: s.name, subtitle: s.client.name })),
      ...projects.map((p) => ({ type: 'PROJECT' as const, id: p.id, title: `${p.number} ${p.name}`, subtitle: p.client.name })),
      ...quotations.map((x) => ({ type: 'QUOTATION' as const, id: x.id, title: x.number, subtitle: `${x.client.name} · ${x.status}` })),
      ...products.map((p) => ({ type: 'PRODUCT' as const, id: p.id, title: p.name, subtitle: `${p.sku} · PKR ${money(p.sellingPrice)}` })),
      ...vendors.map((v) => ({ type: 'VENDOR' as const, id: v.id, title: v.name, subtitle: v.code })),
      ...payments.map((p) => ({ type: 'PAYMENT' as const, id: p.id, title: p.number, subtitle: `${p.client.name} · PKR ${money(p.amount)}` })),
      ...invoices.map((i) => ({ type: 'INVOICE' as const, id: i.id, title: i.number, subtitle: `${i.client.name} · PKR ${money(i.total)}` })),
      ...pos.map((p) => ({ type: 'PURCHASE_ORDER' as const, id: p.id, title: p.number, subtitle: `${p.vendor.name} · PKR ${money(p.total)}` })),
    ];
  }
}
