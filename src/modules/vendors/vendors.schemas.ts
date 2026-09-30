import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zDateInput, zDateRange, zMoney, zMoneyInput, zPageQuery } from '../../common/schemas';

export const zPaymentMethod = z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'ONLINE_TRANSFER', 'OTHER']);
export const zTxnStatus = z.enum(['POSTED', 'VOIDED']);

export const zVendorInput = z.object({
  name: z.string().trim().min(2).max(200),
  contactPerson: z.string().trim().max(200).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal('')),
  address: z.string().trim().max(500).optional().nullable(),
  taxInfo: z.string().trim().max(100).optional().nullable(),
  paymentTerms: z.string().trim().max(200).optional().nullable(),
  creditLimit: zMoneyInput.optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});
export class CreateVendorDto extends createDto(zVendorInput) {}
export class UpdateVendorDto extends createDto(zVendorInput.partial().extend({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() })) {}

export const zVendorQuery = zPageQuery.extend({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() });
export class VendorQueryDto extends createDto(zVendorQuery) {}

export const zVendor = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  contactPerson: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  taxInfo: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  creditLimit: zMoney.nullable(),
  notes: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  createdAt: z.string(),
  outstanding: zMoney,
});
export class VendorDto extends createDto(zVendor) {}
export class VendorPageDto extends createDto(paginated(zVendor)) {}

export const zVendorPaymentInput = z.object({
  vendorId: z.string().uuid(),
  paidOn: zDateInput,
  amount: zMoneyInput,
  method: zPaymentMethod,
  reference: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});
export class CreateVendorPaymentDto extends createDto(zVendorPaymentInput) {}

export const zVendorPaymentQuery = zPageQuery.merge(zDateRange).extend({
  vendorId: z.string().uuid().optional(),
  method: zPaymentMethod.optional(),
  status: zTxnStatus.optional(),
});
export class VendorPaymentQueryDto extends createDto(zVendorPaymentQuery) {}

export const zVendorPayment = z.object({
  id: z.string(),
  number: z.string(),
  vendorId: z.string(),
  paidOn: z.string(),
  amount: zMoney,
  method: zPaymentMethod,
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  status: zTxnStatus,
  voidReason: z.string().nullable(),
  createdAt: z.string(),
  vendor: z.object({ id: z.string(), name: z.string(), code: z.string() }),
});
export class VendorPaymentDto extends createDto(zVendorPayment) {}
export class VendorPaymentPageDto extends createDto(paginated(zVendorPayment)) {}
