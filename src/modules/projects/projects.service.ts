import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProjectStatus, SiteStatus } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, Decimal, money, qty } from '../../common/money';
import { hasPermission, PERMISSIONS } from '../../common/permissions';
import { pageArgs, pageMeta } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { arBalancesBy } from '../../infra/balances';
import { ACCOUNTS, JournalService } from '../../infra/journal.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PrismaService } from '../../infra/prisma.service';
import { StockService } from '../../infra/stock.service';
import { projectFinancials } from './project-finance';
import {
  CreateTaskDto,
  DEFAULT_TASKS,
  DeliverItemDto,
  InstallItemDto,
  PROGRESS_STAGES,
  ProjectQueryDto,
  UpdateMilestoneDto,
  UpdateProjectDto,
  UpdateProjectProgressDto,
  UpdateProjectStatusDto,
  UpdateTaskDto,
} from './projects.schemas';

const listInclude = {
  client: { select: { id: true, name: true, code: true } },
  site: { select: { id: true, name: true, code: true } },
  quotation: { select: { id: true, number: true } },
} satisfies Prisma.ProjectInclude;

const SITE_STATUS: Record<ProjectStatus, SiteStatus> = {
  APPROVED: 'APPROVED',
  PROCUREMENT: 'PROCUREMENT',
  INSTALLATION: 'INSTALLATION',
  TESTING: 'TESTING',
  COMPLETED: 'COMPLETED',
  ON_HOLD: 'ON_HOLD',
  CANCELLED: 'CANCELLED',
};

