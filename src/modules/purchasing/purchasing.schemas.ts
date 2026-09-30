import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zDateInput, zDateRange, zMoney, zMoneyInput, zPageQuery, zPercentInput, zQty, zQtyInput } from '../../common/schemas';

export const zPOStatus = z.enum(['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']);

export const zPOItemInput = z.object({
  productId: z.string().uuid(),
  qty: zQtyInput,
  unitCost: zMoneyInput.optional().describe('Defaults to the product cost price'),
  discount: zMoneyInput.optional(),
  taxRate: zPercentInput.optional(),
});

export const zPOInput = z.object({
  vendorId: z.string().uuid(),
  projectId: z.string().uuid().optional().nullable(),
  orderDate: zDateInput.optional(),
  expectedDelivery: zDateInput.optional().nullable(),
  paymentTerms: z.string().max(200).optional().nullable(),
  dueDate: zDateInput.optional().nullable(),
  discount: zMoneyInput.optional(),
  notes: z.string().max(2000).optional().nullable(),
  items: z.array(zPOItemInput).min(1).max(500),
});
export class CreatePurchaseOrderDto extends createDto(zPOInput) {}
export class UpdatePurchaseOrderDto extends createDto(zPOInput) {}

export const zReceiveInput = z.object({
  lines: z.array(z.object({ poItemId: z.string().uuid(), qty: zQtyInput })).min(1),
  notes: z.string().max(1000).optional(),
});
export class ReceivePurchaseOrderDto extends createDto(zReceiveInput) {}

export const zFromShortage = z.object({
  projectId: z.string().uuid(),
  vendorId: z.string().uuid().optional().describe('Use this vendor for all lines; otherwise each product’s default supplier'),
  productIds: z.array(z.string().uuid()).optional().describe('Limit to these products'),
});
export class FromShortageDto extends createDto(zFromShortage) {}

export const zPOQuery = zPageQuery.merge(zDateRange).extend({
  vendorId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  status: zPOStatus.optional(),
});
export class PurchaseOrderQueryDto extends createDto(zPOQuery) {}

export const zPurchaseOrder = z.object({
  id: z.string(),
  number: z.string(),
  status: zPOStatus,
  orderDate: z.string(),
  expectedDelivery: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  dueDate: z.string().nullable(),
  subtotal: zMoney,
  discount: zMoney,
  tax: zMoney,
  total: zMoney,
  notes: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  vendor: z.object({ id: z.string(), name: z.string(), code: z.string() }),
  project: z.object({ id: z.string(), number: z.string(), name: z.string() }).nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      productId: z.string(),
      sku: z.string(),
      name: z.string(),
      unit: z.string(),
      qty: zQty,
      receivedQty: zQty,
      pendingQty: zQty,
      unitCost: zMoney,
      discount: zMoney,
      taxRate: z.string(),
      lineTotal: zMoney,
    }),
  ),
  receipts: z.array(z.object({ id: z.string(), number: z.string(), receivedAt: z.string(), notes: z.string().nullable() })),
  createdAt: z.string(),
});
export class PurchaseOrderDto extends createDto(zPurchaseOrder) {}
export class PurchaseOrderPageDto extends createDto(paginated(zPurchaseOrder.omit({ items: true, receipts: true }))) {}
export class PurchaseOrderListDto extends createDto(z.array(zPurchaseOrder)) {}

// ── Inventory ──

export const zInventoryQuery = zPageQuery.extend({
  categoryId: z.string().uuid().optional(),
  lowStock: z.enum(['true', 'false']).optional(),
});
export class InventoryQueryDto extends createDto(zInventoryQuery) {}

export const zStockRow = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  unit: z.string(),
  onHand: zQty,
  reserved: zQty,
  available: zQty,
  incoming: zQty,
  reorderLevel: zQty,
  lowStock: z.boolean(),
  stockValue: zMoney.nullable(),
});
export class StockPageDto extends createDto(paginated(zStockRow)) {}

export const zInventoryTxn = z.object({
  id: z.string(),
  type: z.enum(['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'RESERVE', 'RELEASE']),
  qty: zQty,
  unitCost: zMoney.nullable(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  notes: z.string().nullable(),
  project: z.object({ id: z.string(), number: z.string() }).nullable(),
  createdAt: z.string(),
});
export class InventoryTxnPageDto extends createDto(paginated(zInventoryTxn)) {}

export const zAdjustStock = z.object({
  productId: z.string().uuid(),
  qty: z.union([z.number(), z.string().regex(/^-?\d+(\.\d{1,3})?$/)]).describe('Positive to add, negative to remove'),
  reason: z.string().trim().min(3).max(500),
});
export class AdjustStockDto extends createDto(zAdjustStock) {}
