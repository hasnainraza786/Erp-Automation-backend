import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, Decimal, money, sum } from '../../common/money';
import { dateRangeWhere, pageArgs, pageMeta } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { ACCOUNTS, cashAccountFor, JournalService } from '../../infra/journal.service';
import { NotificationsService } from '../../infra/notifications.service';
import { NumberingService } from '../../infra/numbering.service';
import { PrismaService, Tx } from '../../infra/prisma.service';
import { recomputeMilestones } from '../projects/project-finance';
import { AllocatePaymentDto, CreatePaymentDto, PaymentQueryDto } from './finance.schemas';
import { invoiceStatusFor } from './invoices.service';

const include = {
  client: { select: { id: true, name: true, code: true } },
  site: { select: { id: true, name: true, code: true } },
  allocations: {
    include: {
      project: { select: { id: true, number: true, name: true, site: { select: { id: true, name: true, code: true } } } },
      invoice: { select: { id: true, number: true } },
    },
  },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof include }>;

interface AllocationIn {
  projectId: string;
  invoiceId?: string | null;
  amount: string | number;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly notifications: NotificationsService,
  ) {}

  present(p: PaymentRow) {
    const allocated = sum(p.allocations.filter((a) => a.status === 'POSTED').map((a) => a.amount));
    return {
      id: p.id,
      number: p.number,
      paidOn: p.paidOn.toISOString(),
      amount: money(p.amount),
      allocated: money(p.status === 'POSTED' ? allocated : 0),
      unallocated: money(p.status === 'POSTED' ? D(p.amount).minus(allocated) : 0),
      method: p.method,
      reference: p.reference,
      bank: p.bank,
      chequeNo: p.chequeNo,
      transactionId: p.transactionId,
      notes: p.notes,
      status: p.status,
      voidReason: p.voidReason,
      client: p.client,
      site: p.site,
      allocations: p.allocations.map((a) => ({
        id: a.id,
        amount: money(a.amount),
        status: a.status,
        project: { id: a.project.id, number: a.project.number, name: a.project.name },
        site: a.project.site,
        invoice: a.invoice,
      })),
      createdAt: p.createdAt.toISOString(),
    };
  }

  async list(q: PaymentQueryDto) {
    const where: Prisma.PaymentWhereInput = {
      clientId: q.clientId,
      method: q.method,
      status: q.status,
      paidOn: dateRangeWhere(q),
      ...(q.siteId ? { OR: [{ siteId: q.siteId }, { allocations: { some: { project: { siteId: q.siteId } } } }] } : {}),
      ...(q.projectId ? { allocations: { some: { projectId: q.projectId } } } : {}),
      ...(q.amountMin !== undefined || q.amountMax !== undefined
        ? { amount: { ...(q.amountMin !== undefined ? { gte: q.amountMin } : {}), ...(q.amountMax !== undefined ? { lte: q.amountMax } : {}) } }
        : {}),
      ...(q.q
        ? {
            AND: [
              {
                OR: [
                  { number: { contains: q.q, mode: 'insensitive' } },
                  { reference: { contains: q.q, mode: 'insensitive' } },
                  { chequeNo: { contains: q.q, mode: 'insensitive' } },
                  { transactionId: { contains: q.q, mode: 'insensitive' } },
                  { client: { name: { contains: q.q, mode: 'insensitive' } } },
                ],
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({ where, include, orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }], ...pageArgs(q) }),
      this.prisma.payment.count({ where }),
    ]);
    let data = rows.map((r) => this.present(r));
    if (q.unallocated === 'true') data = data.filter((p) => D(p.unallocated).gt(0));
    return { data, meta: pageMeta(q, total) };
  }

  async get(id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id }, include });
    if (!p) throw new NotFoundException('Payment not found');
    return this.present(p);
  }

  /** Projects with open balances and unallocated payments for the payment entry screen. */
  async openItems(clientId: string) {
    const projects = await this.prisma.project.findMany({
      where: { clientId, status: { not: 'CANCELLED' } },
      include: {
        site: { select: { id: true, name: true, code: true } },
        invoices: { where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, orderBy: { invoiceDate: 'asc' } },
        allocations: { where: { status: 'POSTED' }, select: { amount: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const additional = await this.prisma.invoice.groupBy({
      by: ['projectId'],
      where: { clientId, kind: 'ADDITIONAL', status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } },
      _sum: { total: true },
    });
    const additionalBy = new Map(additional.map((a) => [a.projectId, D(a._sum.total)]));
    const payments = await this.prisma.payment.findMany({ where: { clientId, status: 'POSTED' }, include: { allocations: { where: { status: 'POSTED' } } }, orderBy: { paidOn: 'asc' } });
    return {
      projects: projects.map((p) => {
        const received = sum(p.allocations.map((a) => a.amount));
        const billable = D(p.contractValue).plus(additionalBy.get(p.id) ?? 0);
        return {
          id: p.id,
          number: p.number,
          name: p.name,
          site: p.site,
          contractValue: money(billable),
          received: money(received),
          balance: money(billable.minus(received)),
          invoices: p.invoices.map((i) => ({ id: i.id, number: i.number, total: money(i.total), balance: money(D(i.total).minus(D(i.paidAmount))), dueDate: i.dueDate?.toISOString() ?? null })),
        };
      }),
      unallocatedPayments: payments
        .map((p) => ({ id: p.id, number: p.number, paidOn: p.paidOn.toISOString(), unallocated: money(D(p.amount).minus(sum(p.allocations.map((a) => a.amount)))) }))
        .filter((p) => D(p.unallocated).gt(0)),
    };
  }

  /** Validates allocations and writes them, updating invoices and milestones. Returns the per-project journal lines. */
  private async applyAllocations(tx: Tx, clientId: string, paymentId: string, allocations: AllocationIn[], maxTotal: Decimal) {
    const total = sum(allocations.map((a) => a.amount));
    if (allocations.some((a) => D(a.amount).lte(0))) throw new BadRequestException('Allocation amounts must be greater than zero');
    if (total.gt(maxTotal)) throw new BadRequestException(`Allocations (PKR ${money(total)}) exceed the available amount (PKR ${money(maxTotal)})`);

    const lines: { projectId: string; siteId: string; amount: Decimal }[] = [];
    for (const a of allocations) {
      const project = await tx.project.findUnique({ where: { id: a.projectId } });
      if (!project || project.clientId !== clientId) throw new BadRequestException('Allocation project does not belong to this client');
      if (project.status === 'CANCELLED') throw new BadRequestException(`Project ${project.number} is cancelled`);

      const [received, additional] = await Promise.all([
        tx.paymentAllocation.aggregate({ where: { projectId: project.id, status: 'POSTED' }, _sum: { amount: true } }),
        tx.invoice.aggregate({ where: { projectId: project.id, kind: 'ADDITIONAL', status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } }, _sum: { total: true } }),
      ]);
      const balance = D(project.contractValue).plus(D(additional._sum.total)).minus(D(received._sum.amount));
      if (D(a.amount).gt(balance)) {
        throw new BadRequestException(`Allocation to ${project.number} exceeds its balance (PKR ${money(balance)})`);
      }

      if (a.invoiceId) {
        const inv = await tx.invoice.findUnique({ where: { id: a.invoiceId } });
        if (!inv || inv.projectId !== project.id) throw new BadRequestException('Invoice does not belong to the project');
        if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw new BadRequestException(`Invoice ${inv.number} is not open`);
        const paid = D(inv.paidAmount).plus(D(a.amount));
        if (paid.gt(D(inv.total))) throw new BadRequestException(`Allocation exceeds invoice ${inv.number} balance`);
        await tx.invoice.update({ where: { id: inv.id }, data: { paidAmount: money(paid), status: invoiceStatusFor(D(inv.total), paid) } });
      }
      await tx.paymentAllocation.create({ data: { paymentId, projectId: project.id, invoiceId: a.invoiceId ?? null, amount: money(a.amount) } });
      lines.push({ projectId: project.id, siteId: project.siteId, amount: D(a.amount) });
    }
    for (const projectId of new Set(lines.map((l) => l.projectId))) await recomputeMilestones(tx, projectId);
    return { lines, total };
  }

  async create(user: AuthUser, body: CreatePaymentDto) {
    const amount = D(body.amount);
    if (amount.lte(0)) throw new BadRequestException('Amount must be greater than zero');
    const id = await this.prisma.tx(async (tx) => {
      const client = await tx.client.findUnique({ where: { id: body.clientId } });
      if (!client) throw new NotFoundException('Client not found');
      if (body.siteId) {
        const site = await tx.site.findUnique({ where: { id: body.siteId } });
        if (!site || site.clientId !== client.id) throw new BadRequestException('Site does not belong to this client');
      }
      const number = await this.numbering.next(tx, 'PAYMENT', body.paidOn);
      const payment = await tx.payment.create({
        data: {
          number,
          clientId: client.id,
          siteId: body.siteId ?? null,
          paidOn: body.paidOn,
          amount: money(amount),
          method: body.method,
          reference: body.reference,
          bank: body.bank,
          chequeNo: body.chequeNo,
          transactionId: body.transactionId,
          notes: body.notes,
          createdBy: user.id,
        },
      });
      const { lines, total } = await this.applyAllocations(tx, client.id, payment.id, body.allocations, amount);
      const unallocated = amount.minus(total);

      await this.journal.post(tx, {
        date: body.paidOn,
        description: `${body.method.replace('_', ' ').toLowerCase()} payment from ${client.name}`,
        sourceType: 'PAYMENT',
        sourceId: payment.id,
        reference: number,
        createdBy: user.id,
        lines: [
          { account: cashAccountFor(body.method), debit: amount, clientId: client.id, siteId: body.siteId },
          ...lines.map((l) => ({ account: ACCOUNTS.AR, credit: l.amount, clientId: client.id, siteId: l.siteId, projectId: l.projectId })),
          { account: ACCOUNTS.AR, credit: unallocated, clientId: client.id, siteId: body.siteId, memo: 'Unallocated' },
        ],
      });
      await this.audit.log(user, {
        action: 'payment.created',
        entityType: 'Payment',
        entityId: payment.id,
        summary: `${number}: PKR ${money(amount)} from ${client.name}${unallocated.gt(0) ? ` (PKR ${money(unallocated)} unallocated)` : ''}`,
        after: { amount: money(amount), allocations: body.allocations },
      }, tx);
      await this.notifications.notify({
        type: 'PAYMENT_RECEIVED',
        title: `Payment received: PKR ${money(amount)}`,
        body: `${client.name} — ${number}`,
        entityType: 'Payment',
        entityId: payment.id,
        audience: ['Accounts', 'Sales'],
      }, tx);
      return payment.id;
    });
    return this.get(id);
  }

  async allocate(user: AuthUser, id: string, body: AllocatePaymentDto) {
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${id}::uuid FOR UPDATE`;
      const p = await tx.payment.findUnique({ where: { id }, include: { allocations: { where: { status: 'POSTED' } } } });
      if (!p) throw new NotFoundException('Payment not found');
      if (p.status !== 'POSTED') throw new BadRequestException('Payment is voided');
      const available = D(p.amount).minus(sum(p.allocations.map((a) => a.amount)));
      const { lines, total } = await this.applyAllocations(tx, p.clientId, p.id, body.allocations, available);
      await this.journal.post(tx, {
        date: new Date(),
        description: `Allocation of ${p.number}`,
        sourceType: 'PAYMENT_ALLOCATION',
        sourceId: p.id,
        reference: p.number,
        createdBy: user.id,
        lines: [
          { account: ACCOUNTS.AR, debit: total, clientId: p.clientId, siteId: p.siteId, memo: 'Unallocated → projects' },
          ...lines.map((l) => ({ account: ACCOUNTS.AR, credit: l.amount, clientId: p.clientId, siteId: l.siteId, projectId: l.projectId })),
        ],
      });
      await this.audit.log(user, { action: 'payment.allocated', entityType: 'Payment', entityId: id, summary: `${p.number}: PKR ${money(total)} allocated`, after: body.allocations }, tx);
    });
    return this.get(id);
  }

  /** Reverse-and-re-enter correction: the payment and all its allocations are voided with mirror journal entries. */
  async void(user: AuthUser, id: string, reason: string) {
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${id}::uuid FOR UPDATE`;
      const p = await tx.payment.findUnique({ where: { id }, include: { allocations: { where: { status: 'POSTED' } } } });
      if (!p) throw new NotFoundException('Payment not found');
      if (p.status === 'VOIDED') throw new BadRequestException('Payment already voided');

      for (const a of p.allocations) {
        if (a.invoiceId) {
          const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
          const paid = Decimal.max(0, D(inv.paidAmount).minus(D(a.amount)));
          await tx.invoice.update({ where: { id: inv.id }, data: { paidAmount: money(paid), status: inv.status === 'CANCELLED' ? 'CANCELLED' : invoiceStatusFor(D(inv.total), paid) } });
        }
      }
      await tx.paymentAllocation.updateMany({ where: { paymentId: id }, data: { status: 'VOIDED' } });
      await this.journal.reverseSource(tx, 'PAYMENT_ALLOCATION', id, reason, user.id);
      await this.journal.reverseSource(tx, 'PAYMENT', id, reason, user.id);
      await tx.payment.update({ where: { id }, data: { status: 'VOIDED', voidReason: reason, voidedAt: new Date() } });
      for (const projectId of new Set(p.allocations.map((a) => a.projectId))) await recomputeMilestones(tx, projectId);
      await this.audit.log(user, { action: 'payment.voided', entityType: 'Payment', entityId: id, summary: `${p.number} (PKR ${money(p.amount)}) voided: ${reason}`, before: { status: 'POSTED' }, after: { status: 'VOIDED', reason } }, tx);
    });
    return this.get(id);
  }
}
