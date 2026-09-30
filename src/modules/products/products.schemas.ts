import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zMoney, zMoneyInput, zPageQuery, zPercentInput, zQty, zQtyInput } from '../../common/schemas';

export const zUnit = z.enum(['PIECE', 'SET', 'METER', 'FEET', 'BOX', 'PAIR', 'HOUR', 'LOT', 'OTHER']);

export const zProductInput = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(200),
  brand: z.string().trim().max(100).optional().nullable(),
  model: z.string().trim().max(100).optional().nullable(),
  categoryId: z.string().uuid().optional().nullable(),
  subcategoryId: z.string().uuid().optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  unit: zUnit.default('PIECE'),
  costPrice: zMoneyInput.default(0),
  sellingPrice: zMoneyInput.default(0),
  minPrice: zMoneyInput.optional().nullable(),
  specialPrice: zMoneyInput.optional().nullable(),
  taxRate: zPercentInput.default(0),
  supplierId: z.string().uuid().optional().nullable(),
  warranty: z.string().max(200).optional().nullable(),
  reorderLevel: zQtyInput.default(0),
  isActive: z.boolean().default(true),
});
export class CreateProductDto extends createDto(zProductInput) {}
export class UpdateProductDto extends createDto(zProductInput.partial()) {}

export const zProductQuery = zPageQuery.extend({
  categoryId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  active: z.enum(['true', 'false']).optional(),
  lowStock: z.enum(['true', 'false']).optional(),
});
export class ProductQueryDto extends createDto(zProductQuery) {}

export const zProductSearchQuery = z.object({
  q: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(15),
});
export class ProductSearchQueryDto extends createDto(zProductSearchQuery) {}

const zRef = z.object({ id: z.string(), name: z.string() }).nullable();

export const zProduct = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  categoryId: z.string().nullable(),
  subcategoryId: z.string().nullable(),
  description: z.string().nullable(),
  unit: zUnit,
  costPrice: zMoney.nullable().describe('Null when the user lacks product:cost_view'),
  sellingPrice: zMoney,
  minPrice: zMoney.nullable(),
  specialPrice: zMoney.nullable(),
  taxRate: z.string(),
  supplierId: z.string().nullable(),
  warranty: z.string().nullable(),
  imageKey: z.string().nullable(),
  datasheetKey: z.string().nullable(),
  reorderLevel: zQty,
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  category: zRef,
  subcategory: zRef,
  supplier: zRef,
  stock: z.object({ onHand: zQty, reserved: zQty, incoming: zQty, available: zQty }),
});
export class ProductDto extends createDto(zProduct) {}
export class ProductPageDto extends createDto(paginated(zProduct)) {}

export const zProductSearchItem = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  unit: zUnit,
  sellingPrice: zMoney,
  minPrice: zMoney.nullable(),
  taxRate: z.string(),
  available: zQty,
});
export class ProductSearchResultDto extends createDto(z.array(zProductSearchItem)) {}

export const zPriceHistory = z.array(
  z.object({
    id: z.string(),
    field: z.string(),
    oldValue: zMoney.nullable(),
    newValue: zMoney.nullable(),
    changedByName: z.string().nullable(),
    createdAt: z.string(),
  }),
);
export class PriceHistoryDto extends createDto(zPriceHistory) {}

export const zCategoryInput = z.object({
  name: z.string().trim().min(2).max(100),
  parentId: z.string().uuid().optional().nullable(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});
export class CreateCategoryDto extends createDto(zCategoryInput) {}
export class UpdateCategoryDto extends createDto(zCategoryInput.partial()) {}

export const zCategory = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  sortOrder: z.number(),
  isActive: z.boolean(),
  productCount: z.number(),
});
export class CategoryDto extends createDto(zCategory) {}
export class CategoryListDto extends createDto(z.array(zCategory)) {}
