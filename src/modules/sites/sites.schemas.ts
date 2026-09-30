import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zDateInput, zMoney, zPageQuery } from '../../common/schemas';

export const zSiteType = z.enum(['HOUSE', 'APARTMENT', 'VILLA', 'OFFICE', 'HOTEL', 'RESTAURANT', 'COMMERCIAL', 'OTHER']);
export const zSiteStatus = z.enum([
  'LEAD', 'QUOTATION', 'APPROVED', 'PROCUREMENT', 'INSTALLATION', 'TESTING', 'COMPLETED', 'ON_HOLD', 'CANCELLED',
]);

export const zSiteInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(2).max(200),
  address: z.string().trim().max(500).optional().nullable(),
  type: zSiteType.default('HOUSE'),
  managerId: z.string().uuid().optional().nullable(),
  startDate: zDateInput.optional().nullable(),
  expectedCompletion: zDateInput.optional().nullable(),
  status: zSiteStatus.default('LEAD'),
  notes: z.string().max(4000).optional().nullable(),
});
export class CreateSiteDto extends createDto(zSiteInput) {}
export class UpdateSiteDto extends createDto(zSiteInput.omit({ clientId: true }).partial()) {}

export const zSiteQuery = zPageQuery.extend({
  clientId: z.string().uuid().optional(),
  status: zSiteStatus.optional(),
  type: zSiteType.optional(),
});
export class SiteQueryDto extends createDto(zSiteQuery) {}

export const zSite = z.object({
  id: z.string(),
  code: z.string(),
  clientId: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  type: zSiteType,
  managerId: z.string().nullable(),
  startDate: z.string().nullable(),
  expectedCompletion: z.string().nullable(),
  status: zSiteStatus,
  notes: z.string().nullable(),
  createdAt: z.string(),
  client: z.object({ id: z.string(), name: z.string(), code: z.string() }),
  manager: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export class SiteDto extends createDto(zSite) {}

export const zSiteListItem = zSite.extend({ outstanding: zMoney, projectCount: z.number(), quotationCount: z.number() });
export class SitePageDto extends createDto(paginated(zSiteListItem)) {}
