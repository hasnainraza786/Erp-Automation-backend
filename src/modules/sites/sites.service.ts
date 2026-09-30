import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { money } from '../../common/money';
import { pageArgs, pageMeta, plain } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { arBalancesBy } from '../../infra/balances';
import { NumberingService } from '../../infra/numbering.service';
import { PrismaService } from '../../infra/prisma.service';
import { CreateSiteDto, SiteQueryDto, UpdateSiteDto } from './sites.schemas';

const include = {
  client: { select: { id: true, name: true, code: true } },
  manager: { select: { id: true, name: true } },
} satisfies Prisma.SiteInclude;

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async list(q: SiteQueryDto) {
    const where: Prisma.SiteWhereInput = {
      clientId: q.clientId,
      status: q.status,
      type: q.type,
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { code: { contains: q.q, mode: 'insensitive' } },
              { address: { contains: q.q, mode: 'insensitive' } },
              { client: { name: { contains: q.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.site.findMany({
        where,
        include: { ...include, _count: { select: { projects: true, quotations: true } } },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.site.count({ where }),
    ]);
    const balances = await arBalancesBy(this.prisma, 'siteId', { siteId: { in: rows.map((r) => r.id) } });
    return {
      data: rows.map(({ _count, ...s }) => ({
        ...plain(s),
        outstanding: money(balances.get(s.id)),
        projectCount: _count.projects,
        quotationCount: _count.quotations,
      })),
      meta: pageMeta(q, total),
    };
  }

  async get(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id }, include });
    if (!site) throw new NotFoundException('Site not found');
    return plain(site);
  }

  async create(user: AuthUser, input: CreateSiteDto) {
    return this.prisma.tx(async (tx) => {
      const site = await tx.site.create({
        data: { ...input, code: await this.numbering.next(tx, 'SITE') },
        include,
      });
      await this.audit.log(user, { action: 'site.created', entityType: 'Site', entityId: site.id, summary: `Site ${site.name} created for ${site.client.name}`, after: site }, tx);
      return plain(site);
    });
  }

  async update(user: AuthUser, id: string, input: UpdateSiteDto) {
    return this.prisma.tx(async (tx) => {
      const before = await tx.site.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Site not found');
      const site = await tx.site.update({ where: { id }, data: input, include });
      await this.audit.log(user, { action: 'site.updated', entityType: 'Site', entityId: id, summary: `Site ${site.name} updated`, before, after: site }, tx);
      return plain(site);
    });
  }
}
