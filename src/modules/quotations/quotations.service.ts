import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, QuotationStatus } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, Decimal, money, qty, sum } from '../../common/money';
import { hasPermission, PERMISSIONS } from '../../common/permissions';
import { dateRangeWhere, pageArgs, pageMeta } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { ACCOUNTS, JournalService } from '../../infra/journal.service';
import { NotificationsService } from '../../infra/notifications.service';
import { NumberingService } from '../../infra/numbering.service';
import { PrismaService, Tx } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { StockService } from '../../infra/stock.service';
import { calculateQuotation, CalculationError, CalculationResult, ProductPricing, QuotationInput } from './calculator';
import {
  ApproveQuotationDto,
  CalculateQuotationDto,
  ChangeQuotationStatusDto,
  CreateQuotationDto,
  CreateTemplateDto,
  DuplicateQuotationDto,
  QuotationQueryDto,
  ReviseQuotationDto,
  TemplateFromQuotationDto,
  UpdateQuotationDto,
} from './quotations.schemas';

const revisionInclude = {
  spaces: { orderBy: { sortOrder: 'asc' } },
  items: { orderBy: { sortOrder: 'asc' }, include: { product: { select: { sku: true, name: true, unit: true } } } },
  charges: true,
} satisfies Prisma.QuotationRevisionInclude;

export type RevisionFull = Prisma.QuotationRevisionGetPayload<{ include: typeof revisionInclude }>;

const EDITABLE: QuotationStatus[] = ['DRAFT', 'REVISED'];
const APPROVABLE: QuotationStatus[] = ['DRAFT', 'SENT', 'UNDER_DISCUSSION', 'REVISED'];
const REVISABLE: QuotationStatus[] = ['SENT', 'UNDER_DISCUSSION', 'REVISED', 'REJECTED', 'EXPIRED'];

export const CHARGE_ACCOUNT: Record<string, string> = {
  INSTALLATION: ACCOUNTS.INSTALLATION_INCOME,
  PROGRAMMING: ACCOUNTS.PROGRAMMING_INCOME,
  ENGINEERING: ACCOUNTS.ENGINEERING_INCOME,
  TRANSPORTATION: ACCOUNTS.TRANSPORT_INCOME,
  OTHER: ACCOUNTS.OTHER_INCOME,
};

type Content = Pick<QuotationInput, 'type' | 'items' | 'spaces' | 'overallDiscountType' | 'overallDiscountValue' | 'charges' | 'paymentSchedule'>;

