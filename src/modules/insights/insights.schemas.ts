import { z } from 'zod';
import { createDto } from '../../common/dto';
import { zDateRange, zMoney, zPageQuery, zQty } from '../../common/schemas';

export class DateRangeQueryDto extends createDto(zDateRange) {}

const zSeriesPoint = z.object({ month: z.string(), quotationValue: zMoney, approvedValue: zMoney, collected: zMoney });

export const zDashboard = z.object({
  kpis: z.object({
    totalSales: zMoney,
    quotationValue: zMoney,
    approvedProjects: z.number(),
    amountReceived: zMoney,
    receivables: zMoney,
    payables: zMoney,
    grossProfit: zMoney.nullable(),
    activeProjects: z.number(),
  }),
  salesOverview: z.array(zSeriesPoint),
  receivables: z.object({ total: zMoney, overdue: zMoney, dueThisMonth: zMoney }),
  payables: z.object({ total: zMoney, overdue: zMoney }),
  recentActivity: z.array(z.object({ id: z.string(), action: z.string(), summary: z.string().nullable(), actorName: z.string().nullable(), entityType: z.string(), entityId: z.string().nullable(), createdAt: z.string() })),
});
export class DashboardDto extends createDto(zDashboard) {}

export const zAccountsDashboard = z.object({
  cash: zMoney,
  bank: zMoney,
  receivables: zMoney,
  payables: zMoney,
  netPosition: zMoney,
  month: z.string(),
  monthlyCollections: zMoney,
  monthlyPurchases: zMoney,
  monthlyExpenses: zMoney,
  profitEstimate: zMoney,
  topOverdueClients: z.array(z.object({ clientId: z.string(), name: z.string(), overdue: zMoney, outstanding: zMoney })),
  upcomingVendorPayments: z.array(z.object({ poId: z.string(), number: z.string(), vendorId: z.string(), vendorName: z.string(), dueDate: z.string(), amount: zMoney })),
  upcomingClientPayments: z.array(z.object({ milestoneId: z.string(), projectId: z.string(), projectNumber: z.string(), clientName: z.string(), name: z.string(), dueDate: z.string(), amount: zMoney })),
});
export class AccountsDashboardDto extends createDto(zAccountsDashboard) {}

export const zSalesReportQuery = zDateRange.extend({ groupBy: z.enum(['month', 'client', 'product', 'category']).default('month') });
export class SalesReportQueryDto extends createDto(zSalesReportQuery) {}

export const zSalesReport = z.object({
  groupBy: z.string(),
  rows: z.array(z.object({ key: z.string(), label: z.string(), count: z.number(), value: zMoney })),
  total: zMoney,
  conversion: z.object({ quotations: z.number(), approved: z.number(), rate: z.string(), quotedValue: zMoney, approvedValue: zMoney }),
});
export class SalesReportDto extends createDto(zSalesReport) {}

const zBuckets = z.object({ current: zMoney, d0_30: zMoney, d31_60: zMoney, d61_90: zMoney, d90plus: zMoney, total: zMoney });

export const zAgingReport = z.object({
  asOf: z.string(),
  rows: z.array(zBuckets.extend({ partyId: z.string(), name: z.string() })),
  totals: zBuckets,
});
export class AgingReportDto extends createDto(zAgingReport) {}

export const zProfitabilityQuery = zPageQuery.extend({ status: z.enum(['ACTIVE', 'COMPLETED', 'ALL']).default('ALL') });
export class ProfitabilityQueryDto extends createDto(zProfitabilityQuery) {}

export const zProfitabilityReport = z.object({
  rows: z.array(
    z.object({
      projectId: z.string(),
      number: z.string(),
      name: z.string(),
      client: z.string(),
      status: z.string(),
      contractValue: zMoney,
      revenueExTax: zMoney,
      productCost: zMoney,
      otherCosts: zMoney,
      estimatedProfit: zMoney,
      estimatedMargin: z.string(),
      received: zMoney,
    }),
  ),
  totals: z.object({ contractValue: zMoney, revenueExTax: zMoney, productCost: zMoney, otherCosts: zMoney, estimatedProfit: zMoney, margin: z.string() }),
});
export class ProfitabilityReportDto extends createDto(zProfitabilityReport) {}

export const zProductSalesReport = z.array(
  z.object({ productId: z.string(), sku: z.string(), name: z.string(), category: z.string().nullable(), qty: zQty, revenue: zMoney, cost: zMoney, margin: zMoney, marginPct: z.string(), projects: z.number() }),
);
export class ProductSalesReportDto extends createDto(zProductSalesReport) {}

export const zPaymentsReport = z.object({
  total: zMoney,
  count: z.number(),
  byMethod: z.array(z.object({ method: z.string(), count: z.number(), amount: zMoney })),
  byMonth: z.array(z.object({ month: z.string(), count: z.number(), amount: zMoney })),
});
export class PaymentsReportDto extends createDto(zPaymentsReport) {}

export const zSearchQuery = z.object({ q: z.string().trim().min(2).max(100) });
export class SearchQueryDto extends createDto(zSearchQuery) {}

export const zSearchResult = z.array(
  z.object({
    type: z.enum(['CLIENT', 'SITE', 'PROJECT', 'QUOTATION', 'PRODUCT', 'VENDOR', 'PAYMENT', 'INVOICE', 'PURCHASE_ORDER']),
    id: z.string(),
    title: z.string(),
    subtitle: z.string().nullable(),
  }),
);
export class SearchResultDto extends createDto(zSearchResult) {}