function overall(progress: unknown): number {
  const p = (progress ?? {}) as Record<string, number>;
  const values = PROGRESS_STAGES.map((s) => Number(p[s] ?? 0));
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly journal: JournalService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(q: ProjectQueryDto) {
    const where: Prisma.ProjectWhereInput = {
      clientId: q.clientId,
      siteId: q.siteId,
      status: q.status ?? (q.active === 'true' ? { notIn: ['COMPLETED', 'CANCELLED'] } : undefined),
      ...(q.q
        ? {
            OR: [
              { number: { contains: q.q, mode: 'insensitive' } },
              { name: { contains: q.q, mode: 'insensitive' } },
              { client: { name: { contains: q.q, mode: 'insensitive' } } },
              { site: { name: { contains: q.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.project.findMany({ where, include: listInclude, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.project.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const [balances, received] = await Promise.all([
      arBalancesBy(this.prisma, 'projectId', { projectId: { in: ids } }),
      this.prisma.paymentAllocation.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, status: 'POSTED' }, _sum: { amount: true } }),
    ]);
    const receivedBy = new Map(received.map((r) => [r.projectId, D(r._sum.amount)]));
    return {
      data: rows.map((p) => ({
        id: p.id,
        number: p.number,
        name: p.name,
        status: p.status,
        contractValue: money(p.contractValue),
        received: money(receivedBy.get(p.id)),
        outstanding: money(balances.get(p.id)),
        overallProgress: overall(p.progress),
        startDate: p.startDate?.toISOString() ?? null,
        expectedCompletion: p.expectedCompletion?.toISOString() ?? null,
        client: p.client,
        site: p.site,
        quotation: p.quotation,
        createdAt: p.createdAt.toISOString(),
      })),
      meta: pageMeta(q, total),
    };
  }

  async get(user: AuthUser, id: string) {
    const p = await this.prisma.project.findUnique({
      where: { id },
      include: {
        ...listInclude,
        items: { include: { product: { select: { sku: true, name: true, unit: true } } }, orderBy: { product: { name: 'asc' } } },
        spaces: { orderBy: { sortOrder: 'asc' } },
        milestones: { orderBy: { sortOrder: 'asc' }, include: { invoice: { select: { id: true, number: true, status: true } } } },
        tasks: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { assignee: { select: { name: true } } } },
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    const canSeeCost = hasPermission(user.permissions, PERMISSIONS.PRODUCT_COST_VIEW);
    const financials = await projectFinancials(this.prisma, id);
    const progress = Object.fromEntries(PROGRESS_STAGES.map((s) => [s, Number((p.progress as Record<string, number>)?.[s] ?? 0)]));
    return {
      id: p.id,
      number: p.number,
      name: p.name,
      status: p.status,
      contractValue: money(p.contractValue),
      received: financials.received,
      outstanding: financials.outstanding,
      overallProgress: overall(p.progress),
      startDate: p.startDate?.toISOString() ?? null,
      expectedCompletion: p.expectedCompletion?.toISOString() ?? null,
      client: p.client,
      site: p.site,
      quotation: p.quotation,
      createdAt: p.createdAt.toISOString(),
      version: p.version,
      revisionNo: p.revisionNo,
      completedAt: p.completedAt?.toISOString() ?? null,
      progress,
      financials: canSeeCost
        ? financials
        : { ...financials, estimatedProductCost: '0.00', actualProductCost: '0.00', estimatedCost: '0.00', estimatedProfit: '0.00', estimatedMargin: '0.00', actualProfit: '0.00', actualMargin: '0.00' },
      items: p.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        sku: i.product.sku,
        name: i.product.name,
        unit: i.product.unit,
        requiredQty: qty(i.requiredQty),
        reservedQty: qty(i.reservedQty),
        purchasedQty: qty(i.purchasedQty),
        receivedQty: qty(i.receivedQty),
        deliveredQty: qty(i.deliveredQty),
        installedQty: qty(i.installedQty),
        remainingQty: qty(Decimal.max(0, D(i.requiredQty).minus(D(i.installedQty)))),
        unitPrice: money(i.unitPrice),
        unitCost: canSeeCost ? money(i.unitCost) : null,
      })),
      spaces: p.spaces.map((s) => ({ name: s.name, items: s.items as { productId: string; name: string; qty: string }[] })),
      milestones: p.milestones.map((m) => ({
        id: m.id,
        name: m.name,
        percent: D(m.percent).toFixed(2),
        amount: money(m.amount),
        dueDate: m.dueDate?.toISOString() ?? null,
        status: m.status,
        invoiceId: m.invoice && m.invoice.status !== 'CANCELLED' ? m.invoice.id : null,
        invoiceNumber: m.invoice && m.invoice.status !== 'CANCELLED' ? m.invoice.number : null,
      })),
      tasks: p.tasks.map((t) => this.presentTask(t)),
    };
  }

  private presentTask(t: Prisma.ProjectTaskGetPayload<{ include: { assignee: { select: { name: true } } } }>) {
    return {
      id: t.id,
      name: t.name,
      assigneeId: t.assigneeId,
      assigneeName: t.assignee?.name ?? null,
      dueDate: t.dueDate?.toISOString() ?? null,
      status: t.status,
      notes: t.notes,
      sortOrder: t.sortOrder,
    };
  }

  async update(user: AuthUser, id: string, body: UpdateProjectDto) {
    await this.prisma.project.update({ where: { id }, data: body });
    await this.audit.log(user, { action: 'project.updated', entityType: 'Project', entityId: id, after: body });
    return this.get(user, id);
  }

  async updateStatus(user: AuthUser, id: string, body: UpdateProjectStatusDto) {
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${id}::uuid FOR UPDATE`;
      const p = await tx.project.findUnique({ where: { id }, include: { items: true } });
      if (!p) throw new NotFoundException('Project not found');
      if (p.version !== body.version) throw new ConflictException('Project was changed by someone else. Reload and try again.');
      if (p.status === 'CANCELLED') throw new BadRequestException('Cancelled projects cannot be reopened');
      if (p.status === body.status) return;

      if (body.status === 'CANCELLED') {
        const paid = await tx.paymentAllocation.aggregate({ where: { projectId: id, status: 'POSTED' }, _sum: { amount: true } });
        if (D(paid._sum.amount).gt(0)) {
          throw new BadRequestException('Project has payments allocated. Void or reallocate them before cancelling.');
        }
        const delivered = p.items.some((i) => D(i.deliveredQty).gt(0));
        if (delivered) throw new BadRequestException('Products were already delivered to site; return them to stock before cancelling.');
        for (const i of p.items) {
          await this.stock.release(tx, { productId: i.productId, qty: i.reservedQty, projectId: id, refType: 'PROJECT', refId: id, notes: 'Project cancelled', userId: user.id });
          await tx.projectItem.update({ where: { id: i.id }, data: { reservedQty: '0' } });
        }
        await this.journal.reverseSource(tx, 'QUOTATION_APPROVAL', id, `Project ${p.number} cancelled`, user.id);
        const invoices = await tx.invoice.findMany({ where: { projectId: id, status: { notIn: ['CANCELLED'] } } });
        for (const inv of invoices) {
          await this.journal.reverseSource(tx, 'INVOICE', inv.id, `Project ${p.number} cancelled`, user.id);
          await tx.invoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED' } });
        }
      }

      await tx.project.update({
        where: { id },
        data: {
          status: body.status,
          completedAt: body.status === 'COMPLETED' ? new Date() : null,
          version: { increment: 1 },
        },
      });
      await tx.site.update({ where: { id: p.siteId }, data: { status: SITE_STATUS[body.status] } });
      await this.audit.log(user, {
        action: 'project.status_changed',
        entityType: 'Project',
        entityId: id,
        summary: `${p.number}: ${p.status} → ${body.status}${body.note ? ` (${body.note})` : ''}`,
        before: { status: p.status },
        after: { status: body.status },
      }, tx);
    });
    return this.get(user, id);
  }

  async updateProgress(user: AuthUser, id: string, body: UpdateProjectProgressDto) {
    const p = await this.prisma.project.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Project not found');
    const progress = { ...((p.progress as object) ?? {}), ...body.progress };
    await this.prisma.project.update({ where: { id }, data: { progress } });
    await this.audit.log(user, { action: 'project.progress_updated', entityType: 'Project', entityId: id, summary: `${p.number} progress updated`, before: p.progress, after: progress });
    return this.get(user, id);
  }

  /** Delivers products from the warehouse to site: issues stock and books product cost to the project. */
  async deliverItem(user: AuthUser, projectId: string, itemId: string, body: DeliverItemDto) {
    const amount = D(body.qty);
    if (amount.lte(0)) throw new BadRequestException('Quantity must be greater than zero');
    await this.prisma.tx(async (tx) => {
      const item = await tx.projectItem.findUnique({ where: { id: itemId }, include: { project: true, product: true } });
      if (!item || item.projectId !== projectId) throw new NotFoundException('Project item not found');
      if (['CANCELLED', 'COMPLETED'].includes(item.project.status)) throw new BadRequestException(`Project is ${item.project.status.toLowerCase()}`);
      if (D(item.deliveredQty).plus(amount).gt(D(item.requiredQty))) {
        throw new BadRequestException(`Cannot deliver more than required (${D(item.requiredQty).toString()})`);
      }
      const fromReserved = await this.stock.issue(tx, {
        productId: item.productId,
        qty: amount,
        fromReserved: item.reservedQty,
        projectId,
        unitCost: item.unitCost,
        refType: 'PROJECT_DELIVERY',
        refId: item.id,
        notes: body.notes ?? `Delivered to ${item.project.number}`,
        userId: user.id,
      });
      await tx.projectItem.update({
        where: { id: itemId },
        data: { deliveredQty: qty(D(item.deliveredQty).plus(amount)), reservedQty: qty(D(item.reservedQty).minus(fromReserved)) },
      });
      const cost = amount.times(D(item.unitCost));
      await this.journal.post(tx, {
        date: new Date(),
        description: `${item.product.name} × ${amount.toString()} delivered to ${item.project.number}`,
        sourceType: 'PROJECT_DELIVERY',
        sourceId: item.id,
        reference: item.project.number,
        createdBy: user.id,
        lines: [
          { account: ACCOUNTS.COGS, debit: cost, projectId, clientId: item.project.clientId, siteId: item.project.siteId },
          { account: ACCOUNTS.INVENTORY, credit: cost, projectId },
        ],
      });
      await this.audit.log(user, { action: 'project.item_delivered', entityType: 'Project', entityId: projectId, summary: `${item.product.name} × ${amount.toString()} delivered to site` }, tx);

      const stock = await tx.productStock.findUnique({ where: { productId: item.productId } });
      if (stock && D(stock.onHand).minus(D(stock.reserved)).lte(D(item.product.reorderLevel))) {
        await this.notifications.notify({ type: 'LOW_STOCK', title: `Low stock: ${item.product.name}`, body: `Available ${D(stock.onHand).minus(D(stock.reserved)).toString()}`, entityType: 'Product', entityId: item.productId, audience: ['Procurement'] }, tx);
      }
    });
    return this.get(user, projectId);
  }

  async installItem(user: AuthUser, projectId: string, itemId: string, body: InstallItemDto) {
    const item = await this.prisma.projectItem.findUnique({ where: { id: itemId }, include: { product: true } });
    if (!item || item.projectId !== projectId) throw new NotFoundException('Project item not found');
    const installed = D(body.installedQty);
    if (installed.gt(D(item.deliveredQty))) throw new BadRequestException(`Installed cannot exceed delivered (${D(item.deliveredQty).toString()})`);
    await this.prisma.projectItem.update({ where: { id: itemId }, data: { installedQty: qty(installed) } });
    await this.audit.log(user, { action: 'project.item_installed', entityType: 'Project', entityId: projectId, summary: `${item.product.name} installed: ${D(item.installedQty).toString()} → ${installed.toString()}` });
    return this.get(user, projectId);
  }

  /** Required vs available vs to-purchase, the basis for draft purchase orders. */
  async procurement(user: AuthUser, id: string) {
    const items = await this.prisma.projectItem.findMany({
      where: { projectId: id },
      include: { product: { include: { stock: true, supplier: { select: { id: true, name: true } } } } },
      orderBy: { product: { name: 'asc' } },
    });
    const canSeeCost = hasPermission(user.permissions, PERMISSIONS.PRODUCT_COST_VIEW);
    return items.map((i) => {
      const stillNeeded = Decimal.max(0, D(i.requiredQty).minus(D(i.deliveredQty)).minus(D(i.reservedQty)));
      const onOrder = Decimal.max(0, D(i.purchasedQty).minus(D(i.receivedQty)));
      const free = Decimal.max(0, D(i.product.stock?.onHand).minus(D(i.product.stock?.reserved)));
      return {
        projectItemId: i.id,
        productId: i.productId,
        sku: i.product.sku,
        name: i.product.name,
        supplierId: i.product.supplier?.id ?? null,
        supplierName: i.product.supplier?.name ?? null,
        required: qty(i.requiredQty),
        delivered: qty(i.deliveredQty),
        reservedForProject: qty(i.reservedQty),
        onOrder: qty(onOrder),
        availableStock: qty(free),
        toPurchase: qty(Decimal.max(0, stillNeeded.minus(onOrder).minus(free))),
        unitCost: canSeeCost ? money(i.product.costPrice) : null,
      };
    });
  }

  /** Reserves any free warehouse stock still needed by the project. */
  async reserveStock(user: AuthUser, id: string) {
    await this.prisma.tx(async (tx) => {
      const items = await tx.projectItem.findMany({ where: { projectId: id } });
      for (const i of items) {
        const needed = D(i.requiredQty).minus(D(i.deliveredQty)).minus(D(i.reservedQty));
        if (needed.lte(0)) continue;
        const got = await this.stock.reserve(tx, { productId: i.productId, qty: needed, projectId: id, refType: 'PROJECT', refId: id, userId: user.id });
        if (got.gt(0)) await tx.projectItem.update({ where: { id: i.id }, data: { reservedQty: qty(D(i.reservedQty).plus(got)) } });
      }
      await this.audit.log(user, { action: 'project.stock_reserved', entityType: 'Project', entityId: id }, tx);
    });
    return this.procurement(user, id);
  }

  // ── Tasks ──

  async createTask(user: AuthUser, projectId: string, body: CreateTaskDto) {
    const t = await this.prisma.projectTask.create({ data: { ...body, projectId }, include: { assignee: { select: { name: true } } } });
    await this.audit.log(user, { action: 'task.created', entityType: 'Project', entityId: projectId, summary: `Task "${t.name}" added` });
    return this.presentTask(t);
  }

  async addDefaultTasks(user: AuthUser, projectId: string) {
    const existing = await this.prisma.projectTask.findMany({ where: { projectId }, select: { name: true } });
    const names = new Set(existing.map((e) => e.name));
    await this.prisma.projectTask.createMany({
      data: DEFAULT_TASKS.filter((n) => !names.has(n)).map((name, i) => ({ projectId, name, sortOrder: existing.length + i })),
    });
    await this.audit.log(user, { action: 'task.defaults_added', entityType: 'Project', entityId: projectId });
    return this.get(user, projectId);
  }

  async updateTask(user: AuthUser, taskId: string, body: UpdateTaskDto) {
    const before = await this.prisma.projectTask.findUnique({ where: { id: taskId } });
    if (!before) throw new NotFoundException('Task not found');
    const t = await this.prisma.projectTask.update({ where: { id: taskId }, data: body, include: { assignee: { select: { name: true } } } });
    await this.audit.log(user, { action: 'task.updated', entityType: 'Project', entityId: t.projectId, summary: `Task "${t.name}" updated${body.status ? ` (${before.status} → ${body.status})` : ''}` });
    return this.presentTask(t);
  }

  async updateMilestone(user: AuthUser, milestoneId: string, body: UpdateMilestoneDto) {
    const m = await this.prisma.paymentMilestone.update({ where: { id: milestoneId }, data: { dueDate: body.dueDate } });
    await this.audit.log(user, { action: 'milestone.updated', entityType: 'Project', entityId: m.projectId, summary: `Milestone ${m.name} due date set` });
    return this.get(user, m.projectId);
  }
}
