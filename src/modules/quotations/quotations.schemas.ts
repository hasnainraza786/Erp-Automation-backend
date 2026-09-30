import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zDateInput, zDateRange, zMoney, zMoneyInput, zPageQuery, zPercentInput, zQty, zQtyInput } from '../../common/schemas';

export const zQuotationType = z.enum(['PRODUCT', 'SITE_DIVISION']);
export const zQuotationStatus = z.enum(['DRAFT', 'SENT', 'UNDER_DISCUSSION', 'REVISED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']);
export const zDiscountType = z.enum(['PERCENT', 'FIXED']);
export const zChargeKind = z.enum(['INSTALLATION', 'PROGRAMMING', 'ENGINEERING', 'TRANSPORTATION', 'OTHER']);

export const zItemInput = z.object({
  productId: z.string().uuid(),
  qty: zQtyInput,
  unitPrice: zMoneyInput.optional().nullable().describe('Omit to use the product selling price'),
  discountType: zDiscountType.optional().nullable(),
  discountValue: zMoneyInput.optional().nullable(),
  taxRate: zPercentInput.optional().nullable(),
  description: z.string().max(500).optional().nullable(),
});

export const zTerms = z.object({
  paymentTerms: z.string().max(2000).optional(),
  validity: z.string().max(2000).optional(),
  warranty: z.string().max(2000).optional(),
  installation: z.string().max(2000).optional(),
  availability: z.string().max(2000).optional(),
  delivery: z.string().max(2000).optional(),
  exclusions: z.string().max(2000).optional(),
  taxes: z.string().max(2000).optional(),
  cancellation: z.string().max(2000).optional(),
});

export const zQuotationContent = z.object({
  type: zQuotationType,
  items: z.array(zItemInput).max(2000).optional(),
  spaces: z.array(z.object({ name: z.string().trim().min(1).max(100), items: z.array(zItemInput).max(1000) })).max(200).optional(),
  overallDiscountType: zDiscountType.optional().nullable(),
  overallDiscountValue: zMoneyInput.optional().nullable(),
  charges: z.array(z.object({ kind: zChargeKind, label: z.string().max(100).optional().nullable(), amount: zMoneyInput })).max(20).optional(),
  paymentSchedule: z.array(z.object({ name: z.string().trim().min(1).max(100), percent: zPercentInput })).max(12).optional(),
});
export class CalculateQuotationDto extends createDto(zQuotationContent) {}

const zRevisionFields = z.object({
  quotationDate: zDateInput.optional(),
  validUntil: zDateInput.optional().nullable(),
  terms: zTerms.optional(),
  notes: z.string().max(4000).optional().nullable(),
});

export const zCreateQuotation = zQuotationContent.merge(zRevisionFields).extend({
  clientId: z.string().uuid(),
  siteId: z.string().uuid(),
  templateId: z.string().uuid().optional().describe('Prefill items/spaces from a template (ignored if items or spaces are provided)'),
});
export class CreateQuotationDto extends createDto(zCreateQuotation) {}

export const zUpdateQuotation = zQuotationContent.merge(zRevisionFields).extend({
  version: z.number().int().describe('Optimistic lock: the version you loaded'),
});
export class UpdateQuotationDto extends createDto(zUpdateQuotation) {}

export const zReviseQuotation = zUpdateQuotation.extend({ changeNote: z.string().trim().min(3).max(1000) });
export class ReviseQuotationDto extends createDto(zReviseQuotation) {}

export const zQuotationStatusChange = z.object({
  status: z.enum(['UNDER_DISCUSSION', 'REJECTED', 'EXPIRED', 'CANCELLED']),
  note: z.string().max(1000).optional(),
});
export class ChangeQuotationStatusDto extends createDto(zQuotationStatusChange) {}

export const zApproveQuotation = z.object({
  method: z.enum(['MANUAL', 'SIGNED_UPLOAD', 'ONLINE']).default('MANUAL'),
  approvedBy: z.string().trim().min(2).max(200).describe('Name of the client representative who approved'),
  approvalDate: zDateInput.optional(),
  projectName: z.string().trim().max(200).optional(),
  notes: z.string().max(2000).optional(),
});
export class ApproveQuotationDto extends createDto(zApproveQuotation) {}

export const zDuplicateQuotation = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
});
export class DuplicateQuotationDto extends createDto(zDuplicateQuotation) {}

export const zQuotationQuery = zPageQuery.merge(zDateRange).extend({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  status: zQuotationStatus.optional(),
  type: zQuotationType.optional(),
});
export class QuotationQueryDto extends createDto(zQuotationQuery) {}

// ── Responses ──

