import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, money } from '../../common/money';
import { dateRangeWhere, pageArgs, pageMeta, plain } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { apBalance, apBalancesByVendor } from '../../infra/balances';
import { ACCOUNTS, cashAccountFor, JournalService } from '../../infra/journal.service';
import { NumberingService } from '../../infra/numbering.service';
import { PrismaService } from '../../infra/prisma.service';
import {
  CreateVendorDto,
  CreateVendorPaymentDto,
  UpdateVendorDto,
  VendorPaymentQueryDto,
  VendorQueryDto,
} from './vendors.schemas';

@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
  ) {}

  private data(input: Partial<CreateVendorDto>) {
    return {
      ...input,
      ...(input.email !== undefined ? { email: input.email || null } : {}),
      ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit === null ? null : String(input.creditLimit) } : {}),
    };
  }

  async list(q: VendorQueryDto) {
    const where: Prisma.VendorWhereInput = {
      status: q.status,
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { code: { contains: q.q, mode: 'insensitive' } },
              { contactPerson: { contains: q.q, mode: 'insensitive' } },
              { phone: { contains: q.q } },
            ],
          }
        : {}),
    };
    const [rows, total, balances] = await Promise.all([
      this.prisma.vendor.findMany({ where, orderBy: { name: 'asc' }, ...pageArgs(q) }),
      this.prisma.vendor.count({ where }),
      apBalancesByVendor(this.prisma),
    ]);
    return { data: rows.map((v) => ({ ...plain(v), outstanding: money(balances.get(v.id)) })), meta: pageMeta(q, total) };
  }

  async get(id: string) {
    const v = await this.prisma.vendor.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Vendor not found');
    return { ...plain(v), outstanding: money(await apBalance(this.prisma, id)) };
  }

  async create(user: AuthUser, input: CreateVendorDto) {
    return this.prisma.tx(async (tx) => {
      const v = await tx.vendor.create({ data: { ...this.data(input), code: await this.numbering.next(tx, 'VENDOR') } as Prisma.VendorCreateInput });
      await this.audit.log(user, { action: 'vendor.created', entityType: 'Vendor', entityId: v.id, summary: `Vendor ${v.name} created`, after: v }, tx);
      return { ...plain(v), outstanding: '0.00' };
    });
  }

  async update(user: AuthUser, id: string, input: UpdateVendorDto) {
    return this.prisma.tx(async (tx) => {
      const before = await tx.vendor.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Vendor not found');
      const v = await tx.vendor.update({ where: { id }, data: this.data(input) as Prisma.VendorUpdateInput });
      await this.audit.log(user, { action: 'vendor.updated', entityType: 'Vendor', entityId: id, summary: `Vendor ${v.name} updated`, before, after: v }, tx);
      return { ...plain(v), outstanding: money(await apBalance(tx, id)) };
    });
  }

  // ── Vendor payments ──

  async listPayments(q: VendorPaymentQueryDto) {
    const where: Prisma.VendorPaymentWhereInput = {
      vendorId: q.vendorId,
      method: q.method,
      status: q.status,
      paidOn: dateRangeWhere(q),
      ...(q.q ? { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.vendorPayment.findMany({
        where,
        include: { vendor: { select: { id: true, name: true, code: true } } },
        orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.vendorPayment.count({ where }),
    ]);
    return { data: plain(rows), meta: pageMeta(q, total) };
  }

  async createPayment(user: AuthUser, input: CreateVendorPaymentDto) {
    const amount = D(input.amount);
    if (amount.lte(0)) throw new BadRequestException('Amount must be greater than zero');
    return this.prisma.tx(async (tx) => {
      const vendor = await tx.vendor.findUnique({ where: { id: input.vendorId } });
      if (!vendor) throw new NotFoundException('Vendor not found');
      const number = await this.numbering.next(tx, 'VENDOR_PAYMENT', input.paidOn);
      const payment = await tx.vendorPayment.create({
        data: { ...input, amount: money(amount), number, createdBy: user.id },
        include: { vendor: { select: { id: true, name: true, code: true } } },
      });
      await this.journal.post(tx, {
        date: input.paidOn,
        description: `Payment to ${vendor.name}`,
        sourceType: 'VENDOR_PAYMENT',
        sourceId: payment.id,
        reference: number,
        createdBy: user.id,
        lines: [
          { account: ACCOUNTS.AP, debit: amount, vendorId: vendor.id },
          { account: cashAccountFor(input.method), credit: amount, vendorId: vendor.id },
        ],
      });
      await this.audit.log(user, { action: 'vendor_payment.created', entityType: 'VendorPayment', entityId: payment.id, summary: `${number}: PKR ${money(amount)} paid to ${vendor.name}`, after: payment }, tx);
      return plain(payment);
    });
  }

  async voidPayment(user: AuthUser, id: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const p = await tx.vendorPayment.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Vendor payment not found');
      if (p.status === 'VOIDED') throw new BadRequestException('Payment is already voided');
      await this.journal.reverseSource(tx, 'VENDOR_PAYMENT', id, reason, user.id);
      const updated = await tx.vendorPayment.update({
        where: { id },
        data: { status: 'VOIDED', voidReason: reason },
        include: { vendor: { select: { id: true, name: true, code: true } } },
      });
      await this.audit.log(user, { action: 'vendor_payment.voided', entityType: 'VendorPayment', entityId: id, summary: `${p.number} voided: ${reason}`, before: p, after: updated }, tx);
      return plain(updated);
    });
  }
}
