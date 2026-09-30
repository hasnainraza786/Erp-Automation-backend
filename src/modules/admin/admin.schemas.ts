import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zDateRange, zPageQuery } from '../../common/schemas';

// ─────────── users & roles ───────────

export const zUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  isActive: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  role: z.object({ id: z.string(), name: z.string() }),
});
export class UserDto extends createDto(zUser) {}
export class UserListDto extends createDto(z.array(zUser)) {}

const zPassword = z.string().min(8).max(100);
export const zCreateUser = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().max(30).optional().nullable(),
  roleId: z.string().uuid(),
  password: zPassword,
});
export class CreateUserDto extends createDto(zCreateUser) {}

export const zUpdateUser = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  roleId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
});
export class UpdateUserDto extends createDto(zUpdateUser) {}

export class ResetPasswordDto extends createDto(z.object({ password: zPassword })) {}

export const zRole = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  permissions: z.array(z.string()),
  isSystem: z.boolean(),
  userCount: z.number(),
});
export class RoleDto extends createDto(zRole) {}
export class RoleListDto extends createDto(z.array(zRole)) {}

export const zRoleInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional().nullable(),
  permissions: z.array(z.string()).default([]),
});
export class CreateRoleDto extends createDto(zRoleInput) {}
export class UpdateRoleDto extends createDto(zRoleInput.partial()) {}

export class PermissionCatalogDto extends createDto(
  z.array(z.object({ group: z.string(), permissions: z.array(z.object({ key: z.string(), label: z.string() })) })),
) {}

// ─────────── settings ───────────

export const zCompanySettings = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().max(500).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().max(200).optional(),
  website: z.string().max(200).optional(),
  taxInfo: z.string().max(200).optional(),
  logoKey: z.string().optional(),
});
export const zQuotationSettings = z.object({
  validityDays: z.number().int().min(1).max(365),
  defaultTerms: z.record(z.string(), z.string()),
  defaultPaymentSchedule: z.array(z.object({ name: z.string().min(1), percent: z.number().min(0).max(100) })),
});
export const zAccountingSettings = z.object({
  receivableOn: z.enum(['APPROVAL', 'INVOICE']),
  defaultTaxRate: z.number().min(0).max(100),
});
export const zInvoiceSettings = z.object({ dueDays: z.number().int().min(0).max(365), footerNote: z.string().max(1000).optional() });
const zNumberFormat = z.object({ prefix: z.string().trim().min(1).max(10), yearly: z.boolean(), padding: z.number().int().min(2).max(8) });
export const zNumberingSettings = z.record(z.string(), zNumberFormat);

export const zAllSettings = z.object({
  company: zCompanySettings,
  quotation: zQuotationSettings,
  accounting: zAccountingSettings,
  invoice: zInvoiceSettings,
  numbering: zNumberingSettings,
});
export class SettingsDto extends createDto(zAllSettings) {}
export class UpdateCompanySettingsDto extends createDto(zCompanySettings.partial()) {}
export class UpdateQuotationSettingsDto extends createDto(zQuotationSettings.partial()) {}
export class UpdateAccountingSettingsDto extends createDto(zAccountingSettings.partial()) {}
export class UpdateInvoiceSettingsDto extends createDto(zInvoiceSettings.partial()) {}
export class UpdateNumberingSettingsDto extends createDto(zNumberingSettings) {}

export const zSpacePreset = z.object({ id: z.string(), name: z.string(), sortOrder: z.number(), isActive: z.boolean() });
export class SpacePresetDto extends createDto(zSpacePreset) {}
export class SpacePresetListDto extends createDto(z.array(zSpacePreset)) {}
export const zSpacePresetInput = z.object({ name: z.string().trim().min(1).max(60), sortOrder: z.number().int().default(0), isActive: z.boolean().default(true) });
export class CreateSpacePresetDto extends createDto(zSpacePresetInput) {}
export class UpdateSpacePresetDto extends createDto(zSpacePresetInput.partial()) {}

// ─────────── audit ───────────

export const zAuditQuery = zPageQuery.merge(zDateRange).extend({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().optional(),
});
export class AuditQueryDto extends createDto(zAuditQuery) {}

export const zAuditLog = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  summary: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: z.string(),
});
export class AuditLogPageDto extends createDto(paginated(zAuditLog)) {}