export const zCalcLine = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  description: z.string().nullable(),
  qty: zQty,
  unitPrice: zMoney,
  unitCost: zMoney.nullable(),
  gross: zMoney,
  discountType: zDiscountType.nullable(),
  discountValue: zMoney,
  discountAmount: zMoney,
  net: zMoney,
  taxRate: z.string(),
  taxAmount: zMoney,
  lineTotal: zMoney,
  priceOverridden: z.boolean(),
  belowMinimum: z.boolean(),
});

export const zCalculation = z.object({
  spaces: z.array(z.object({ name: z.string(), subtotal: zMoney, itemCount: z.number(), items: z.array(zCalcLine) })),
  items: z.array(zCalcLine).describe('Product-based lines (empty for site-division)'),
  summary: z.array(z.object({ productId: z.string(), sku: z.string(), name: z.string(), unit: z.string(), qty: zQty, unitPrice: zMoney, total: zMoney })),
  subtotal: zMoney,
  itemDiscountTotal: zMoney,
  overallDiscount: zMoney,
  taxTotal: zMoney,
  charges: z.array(z.object({ kind: zChargeKind, label: z.string(), amount: zMoney })),
  chargesTotal: zMoney,
  grandTotal: zMoney,
  costTotal: zMoney.nullable(),
  estimatedProfit: zMoney.nullable(),
  milestones: z.array(z.object({ name: z.string(), percent: z.string(), amount: zMoney })),
  warnings: z.array(z.string()),
});
export class CalculationDto extends createDto(zCalculation) {}

const zRef = z.object({ id: z.string(), name: z.string(), code: z.string() });

export const zRevisionSummary = z.object({
  id: z.string(),
  revisionNo: z.number(),
  grandTotal: zMoney,
  changeNote: z.string().nullable(),
  lockedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const zQuotationListItem = z.object({
  id: z.string(),
  number: z.string(),
  displayNumber: z.string().describe('e.g. QT-2026-0012 Rev 2'),
  type: zQuotationType,
  status: zQuotationStatus,
  currentRevisionNo: z.number(),
  grandTotal: zMoney,
  quotationDate: z.string(),
  validUntil: z.string().nullable(),
  client: zRef,
  site: zRef,
  projectId: z.string().nullable(),
  createdAt: z.string(),
});
export class QuotationPageDto extends createDto(paginated(zQuotationListItem)) {}

export const zQuotationDetail = zQuotationListItem.extend({
  version: z.number(),
  editable: z.boolean(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvalMethod: z.string().nullable(),
  duplicatedFromId: z.string().nullable(),
  revision: z.object({
    id: z.string(),
    revisionNo: z.number(),
    quotationDate: z.string(),
    validUntil: z.string().nullable(),
    overallDiscountType: zDiscountType.nullable(),
    overallDiscountValue: zMoney,
    terms: zTerms,
    notes: z.string().nullable(),
    paymentSchedule: z.array(z.object({ name: z.string(), percent: z.number() })),
    lockedAt: z.string().nullable(),
    changeNote: z.string().nullable(),
  }),
  calculation: zCalculation,
  revisions: z.array(zRevisionSummary),
});
export class QuotationDetailDto extends createDto(zQuotationDetail) {}

export const zApproveResult = z.object({
  quotationId: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
});
export class ApproveResultDto extends createDto(zApproveResult) {}

export const zTemplateInput = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500).optional().nullable(),
  type: zQuotationType,
  items: z.array(z.object({ spaceName: z.string().max(100).optional().nullable(), productId: z.string().uuid(), qty: zQtyInput })).min(1),
});
export class CreateTemplateDto extends createDto(zTemplateInput) {}

export const zTemplateFromQuotation = z.object({ name: z.string().trim().min(2).max(100), description: z.string().max(500).optional() });
export class TemplateFromQuotationDto extends createDto(zTemplateFromQuotation) {}

export const zTemplate = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: zQuotationType,
  isActive: z.boolean(),
  items: z.array(z.object({ spaceName: z.string().nullable(), productId: z.string(), productName: z.string(), sku: z.string(), qty: zQty })),
});
export class TemplateDto extends createDto(zTemplate) {}
export class TemplateListDto extends createDto(z.array(zTemplate)) {}

export const zCompareRevisions = z.object({
  from: z.number(),
  to: z.number(),
  previousTotal: zMoney,
  newTotal: zMoney,
  difference: zMoney,
  changes: z.array(
    z.object({
      space: z.string().nullable(),
      productName: z.string(),
      change: z.enum(['ADDED', 'REMOVED', 'CHANGED']),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
});
export class CompareRevisionsDto extends createDto(zCompareRevisions) {}
