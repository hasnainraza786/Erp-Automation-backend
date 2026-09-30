import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, money } from '../../common/money';
import { pageArgs, pageMeta, plain } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { arBalance, arBalancesBy } from '../../infra/balances';
import { NumberingService } from '../../infra/numbering.service';
import { PrismaService } from '../../infra/prisma.service';
import { ClientQueryDto, CreateClientDto, UpdateClientDto } from './clients.schemas';

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async list(q: ClientQueryDto) {
    const where: Prisma.ClientWhereInput = {
      type: q.type,
      status: q.status,
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { companyName: { contains: q.q, mode: 'insensitive' } },
              { code: { contains: q.q, mode: 'insensitive' } },
              { phone: { contains: q.q } },
              { email: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { sites: true } } },
        ...pageArgs(q),
      }),
      this.prisma.client.count({ where }),
    ]);
    const balances = await arBalancesBy(this.prisma, 'clientId', { clientId: { in: rows.map((r) => r.id) } });
    return {
      data: rows.map(({ _count, ...c }) => ({
        ...plain(c),
        siteCount: _count.sites,
        outstanding: money(balances.get(c.id)),
      })),
      meta: pageMeta(q, total),
    };
  }

  async get(id: string) {
    const client = await this.prisma.client.findUnique({ where: { id }, include: { sites: { orderBy: { createdAt: 'asc' } } } });
    if (!client) throw new NotFoundException('Client not found');

    const [quotations, projects, invoices, payments, outstanding, siteBalances, allocations] = await Promise.all([
      this.prisma.quotation.findMany({
        where: { clientId: id, status: { notIn: ['CANCELLED', 'REJECTED', 'EXPIRED'] } },
        select: { currentRevisionNo: true, revisions: { select: { revisionNo: true, grandTotal: true } } },
      }),
      this.prisma.project.findMany({ where: { clientId: id, status: { not: 'CANCELLED' } }, select: { siteId: true, contractValue: true } }),
      this.prisma.invoice.aggregate({ where: { clientId: id, status: { notIn: ['DRAFT', 'CANCELLED'] } }, _sum: { total: true } }),
      this.prisma.payment.aggregate({ where: { clientId: id, status: 'POSTED' }, _sum: { amount: true } }),
      arBalance(this.prisma, { clientId: id }),
      arBalancesBy(this.prisma, 'siteId', { clientId: id }),
      this.prisma.paymentAllocation.findMany({
        where: { status: 'POSTED', payment: { clientId: id } },
        select: { amount: true, project: { select: { siteId: true } } },
      }),
    ]);

    const quotationValue = quotations.reduce(
      (acc, qt) => acc.plus(D(qt.revisions.find((r) => r.revisionNo === qt.currentRevisionNo)?.grandTotal)),
      D(0),
    );
    const approvedValue = projects.reduce((acc, p) => acc.plus(D(p.contractValue)), D(0));
    const received = D(payments._sum.amount);
    const allocated = allocations.reduce((acc, a) => acc.plus(D(a.amount)), D(0));

    return {
      ...plain({ ...client, sites: undefined }),
      overview: {
        quotationValue: money(quotationValue),
        approvedValue: money(approvedValue),
        invoiced: money(invoices._sum.total),
        received: money(received),
        outstanding: money(outstanding),
        unallocated: money(received.minus(allocated)),
        siteCount: client.sites.length,
        projectCount: projects.length,
      },
      sites: client.sites.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        type: s.type,
        status: s.status,
        address: s.address,
        projectValue: money(projects.filter((p) => p.siteId === s.id).reduce((a, p) => a.plus(D(p.contractValue)), D(0))),
        received: money(allocations.filter((a) => a.project.siteId === s.id).reduce((acc, a) => acc.plus(D(a.amount)), D(0))),
        outstanding: money(siteBalances.get(s.id)),
      })),
    };
  }

  async create(user: AuthUser, input: CreateClientDto) {
    return this.prisma.tx(async (tx) => {
      const client = await tx.client.create({
        data: { ...input, email: input.email || null, code: await this.numbering.next(tx, 'CLIENT') },
      });
      await this.audit.log(user, { action: 'client.created', entityType: 'Client', entityId: client.id, summary: `Client ${client.name} created`, after: client }, tx);
      return plain(client);
    });
  }

  async update(user: AuthUser, id: string, input: UpdateClientDto) {
    return this.prisma.tx(async (tx) => {
      const before = await tx.client.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Client not found');
      const client = await tx.client.update({
        where: { id },
        data: { ...input, ...(input.email !== undefined ? { email: input.email || null } : {}) },
      });
      await this.audit.log(user, { action: 'client.updated', entityType: 'Client', entityId: id, summary: `Client ${client.name} updated`, before, after: client }, tx);
      return plain(client);
    });
  }
}
