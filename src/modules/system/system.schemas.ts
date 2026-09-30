import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zPageQuery } from '../../common/schemas';

// ─────────── notifications ───────────

export const zNotificationQuery = zPageQuery.extend({ unread: z.enum(['true', 'false']).optional() });
export class NotificationQueryDto extends createDto(zNotificationQuery) {}

export const zNotification = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export class NotificationPageDto extends createDto(paginated(zNotification).extend({ unreadCount: z.number() })) {}
export class UnreadCountDto extends createDto(z.object({ unreadCount: z.number() })) {}
export class MarkReadDto extends createDto(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) })) {}

export const zJobsResult = z.object({
  ran: z.boolean(),
  overdueNotices: z.number(),
  expiringNotices: z.number(),
  expiredQuotations: z.number(),
  lowStockNotices: z.number(),
  vendorDueNotices: z.number(),
  backup: z.string().nullable(),
});
export class JobsResultDto extends createDto(zJobsResult) {}

// ─────────── documents ───────────

export const OWNER_TYPES = ['CLIENT', 'SITE', 'PROJECT', 'QUOTATION', 'PAYMENT', 'PURCHASE_ORDER', 'EXPENSE', 'PRODUCT', 'TASK', 'VENDOR'] as const;
export const DOC_CATEGORIES = [
  'SIGNED_QUOTATION', 'CNIC', 'DRAWING', 'FLOOR_PLAN', 'DATASHEET', 'PURCHASE_INVOICE', 'DELIVERY_CHALLAN',
  'RECEIPT', 'SITE_PHOTO', 'HANDOVER', 'PRODUCT_IMAGE', 'OTHER',
] as const;
export const PHOTO_STAGES = ['BEFORE', 'DURING', 'AFTER', 'ISSUE', 'HANDOVER'] as const;

export const zDocumentQuery = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.string().uuid(),
  category: z.enum(DOC_CATEGORIES).optional(),
});
export class DocumentQueryDto extends createDto(zDocumentQuery) {}

export const zUploadFields = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.string().uuid(),
  category: z.enum(DOC_CATEGORIES).default('OTHER'),
  photoStage: z.enum(PHOTO_STAGES).optional(),
});
export class UploadQueryDto extends createDto(zUploadFields) {}

export const zDocument = z.object({
  id: z.string(),
  ownerType: z.string(),
  ownerId: z.string(),
  category: z.string(),
  photoStage: z.string().nullable(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  uploadedBy: z.string().nullable(),
  createdAt: z.string(),
});
export class DocumentDto extends createDto(zDocument) {}
export class DocumentListDto extends createDto(z.array(zDocument)) {}
export class DocumentUrlDto extends createDto(z.object({ url: z.string(), expiresIn: z.number() })) {}

// ─────────── import / export ───────────

export const IMPORT_ENTITIES = ['products', 'clients', 'vendors'] as const;
export const EXPORT_ENTITIES = [
  'clients', 'sites', 'products', 'vendors', 'quotations', 'projects', 'invoices', 'payments', 'expenses',
  'purchase-orders', 'stock', 'receivables-aging', 'payables-aging', 'product-sales', 'project-profitability',
] as const;

export const zImportQuery = z.object({ dryRun: z.enum(['true', 'false']).default('true') });
export class ImportQueryDto extends createDto(zImportQuery) {}

export const zExportQuery = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export class ExportQueryDto extends createDto(zExportQuery) {}

export const zImportResult = z.object({
  dryRun: z.boolean(),
  totalRows: z.number(),
  created: z.number(),
  updated: z.number(),
  errors: z.array(z.object({ row: z.number(), message: z.string() })),
});
export class ImportResultDto extends createDto(zImportResult) {}

// ─────────── backups ───────────

export const zBackup = z.object({ id: z.string(), fileName: z.string(), size: z.number(), tables: z.number(), rows: z.number(), createdAt: z.string(), createdBy: z.string().nullable() });
export class BackupDto extends createDto(zBackup) {}
export class BackupListDto extends createDto(z.array(zBackup)) {}
