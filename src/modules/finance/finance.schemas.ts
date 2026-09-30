import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zDateInput, zDateRange, zMoney, zMoneyInput, zPageQuery, zPercentInput, zQty, zQtyInput } from '../../common/schemas';
import { zPaymentMethod, zTxnStatus } from '../vendors/vendors.schemas';

const zRef = z.object({ id: z.string(), name: z.string(), code: z.string() });

// ─────────── Invoices ───────────

export const zInvoiceStatus = z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']);
export const zInvoiceKind = z.enum(['MILESTONE', 'BALANCE', 'ADDITIONAL']);

export const zCreateInvoice = z.object({
  projectId: z.string().uuid(),
  kind: zInvoiceKind,
  milestoneId: z.string().uuid().optional().describe('Required when kind = MILESTONE'),
  invoiceDate: zDateInput.optional(),
  dueDate: zDateInput.optional().nullable(),
  items: z
    .array(z.object({ description: z.string().trim().min(2).max(300), qty: zQtyInput.default(1), unitPrice: zMoneyInput, productId: z.string().uuid().optional() }))
    .max(200)
    .optional()
    .describe('Required when kind = ADDITIONAL'),
  discount: zMoneyInput.optional(),
  taxRate: zPercentInput.optional().describe('Tax % applied to ADDITIONAL invoices'),
  notes: z.string().max(2000).optional().nullable(),
  issue: z.boolean().default(false).describe('Issue immediately instead of saving as draft'),
});
export class CreateInvoiceDto extends createDto(zCreateInvoice) {}

export const zInvoiceQuery = zPageQuery.merge(zDateRange).extend({
  clientId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  status: zInvoiceStatus.optional(),
});
export class InvoiceQueryDto extends createDto(zInvoiceQuery) {}

export const zInvoice = z.object({
  id: z.string(),
  number: z.string(),
  kind: zInvoiceKind,
  status: zInvoiceStatus,
  invoiceDate: z.string(),
  dueDate: z.string().nullable(),
  subtotal: zMoney,
  discount: zMoney,
  tax: zMoney,
  total: zMoney,
  paidAmount: zMoney,
  balance: zMoney,
  notes: z.string().nullable(),
  client: zRef,
  project: z.object({ id: z.string(), number: z.string(), name: z.string() }),
  site: zRef,
  milestone: z.object({ id: z.string(), name: z.string() }).nullable(),
  items: z.array(z.object({ id: z.string(), description: z.string(), qty: zQty, unitPrice: zMoney, lineTotal: zMoney })),
  createdAt: z.string(),
});
export class InvoiceDto extends createDto(zInvoice) {}
export class InvoicePageDto extends createDto(paginated(zInvoice.omit({ items: true }))) {}

// ─────────── Payments ───────────

export const zAllocationInput = z.object({
  projectId: z.string().uuid(),
  invoiceId: z.string().uuid().optional().nullable(),
  amount: zMoneyInput,
});

export const zCreatePayment = z.object({
  clientId: z.string().uuid(),
  siteId: z.string().uuid().optional().nullable(),
  paidOn: zDateInput,
  amount: zMoneyInput,
  method: zPaymentMethod,
  reference: z.string().max(200).optional().nullable(),
  bank: z.string().max(100).optional().nullable(),
  chequeNo: z.string().max(50).optional().nullable(),
  transactionId: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  allocations: z.array(zAllocationInput).max(50).default([]).describe('Leave empty to keep the payment unallocated'),
});
export class CreatePaymentDto extends createDto(zCreatePayment) {}

export const zAllocatePayment = z.object({ allocations: z.array(zAllocationInput).min(1).max(50) });
export class AllocatePaymentDto extends createDto(zAllocatePayment) {}

export const zPaymentQuery = zPageQuery.merge(zDateRange).extend({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  method: zPaymentMethod.optional(),
  status: zTxnStatus.optional(),
  unallocated: z.enum(['true', 'false']).optional(),
  amountMin: z.coerce.number().optional(),
  amountMax: z.coerce.number().optional(),
});
export class PaymentQueryDto extends createDto(zPaymentQuery) {}