@Injectable()
export class QuotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly settings: SettingsService,
    private readonly stock: StockService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─────────────── calculation ───────────────

  private async pricing(db: Tx | PrismaService, content: Content) {
    const ids = new Set<string>();
    for (const i of content.items ?? []) ids.add(i.productId);
    for (const s of content.spaces ?? []) for (const i of s.items) ids.add(i.productId);
    const rows = await db.product.findMany({ where: { id: { in: [...ids] } } });
    const inactive = rows.filter((p) => !p.isActive);
    if (inactive.length) throw new BadRequestException(`Inactive products: ${inactive.map((p) => p.name).join(', ')}`);
    return new Map<string, ProductPricing>(
      rows.map((p) => [p.id, { id: p.id, sku: p.sku, name: p.name, unit: p.unit, sellingPrice: p.sellingPrice, costPrice: p.costPrice, minPrice: p.minPrice, taxRate: p.taxRate }]),
    );
  }

  private async calculate(db: Tx | PrismaService, user: AuthUser, content: Content, enforceOverride = true) {
    const products = await this.pricing(db, content);
    let calc: CalculationResult;
    try {
      calc = calculateQuotation(content, products);
    } catch (e) {
      if (e instanceof CalculationError) throw new BadRequestException(e.message);
      throw e;
    }
    if (enforceOverride && !hasPermission(user.permissions, PERMISSIONS.PRODUCT_PRICE_OVERRIDE)) {
      const blocked = calc.lines.filter((l) => l.priceOverridden || l.belowMinimum);
      if (blocked.length) {
        throw new ForbiddenException(
          `Price override requires permission (${blocked.map((l) => l.name).join(', ')}). Use the list price or ask an administrator.`,
        );
      }
    }
    return calc;
  }

  private presentCalc(calc: CalculationResult, spaceNames: string[], canSeeCost: boolean) {
    const line = (l: CalculationResult['lines'][number]) => ({
      productId: l.productId,
      sku: l.sku,
      name: l.name,
      unit: l.unit,
      description: l.description,
      qty: qty(l.qty),
      unitPrice: money(l.unitPrice),
      unitCost: canSeeCost ? money(l.unitCost) : null,
      gross: money(l.gross),
      discountType: l.discountType,
      discountValue: money(l.discountValue),
      discountAmount: money(l.discountAmount),
      net: money(l.net),
      taxRate: l.taxRate.toFixed(2),
      taxAmount: money(l.taxAmount),
      lineTotal: money(l.lineTotal),
      priceOverridden: l.priceOverridden,
      belowMinimum: l.belowMinimum,
    });
    return {
      spaces: spaceNames.map((name, i) => ({
        name,
        subtotal: money(sum(calc.lines.filter((l) => l.spaceIndex === i).map((l) => l.net))),
        itemCount: calc.lines.filter((l) => l.spaceIndex === i).length,
        items: calc.lines.filter((l) => l.spaceIndex === i).map(line),
      })),
      items: calc.lines.filter((l) => l.spaceIndex === null).map(line),
      summary: calc.summary.map((s) => ({ ...s, qty: qty(s.qty), unitPrice: money(s.unitPrice), total: money(s.total) })),
      subtotal: money(calc.subtotal),
      itemDiscountTotal: money(calc.itemDiscountTotal),
      overallDiscount: money(calc.overallDiscount),
      taxTotal: money(calc.taxTotal),
      charges: calc.charges.map((c) => ({ ...c, amount: money(c.amount) })),
      chargesTotal: money(calc.chargesTotal),
      grandTotal: money(calc.grandTotal),
      costTotal: canSeeCost ? money(calc.costTotal) : null,
      estimatedProfit: canSeeCost ? money(calc.netItems.minus(calc.overallDiscount).plus(calc.chargesTotal).minus(calc.costTotal)) : null,
      milestones: calc.milestones.map((m) => ({ name: m.name, percent: m.percent.toFixed(2), amount: money(m.amount) })),
      warnings: calc.warnings,
    };
  }

  async preview(user: AuthUser, body: CalculateQuotationDto) {
    const calc = await this.calculate(this.prisma, user, body, false);
    return this.presentCalc(calc, (body.spaces ?? []).map((s) => s.name), hasPermission(user.permissions, PERMISSIONS.PRODUCT_COST_VIEW));
  }

  /** Rebuilds the stored revision as calculator input, using the prices and costs captured at the time. */
  static contentFromRevision(type: 'PRODUCT' | 'SITE_DIVISION', rev: RevisionFull, withStored = false): Content {
    const toItem = (i: RevisionFull['items'][number]) => ({
      productId: i.productId,
      qty: i.qty.toString(),
      unitPrice: i.unitPrice.toString(),
      discountType: i.discountType,
      discountValue: i.discountValue.toString(),
      taxRate: i.taxRate.toString(),
      description: i.description,
      ...(withStored ? { stored: { unitCost: i.unitCost.toString(), priceOverridden: i.priceOverridden } } : {}),
    });
    return {
      type,
      items: type === 'PRODUCT' ? rev.items.map(toItem) : undefined,
      spaces: type === 'SITE_DIVISION' ? rev.spaces.map((s) => ({ name: s.name, items: rev.items.filter((i) => i.spaceId === s.id).map(toItem) })) : undefined,
      overallDiscountType: rev.overallDiscountType,
      overallDiscountValue: rev.overallDiscountValue.toString(),
      charges: rev.charges.map((c) => ({ kind: c.kind, label: c.label, amount: c.amount.toString() })),
      paymentSchedule: rev.paymentSchedule as { name: string; percent: number }[],
    };
  }

  /** Recalculates a stored revision with its frozen prices/costs (product catalog changes do not alter history). */
  static calcStored(type: 'PRODUCT' | 'SITE_DIVISION', rev: RevisionFull) {
    const products = new Map<string, ProductPricing>();
    for (const i of rev.items) {
      products.set(i.productId, {
        id: i.productId,
        sku: i.product.sku,
        name: i.product.name,
        unit: i.product.unit,
        sellingPrice: i.unitPrice,
        costPrice: i.unitCost,
        minPrice: null,
        taxRate: i.taxRate,
      });
    }
    const content = QuotationsService.contentFromRevision(type, rev, true);
    return { calc: calculateQuotation(content, products), spaceNames: rev.spaces.map((s) => s.name) };
  }

  private async writeContent(tx: Tx, revisionId: string, content: Content, calc: CalculationResult) {
    await tx.quotationItem.deleteMany({ where: { revisionId } });
    await tx.quotationSpace.deleteMany({ where: { revisionId } });
    await tx.quotationCharge.deleteMany({ where: { revisionId } });

    const spaceIds: string[] = [];
    for (const [i, s] of (content.type === 'SITE_DIVISION' ? content.spaces ?? [] : []).entries()) {
      const space = await tx.quotationSpace.create({ data: { revisionId, name: s.name, sortOrder: i } });
      spaceIds.push(space.id);
    }
    await tx.quotationItem.createMany({
      data: calc.lines.map((l, i) => ({
        revisionId,
        spaceId: l.spaceIndex === null ? null : spaceIds[l.spaceIndex],
        productId: l.productId,
        description: l.description,
        qty: qty(l.qty),
        unitPrice: money(l.unitPrice),
        unitCost: money(l.unitCost),
        discountType: l.discountType,
        discountValue: money(l.discountValue),
        discountAmount: money(l.discountAmount),
        taxRate: l.taxRate.toFixed(2),
        taxAmount: money(l.taxAmount),
        lineTotal: money(l.lineTotal),
        priceOverridden: l.priceOverridden,
        sortOrder: i,
      })),
    });
    if (calc.charges.length) {
      await tx.quotationCharge.createMany({
        data: calc.charges.map((c) => ({ revisionId, kind: c.kind, label: c.label, amount: money(c.amount) })),
      });
    }
    await tx.quotationRevision.update({
      where: { id: revisionId },
      data: {
        overallDiscountType: content.overallDiscountType ?? null,
        overallDiscountValue: money(content.overallDiscountValue),
        subtotal: money(calc.subtotal),
        itemDiscountTotal: money(calc.itemDiscountTotal),
        overallDiscount: money(calc.overallDiscount),
        taxTotal: money(calc.taxTotal),
        chargesTotal: money(calc.chargesTotal),
        grandTotal: money(calc.grandTotal),
        costTotal: money(calc.costTotal),
        paymentSchedule: (content.paymentSchedule ?? []).map((m) => ({ name: m.name, percent: Number(m.percent) })),
      },
    });
  }

  // ─────────────── queries ───────────────

  async list(q: QuotationQueryDto) {
    const where: Prisma.QuotationWhereInput = {
      clientId: q.clientId,
      siteId: q.siteId,
      status: q.status,
      type: q.type,
      createdAt: dateRangeWhere(q),
      ...(q.q
        ? {
            OR: [
              { number: { contains: q.q, mode: 'insensitive' } },
              { client: { name: { contains: q.q, mode: 'insensitive' } } },
              { site: { name: { contains: q.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.quotation.findMany({
        where,
        include: {
          client: { select: { id: true, name: true, code: true } },
          site: { select: { id: true, name: true, code: true } },
          project: { select: { id: true } },
          revisions: { select: { revisionNo: true, grandTotal: true, quotationDate: true, validUntil: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.quotation.count({ where }),
    ]);
    return {
      data: rows.map((r) => {
        const rev = r.revisions.find((x) => x.revisionNo === r.currentRevisionNo)!;
        return {
          id: r.id,
          number: r.number,
          displayNumber: r.currentRevisionNo > 1 ? `${r.number} Rev ${r.currentRevisionNo}` : r.number,
          type: r.type,
          status: r.status,
          currentRevisionNo: r.currentRevisionNo,
          grandTotal: money(rev?.grandTotal),
          quotationDate: rev?.quotationDate.toISOString(),
          validUntil: rev?.validUntil?.toISOString() ?? null,
          client: r.client,
          site: r.site,
          projectId: r.project?.id ?? null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      meta: pageMeta(q, total),
    };
  }

  async load(id: string, revisionNo?: number) {
    const qt = await this.prisma.quotation.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true, code: true, phone: true, email: true, billingAddress: true, companyName: true, contactPerson: true } },
        site: { select: { id: true, name: true, code: true, address: true, type: true } },
        project: { select: { id: true } },
        revisions: { orderBy: { revisionNo: 'asc' }, select: { id: true, revisionNo: true, grandTotal: true, changeNote: true, lockedAt: true, createdAt: true } },
      },
    });
    if (!qt) throw new NotFoundException('Quotation not found');
    const rev = await this.prisma.quotationRevision.findUnique({
      where: { quotationId_revisionNo: { quotationId: id, revisionNo: revisionNo ?? qt.currentRevisionNo } },
      include: revisionInclude,
    });
    if (!rev) throw new NotFoundException('Revision not found');
    return { qt, rev };
  }

  async get(user: AuthUser, id: string, revisionNo?: number) {
    const { qt, rev } = await this.load(id, revisionNo);
    const { calc, spaceNames } = QuotationsService.calcStored(qt.type, rev);
    const canSeeCost = hasPermission(user.permissions, PERMISSIONS.PRODUCT_COST_VIEW);
    return {
      id: qt.id,
      number: qt.number,
      displayNumber: rev.revisionNo > 1 ? `${qt.number} Rev ${rev.revisionNo}` : qt.number,
      type: qt.type,
      status: qt.status,
      currentRevisionNo: qt.currentRevisionNo,
      grandTotal: money(rev.grandTotal),
      quotationDate: rev.quotationDate.toISOString(),
      validUntil: rev.validUntil?.toISOString() ?? null,
      client: { id: qt.client.id, name: qt.client.name, code: qt.client.code },
      site: { id: qt.site.id, name: qt.site.name, code: qt.site.code },
      projectId: qt.project?.id ?? null,
      createdAt: qt.createdAt.toISOString(),
      version: qt.version,
      editable: EDITABLE.includes(qt.status) && !rev.lockedAt && rev.revisionNo === qt.currentRevisionNo,
      approvedAt: qt.approvedAt?.toISOString() ?? null,
      approvedBy: qt.approvedBy,
      approvalMethod: qt.approvalMethod,
      duplicatedFromId: qt.duplicatedFromId,
      revision: {
        id: rev.id,
        revisionNo: rev.revisionNo,
        quotationDate: rev.quotationDate.toISOString(),
        validUntil: rev.validUntil?.toISOString() ?? null,
        overallDiscountType: rev.overallDiscountType,
        overallDiscountValue: money(rev.overallDiscountValue),
        terms: rev.terms as Record<string, string>,
        notes: rev.notes,
        paymentSchedule: rev.paymentSchedule as { name: string; percent: number }[],
        lockedAt: rev.lockedAt?.toISOString() ?? null,
        changeNote: rev.changeNote,
      },
      calculation: this.presentCalc(calc, spaceNames, canSeeCost),
      revisions: qt.revisions.map((r) => ({
        ...r,
        grandTotal: money(r.grandTotal),
        lockedAt: r.lockedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  // ─────────────── lifecycle ───────────────

  async create(user: AuthUser, body: CreateQuotationDto) {
    const site = await this.prisma.site.findUnique({ where: { id: body.siteId } });
    if (!site || site.clientId !== body.clientId) throw new BadRequestException('Site does not belong to the selected client');

    const qs = await this.settings.get('quotation');
    let content: Content = body;
    if (body.templateId && !(body.items?.length || body.spaces?.length)) {
      content = { ...body, ...(await this.contentFromTemplate(body.templateId, body.type)) };
    }
    content = { ...content, paymentSchedule: content.paymentSchedule ?? qs.defaultPaymentSchedule };
    const quotationDate = body.quotationDate ?? new Date(new Date().toISOString().slice(0, 10));
    const validUntil = body.validUntil === undefined ? new Date(quotationDate.getTime() + qs.validityDays * 86400_000) : body.validUntil;

    return this.prisma.tx(async (tx) => {
      const calc = await this.calculate(tx, user, content);
      const number = await this.numbering.next(tx, 'QUOTATION', quotationDate);
      const qt = await tx.quotation.create({
        data: { number, clientId: body.clientId, siteId: body.siteId, type: body.type, createdBy: user.id },
      });
      const rev = await tx.quotationRevision.create({
        data: {
          quotationId: qt.id,
          revisionNo: 1,
          quotationDate,
          validUntil,
          terms: (body.terms ?? qs.defaultTerms) as Prisma.InputJsonValue,
          notes: body.notes,
          createdBy: user.id,
        },
      });
      await this.writeContent(tx, rev.id, content, calc);
      if (site.status === 'LEAD') await tx.site.update({ where: { id: site.id }, data: { status: 'QUOTATION' } });
      await this.audit.log(user, {
        action: 'quotation.created',
        entityType: 'Quotation',
        entityId: qt.id,
        summary: `${number} created for PKR ${money(calc.grandTotal)}`,
        after: { grandTotal: money(calc.grandTotal), type: body.type },
      }, tx);
      return { id: qt.id };
    }).then(({ id }) => this.get(user, id));
  }

  async update(user: AuthUser, id: string, body: UpdateQuotationDto) {
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Quotation" WHERE id = ${id}::uuid FOR UPDATE`;
      const qt = await tx.quotation.findUnique({ where: { id } });
      if (!qt) throw new NotFoundException('Quotation not found');
      if (qt.version !== body.version) throw new ConflictException('This quotation was changed by someone else. Reload and try again.');
      if (body.type !== qt.type) throw new BadRequestException('Quotation type cannot be changed; duplicate it instead');
      const rev = await tx.quotationRevision.findUniqueOrThrow({ where: { quotationId_revisionNo: { quotationId: id, revisionNo: qt.currentRevisionNo } } });
      if (!EDITABLE.includes(qt.status) || rev.lockedAt) {
        throw new BadRequestException('Sent quotations cannot be edited. Create a revision instead.');
      }
      const calc = await this.calculate(tx, user, body);
      await tx.quotationRevision.update({
        where: { id: rev.id },
        data: {
          quotationDate: body.quotationDate,
          validUntil: body.validUntil,
          terms: body.terms as Prisma.InputJsonValue | undefined,
          notes: body.notes,
        },
      });
      await this.writeContent(tx, rev.id, body, calc);
      await tx.quotation.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.audit.log(user, {
        action: 'quotation.edited',
        entityType: 'Quotation',
        entityId: id,
        summary: `${qt.number} Rev ${rev.revisionNo} edited: PKR ${money(rev.grandTotal)} → PKR ${money(calc.grandTotal)}`,
        before: { grandTotal: money(rev.grandTotal) },
        after: { grandTotal: money(calc.grandTotal) },
      }, tx);
    });
    return this.get(user, id);
  }

  async send(user: AuthUser, id: string) {
    await this.prisma.tx(async (tx) => {
      const qt = await tx.quotation.findUnique({ where: { id } });
      if (!qt) throw new NotFoundException('Quotation not found');
      if (!['DRAFT', 'REVISED', 'UNDER_DISCUSSION', 'SENT'].includes(qt.status)) {
        throw new BadRequestException(`Cannot send a quotation in status ${qt.status}`);
      }
      const rev = await tx.quotationRevision.findUniqueOrThrow({ where: { quotationId_revisionNo: { quotationId: id, revisionNo: qt.currentRevisionNo } } });
      const itemCount = await tx.quotationItem.count({ where: { revisionId: rev.id } });
      if (!itemCount) throw new BadRequestException('Add at least one product before sending');
      await tx.quotationRevision.update({ where: { id: rev.id }, data: { lockedAt: rev.lockedAt ?? new Date() } });
      await tx.quotation.update({ where: { id }, data: { status: 'SENT', version: { increment: 1 } } });
      await this.audit.log(user, { action: 'quotation.sent', entityType: 'Quotation', entityId: id, summary: `${qt.number} Rev ${rev.revisionNo} sent (PKR ${money(rev.grandTotal)})` }, tx);
    });
    return this.get(user, id);
  }

  async changeStatus(user: AuthUser, id: string, body: ChangeQuotationStatusDto) {
    await this.prisma.tx(async (tx) => {
      const qt = await tx.quotation.findUnique({ where: { id } });
      if (!qt) throw new NotFoundException('Quotation not found');
      if (['APPROVED', 'CANCELLED'].includes(qt.status)) throw new BadRequestException(`Quotation is ${qt.status.toLowerCase()}`);
      if (body.status === 'UNDER_DISCUSSION' && !['SENT', 'REVISED'].includes(qt.status)) {
        throw new BadRequestException('Only sent quotations can move to Under Discussion');
      }
      await tx.quotation.update({ where: { id }, data: { status: body.status, version: { increment: 1 } } });
      await this.audit.log(user, {
        action: 'quotation.status_changed',
        entityType: 'Quotation',
        entityId: id,
        summary: `${qt.number}: ${qt.status} → ${body.status}${body.note ? ` (${body.note})` : ''}`,
        before: { status: qt.status },
        after: { status: body.status },
      }, tx);
    });
    return this.get(user, id);
  }

  async revise(user: AuthUser, id: string, body: ReviseQuotationDto) {
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Quotation" WHERE id = ${id}::uuid FOR UPDATE`;
      const qt = await tx.quotation.findUnique({ where: { id } });
      if (!qt) throw new NotFoundException('Quotation not found');
      if (qt.version !== body.version) throw new ConflictException('This quotation was changed by someone else. Reload and try again.');
      if (body.type !== qt.type) throw new BadRequestException('Quotation type cannot be changed; duplicate it instead');
      const current = await tx.quotationRevision.findUniqueOrThrow({ where: { quotationId_revisionNo: { quotationId: id, revisionNo: qt.currentRevisionNo } } });
      if (!REVISABLE.includes(qt.status) || !current.lockedAt) {
        throw new BadRequestException('Only sent quotations can be revised; edit the draft directly.');
      }
      const calc = await this.calculate(tx, user, body);
      const revisionNo = qt.currentRevisionNo + 1;
      const rev = await tx.quotationRevision.create({
        data: {
          quotationId: id,
          revisionNo,
          quotationDate: body.quotationDate ?? new Date(new Date().toISOString().slice(0, 10)),
          validUntil: body.validUntil === undefined ? current.validUntil : body.validUntil,
          terms: (body.terms ?? current.terms) as Prisma.InputJsonValue,
          notes: body.notes ?? current.notes,
          changeNote: body.changeNote,
          createdBy: user.id,
        },
      });
      await this.writeContent(tx, rev.id, body, calc);
      await tx.quotation.update({ where: { id }, data: { currentRevisionNo: revisionNo, status: 'REVISED', version: { increment: 1 } } });
      await this.audit.log(user, {
        action: 'quotation.revised',
        entityType: 'Quotation',
        entityId: id,
        summary: `${qt.number} Rev ${revisionNo}: ${body.changeNote} (PKR ${money(current.grandTotal)} → PKR ${money(calc.grandTotal)})`,
        before: { revisionNo: current.revisionNo, grandTotal: money(current.grandTotal) },
        after: { revisionNo, grandTotal: money(calc.grandTotal) },
      }, tx);
    });
    return this.get(user, id);
  }

  /**
   * Approval runs as one transaction: status, project, receivable, milestones, stock reservation and audit
   * either all happen or none do.
   */
  async approve(user: AuthUser, id: string, body: ApproveQuotationDto) {
    const accounting = await this.settings.get('accounting');
    return this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Quotation" WHERE id = ${id}::uuid FOR UPDATE`;
      const qt = await tx.quotation.findUnique({ where: { id }, include: { client: true, site: true, project: true } });
      if (!qt) throw new NotFoundException('Quotation not found');
      if (qt.project) throw new ConflictException('Quotation is already approved');
      if (!APPROVABLE.includes(qt.status)) throw new BadRequestException(`Cannot approve a quotation in status ${qt.status}`);

      const rev = await tx.quotationRevision.findUniqueOrThrow({
        where: { quotationId_revisionNo: { quotationId: id, revisionNo: qt.currentRevisionNo } },
        include: revisionInclude,
      });
      if (!rev.items.length) throw new BadRequestException('Quotation has no products');
      const { calc } = QuotationsService.calcStored(qt.type, rev);
      const approvalDate = body.approvalDate ?? new Date(new Date().toISOString().slice(0, 10));

      await tx.quotationRevision.update({ where: { id: rev.id }, data: { lockedAt: rev.lockedAt ?? new Date() } });

      const projectNumber = await this.numbering.next(tx, 'PROJECT', approvalDate);
      const project = await tx.project.create({
        data: {
          number: projectNumber,
          name: body.projectName || `${qt.site.name} - ${qt.client.name}`,
          clientId: qt.clientId,
          siteId: qt.siteId,
          quotationId: qt.id,
          revisionNo: rev.revisionNo,
          contractValue: money(rev.grandTotal),
          estimatedCost: money(rev.costTotal),
          startDate: approvalDate,
          progress: { quotation: 100, approval: 100, procurement: 0, delivery: 0, installation: 0, programming: 0, testing: 0, handover: 0 },
        },
      });

      // Aggregated project products (procurement source) with the cost captured on the quotation
      const byProduct = new Map<string, { qty: Decimal; net: Decimal; cost: Decimal }>();
      for (const l of calc.lines) {
        const e = byProduct.get(l.productId) ?? { qty: D(0), net: D(0), cost: D(0) };
        e.qty = e.qty.plus(l.qty);
        e.net = e.net.plus(l.net);
        e.cost = e.cost.plus(l.qty.times(l.unitCost));
        byProduct.set(l.productId, e);
      }
      for (const [productId, e] of byProduct) {
        const item = await tx.projectItem.create({
          data: {
            projectId: project.id,
            productId,
            requiredQty: qty(e.qty),
            unitPrice: money(e.net.div(e.qty)),
            unitCost: money(e.cost.div(e.qty)),
          },
        });
        const reserved = await this.stock.reserve(tx, { productId, qty: e.qty, projectId: project.id, refType: 'PROJECT', refId: project.id, notes: `Reserved for ${projectNumber}`, userId: user.id });
        if (reserved.gt(0)) await tx.projectItem.update({ where: { id: item.id }, data: { reservedQty: qty(reserved) } });
      }

      for (const [i, s] of rev.spaces.entries()) {
        await tx.projectSpace.create({
          data: {
            projectId: project.id,
            name: s.name,
            sortOrder: i,
            items: rev.items.filter((it) => it.spaceId === s.id).map((it) => ({ productId: it.productId, name: it.product.name, qty: it.qty.toString() })),
          },
        });
      }

      for (const [i, m] of calc.milestones.entries()) {
        await tx.paymentMilestone.create({
          data: { projectId: project.id, name: m.name, percent: m.percent.toFixed(2), amount: money(m.amount), sortOrder: i },
        });
      }

      if (accounting.receivableOn === 'APPROVAL') {
        const dims = { clientId: qt.clientId, siteId: qt.siteId, projectId: project.id };
        const chargeLines = calc.charges.map((c) => ({ account: CHARGE_ACCOUNT[c.kind], credit: c.amount, memo: c.label, ...dims }));
        await this.journal.post(tx, {
          date: approvalDate,
          description: `Project approved: ${qt.number} Rev ${rev.revisionNo} → ${projectNumber}`,
          sourceType: 'QUOTATION_APPROVAL',
          sourceId: project.id,
          reference: qt.number,
          createdBy: user.id,
          lines: [
            { account: ACCOUNTS.AR, debit: calc.grandTotal, ...dims },
            { account: ACCOUNTS.SALES, credit: calc.netItems.minus(calc.overallDiscount), ...dims },
            { account: ACCOUNTS.TAX_PAYABLE, credit: calc.taxTotal, ...dims },
            ...chargeLines,
          ],
        });
      }

      await tx.site.update({ where: { id: qt.siteId }, data: { status: 'APPROVED' } });
      await tx.quotation.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedBy: body.approvedBy,
          approvalMethod: body.method,
          approvalMeta: { notes: body.notes ?? null, approvalDate: approvalDate.toISOString().slice(0, 10), recordedBy: user.name },
          version: { increment: 1 },
        },
      });
      await this.audit.log(user, {
        action: 'quotation.approved',
        entityType: 'Quotation',
        entityId: id,
        summary: `${qt.number} Rev ${rev.revisionNo} approved by ${body.approvedBy} (${body.method}). Project ${projectNumber} created for PKR ${money(rev.grandTotal)}`,
        after: { projectId: project.id, projectNumber, grandTotal: money(rev.grandTotal) },
      }, tx);
      await this.notifications.notify({
        type: 'QUOTATION_APPROVED',
        title: `Quotation approved: ${qt.number}`,
        body: `${qt.client.name} / ${qt.site.name} — PKR ${money(rev.grandTotal)}. Project ${projectNumber} created.`,
        entityType: 'Project',
        entityId: project.id,
        audience: ['Accounts', 'Procurement', 'Project Manager', 'Sales'],
      }, tx);

      return { quotationId: id, projectId: project.id, projectNumber };
    });
  }

  async duplicate(user: AuthUser, id: string, body: DuplicateQuotationDto) {
    const { qt, rev } = await this.load(id);
    const clientId = body.clientId ?? qt.clientId;
    const siteId = body.siteId ?? (clientId === qt.clientId ? qt.siteId : undefined);
    if (!siteId) throw new BadRequestException('Select a site for the new client');
    const content = QuotationsService.contentFromRevision(qt.type, rev);
    const created = await this.create(user, {
      ...content,
      clientId,
      siteId,
      terms: rev.terms as Record<string, string>,
      notes: rev.notes,
      // Re-price with current list prices unless the user may override.
      ...(hasPermission(user.permissions, PERMISSIONS.PRODUCT_PRICE_OVERRIDE) ? {} : stripPrices(content)),
    } as CreateQuotationDto);
    await this.prisma.quotation.update({ where: { id: created.id }, data: { duplicatedFromId: id } });
    await this.audit.log(user, { action: 'quotation.duplicated', entityType: 'Quotation', entityId: created.id, summary: `${created.number} duplicated from ${qt.number}` });
    return { ...created, duplicatedFromId: id };
  }

  async compare(id: string, from: number, to: number) {
    const [a, b] = await Promise.all([this.load(id, from), this.load(id, to)]);
    const key = (r: RevisionFull, i: RevisionFull['items'][number]) => `${r.spaces.find((s) => s.id === i.spaceId)?.name ?? ''}|${i.productId}`;
    const mapOf = (r: RevisionFull) => new Map(r.items.map((i) => [key(r, i), i]));
    const ma = mapOf(a.rev);
    const mb = mapOf(b.rev);
    const describe = (i: RevisionFull['items'][number]) => `${D(i.qty).toString()} × ${money(i.unitPrice)} = ${money(i.lineTotal)}`;
    const changes: { space: string | null; productName: string; change: 'ADDED' | 'REMOVED' | 'CHANGED'; before: string | null; after: string | null }[] = [];
    for (const [k, ia] of ma) {
      const ib = mb.get(k);
      const space = k.split('|')[0] || null;
      if (!ib) changes.push({ space, productName: ia.product.name, change: 'REMOVED', before: describe(ia), after: null });
      else if (!D(ia.qty).equals(D(ib.qty)) || !D(ia.unitPrice).equals(D(ib.unitPrice)) || !D(ia.lineTotal).equals(D(ib.lineTotal))) {
        changes.push({ space, productName: ia.product.name, change: 'CHANGED', before: describe(ia), after: describe(ib) });
      }
    }
    for (const [k, ib] of mb) {
      if (!ma.has(k)) changes.push({ space: k.split('|')[0] || null, productName: ib.product.name, change: 'ADDED', before: null, after: describe(ib) });
    }
    return {
      from,
      to,
      previousTotal: money(a.rev.grandTotal),
      newTotal: money(b.rev.grandTotal),
      difference: money(D(b.rev.grandTotal).minus(D(a.rev.grandTotal))),
      changes,
    };
  }

  // ─────────────── templates ───────────────

  private async contentFromTemplate(templateId: string, type: 'PRODUCT' | 'SITE_DIVISION'): Promise<Partial<Content>> {
    const t = await this.prisma.quotationTemplate.findUnique({ where: { id: templateId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    if (!t) throw new NotFoundException('Template not found');
    if (type === 'PRODUCT') {
      return { items: t.items.map((i) => ({ productId: i.productId, qty: i.qty.toString() })) };
    }
    const spaces = new Map<string, { productId: string; qty: string }[]>();
    for (const i of t.items) {
      const name = i.spaceName ?? 'General';
      spaces.set(name, [...(spaces.get(name) ?? []), { productId: i.productId, qty: i.qty.toString() }]);
    }
    return { spaces: [...spaces.entries()].map(([name, items]) => ({ name, items })) };
  }

  async listTemplates() {
    const rows = await this.prisma.quotationTemplate.findMany({
      where: { isActive: true },
      include: { items: { orderBy: { sortOrder: 'asc' }, include: { product: { select: { name: true, sku: true } } } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      type: t.type,
      isActive: t.isActive,
      items: t.items.map((i) => ({ spaceName: i.spaceName, productId: i.productId, productName: i.product.name, sku: i.product.sku, qty: qty(i.qty) })),
    }));
  }

  async createTemplate(user: AuthUser, body: CreateTemplateDto) {
    const t = await this.prisma.quotationTemplate.create({
      data: {
        name: body.name,
        description: body.description,
        type: body.type,
        items: { create: body.items.map((i, idx) => ({ spaceName: i.spaceName, productId: i.productId, qty: qty(i.qty), sortOrder: idx })) },
      },
    });
    await this.audit.log(user, { action: 'template.created', entityType: 'QuotationTemplate', entityId: t.id, summary: `Template ${t.name} created` });
    return (await this.listTemplates()).find((x) => x.id === t.id)!;
  }

  async templateFromQuotation(user: AuthUser, id: string, body: TemplateFromQuotationDto) {
    const { qt, rev } = await this.load(id);
    return this.createTemplate(user, {
      name: body.name,
      description: body.description ?? `From ${qt.number}`,
      type: qt.type,
      items: rev.items.map((i) => ({ spaceName: rev.spaces.find((s) => s.id === i.spaceId)?.name ?? null, productId: i.productId, qty: i.qty.toString() })),
    });
  }

  async archiveTemplate(user: AuthUser, id: string) {
    await this.prisma.quotationTemplate.update({ where: { id }, data: { isActive: false } });
    await this.audit.log(user, { action: 'template.archived', entityType: 'QuotationTemplate', entityId: id });
    return { ok: true };
  }
}

function stripPrices(content: Content): Partial<Content> {
  const strip = (i: NonNullable<Content['items']>[number]) => ({ ...i, unitPrice: undefined });
  return {
    items: content.items?.map(strip),
    spaces: content.spaces?.map((s) => ({ ...s, items: s.items.map(strip) })),
  };
}
