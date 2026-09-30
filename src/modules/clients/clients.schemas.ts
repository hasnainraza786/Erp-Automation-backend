import { createDto } from '../../common/dto';
import { z } from 'zod';
import { paginated, zMoney, zPageQuery } from '../../common/schemas';

export const zClientType = z.enum(['RESIDENTIAL', 'COMMERCIAL', 'BUILDER', 'CONTRACTOR', 'CORPORATE', 'OTHER']);
export const zRecordStatus = z.enum(['ACTIVE', 'ARCHIVED']);

const optionalText = z.string().trim().max(500).optional().nullable();

export const zClientInput = z.object({
  name: z.string().trim().min(2).max(200),
  companyName: optionalText,
  contactPerson: optionalText,
  phone: z.string().trim().max(30).optional().nullable(),
  whatsapp: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal('')),
  cnicNtn: z.string().trim().max(30).optional().nullable(),
  billingAddress: optionalText,
  notes: z.string().max(4000).optional().nullable(),
  type: zClientType.default('RESIDENTIAL'),
});
export class CreateClientDto extends createDto(zClientInput) {}
export class UpdateClientDto extends createDto(zClientInput.partial().extend({ status: zRecordStatus.optional() })) {}

export const zClientQuery = zPageQuery.extend({
  type: zClientType.optional(),
  status: zRecordStatus.optional(),
});
export class ClientQueryDto extends createDto(zClientQuery) {}

export const zClient = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  companyName: z.string().nullable(),
  contactPerson: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  email: z.string().nullable(),
  cnicNtn: z.string().nullable(),
  billingAddress: z.string().nullable(),
  notes: z.string().nullable(),
  type: zClientType,
  status: zRecordStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export class ClientDto extends createDto(zClient) {}

export const zClientListItem = zClient.extend({
  siteCount: z.number(),
  outstanding: zMoney,
});
export class ClientPageDto extends createDto(paginated(zClientListItem)) {}

export const zClientOverview = z.object({
  quotationValue: zMoney,
  approvedValue: zMoney,
  invoiced: zMoney,
  received: zMoney,
  outstanding: zMoney,
  unallocated: zMoney,
  siteCount: z.number(),
  projectCount: z.number(),
});

export const zClientDetail = zClient.extend({
  overview: zClientOverview,
  sites: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      type: z.string(),
      status: z.string(),
      address: z.string().nullable(),
      projectValue: zMoney,
      received: zMoney,
      outstanding: zMoney,
    }),
  ),
});
export class ClientDetailDto extends createDto(zClientDetail) {}