export const zPayment = z.object({
  id: z.string(),
  number: z.string(),
  paidOn: z.string(),
  amount: zMoney,
  allocated: zMoney,
  unallocated: zMoney,
  method: zPaymentMethod,
  reference: z.string().nullable(),
  bank: z.string().nullable(),
  chequeNo: z.string().nullable(),
  transactionId: z.string().nullable(),
  notes: z.string().nullable(),
  status: zTxnStatus,
  voidReason: z.string().nullable(),
  client: zRef,
  site: zRef.nullable(),
  allocations: z.array(
    z.object({
      id: z.string(),
      amount: zMoney,
      status: zTxnStatus,
      project: z.object({ id: z.string(), number: z.string(), name: z.string() }),
      site: zRef,
      invoice: z.object({ id: z.string(), number: z.string() }).nullable(),
    }),
  ),
  createdAt: z.string(),
});
export class PaymentDto extends createDto(zPayment) {}
export class PaymentPageDto extends createDto(paginated(zPayment)) {}

export const zOpenItems = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      site: zRef,
      contractValue: zMoney,
      received: zMoney,
      balance: zMoney,
      invoices: z.array(z.object({ id: z.string(), number: z.string(), total: zMoney, balance: zMoney, dueDate: z.string().nullable() })),
    }),
  ),
  unallocatedPayments: z.array(z.object({ id: z.string(), number: z.string(), paidOn: z.string(), unallocated: zMoney })),
});
export class OpenItemsDto extends createDto(zOpenItems) {}

// ─────────── Ledgers ───────────

export const zLedgerQuery = zDateRange.extend({
  siteId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});
export class LedgerQueryDto extends createDto(zLedgerQuery) {}

export const zLedgerEntry = z.object({
  entryId: z.string(),
  date: z.string(),
  reference: z.string().nullable(),
  entryNumber: z.string(),
  description: z.string(),
  sourceType: z.string(),
  sourceId: z.string().nullable(),
  site: z.string().nullable(),
  project: z.string().nullable(),
  debit: zMoney,
  credit: zMoney,
  balance: zMoney,
});

export const zLedger = z.object({
  party: z.object({ id: z.string(), name: z.string(), code: z.string() }),
  period: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  openingBalance: zMoney,
  totalDebit: zMoney,
  totalCredit: zMoney,
  closingBalance: zMoney,
  entries: z.array(zLedgerEntry),
});
export class LedgerDto extends createDto(zLedger) {}

// ─────────── Expenses ───────────

export const zExpenseCategory = z.enum(['TRANSPORT', 'INSTALLATION_LABOR', 'PROGRAMMING', 'SALARIES', 'OFFICE', 'OTHER']);

export const zCreateExpense = z.object({
  expenseDate: zDateInput,
  category: zExpenseCategory,
  amount: zMoneyInput,
  method: zPaymentMethod,
  description: z.string().max(500).optional().nullable(),
  vendorId: z.string().uuid().optional().nullable(),
  payee: z.string().max(200).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});
export class CreateExpenseDto extends createDto(zCreateExpense) {}

export const zExpenseQuery = zPageQuery.merge(zDateRange).extend({
  category: zExpenseCategory.optional(),
  projectId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  status: zTxnStatus.optional(),
});
export class ExpenseQueryDto extends createDto(zExpenseQuery) {}

export const zExpense = z.object({
  id: z.string(),
  number: z.string(),
  expenseDate: z.string(),
  category: zExpenseCategory,
  amount: zMoney,
  method: zPaymentMethod,
  description: z.string().nullable(),
  payee: z.string().nullable(),
  notes: z.string().nullable(),
  status: zTxnStatus,
  voidReason: z.string().nullable(),
  vendor: z.object({ id: z.string(), name: z.string() }).nullable(),
  project: z.object({ id: z.string(), number: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
});
export class ExpenseDto extends createDto(zExpense) {}
export class ExpensePageDto extends createDto(paginated(zExpense)) {}
