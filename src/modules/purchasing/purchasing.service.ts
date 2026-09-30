import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, Decimal, money, qty, round2, sum } from '../../common/money';
import { hasPermission, PERMISSIONS } from '../../common/permissions';
import { dateRangeWhere, pageArgs, pageMeta } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { ACCOUNTS, JournalService } from '../../infra/journal.service';
import { NotificationsService } from '../../infra/notifications.service';
import { NumberingService } from '../../infra/numbering.service';
import { fmtDate, PdfService, pkr } from '../../infra/pdf.service';
import { PrismaService, Tx } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { StockService } from '../../infra/stock.service';
import { ProjectsService } from '../projects/projects.service';
import {
  AdjustStockDto,
  CreatePurchaseOrderDto,
  FromShortageDto,
  InventoryQueryDto,
  PurchaseOrderQueryDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from './purchasing.schemas';

const include = {
  vendor: { select: { id: true, name: true, code: true } },
  project: { select: { id: true, number: true, name: true } },
  items: { include: { product: { select: { sku: true, name: true, unit: true } } } },
  receipts: { orderBy: { receivedAt: 'asc' } },
} satisfies Prisma.PurchaseOrderInclude;

type PORow = Prisma.PurchaseOrderGetPayload<{ include: typeof include }>;

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly stock: StockService,
    private readonly notifications: NotificationsService,
    private readonly projects: ProjectsService,
    private readonly pdf: PdfService,
    private readonly settings: SettingsService,
  ) {}

  present(po: PORow) {
    return {
      id: po.id,
      number: po.number,
      status: po.status,
      orderDate: po.orderDate.toISOString(),
      expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
      paymentTerms: po.paymentTerms,
      dueDate: po.dueDate?.toISOString() ?? null,
      subtotal: money(po.subtotal),
      discount: money(po.discount),
      tax: money(po.tax),
      total: money(po.total),
      notes: po.notes,
      confirmedAt: po.confirmedAt?.toISOString() ?? null,
      vendor: po.vendor,
      project: po.project,
      items: po.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        sku: i.product.sku,
        name: i.product.name,
        unit: i.product.unit,
        qty: qty(i.qty),
        receivedQty: qty(i.receivedQty),
        pendingQty: qty(D(i.qty).minus(D(i.receivedQty))),
        unitCost: money(i.unitCost),
        discount: money(i.discount),
        taxRate: D(i.taxRate).toFixed(2),
        lineTotal: money(i.lineTotal),
      })),
      receipts: po.receipts.map((r) => ({ id: r.id, number: r.number, receivedAt: r.receivedAt.toISOString(), notes: r.notes })),
      createdAt: po.createdAt.toISOString(),
    };
  }

  private async lines(tx: Tx, body: CreatePurchaseOrderDto) {
    const products = await tx.product.findMany({ where: { id: { in: body.items.map((i) => i.productId) } } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = body.items.map((i) => {
      const p = byId.get(i.productId);
      if (!p) throw new BadRequestException(`Unknown product ${i.productId}`);
      const q = D(i.qty);
      if (q.lte(0)) throw new BadRequestException(`Quantity for ${p.name} must be greater than zero`);
      const unitCost = round2(i.unitCost ?? p.costPrice);
      const discount = round2(i.discount ?? 0);
      const net = round2(q.times(unitCost)).minus(discount);
      if (net.lt(0)) throw new BadRequestException(`Discount exceeds line value for ${p.name}`);
      const taxRate = D(i.taxRate ?? 0);
      const tax = round2(net.times(taxRate).div(100));
      return { productId: p.id, qty: q, unitCost, discount, taxRate, net, tax, lineTotal: net.plus(tax) };
    });
    const subtotal = sum(lines.map((l) => l.net));
    const discount = round2(body.discount ?? 0);
    if (discount.gt(subtotal)) throw new BadRequestException('Discount exceeds subtotal');
    const tax = sum(lines.map((l) => l.tax));
    return { lines, subtotal, discount, tax, total: subtotal.minus(discount).plus(tax) };
  }

  async list(q: PurchaseOrderQueryDto) {
    const where: Prisma.PurchaseOrderWhereInput = {
      vendorId: q.vendorId,
      projectId: q.projectId,
      status: q.status,
      orderDate: dateRangeWhere(q),
      ...(q.q ? { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { vendor: { name: { contains: q.q, mode: 'insensitive' } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where, include, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return { data: rows.map((r) => ({ ...this.present(r), items: undefined, receipts: undefined })), meta: pageMeta(q, total) };
  }

  async get(id: string) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id }, include });
    if (!po) throw new NotFoundException('Purchase order not found');
    return this.present(po);
  }

  private async createInTx(tx: Tx, user: AuthUser, body: CreatePurchaseOrderDto) {
    const vendor = await tx.vendor.findUnique({ where: { id: body.vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    const calc = await this.lines(tx, body);
    const orderDate = body.orderDate ?? new Date(new Date().toISOString().slice(0, 10));
    const po = await tx.purchaseOrder.create({
      data: {
        number: await this.numbering.next(tx, 'PURCHASE_ORDER', orderDate),
        vendorId: vendor.id,
        projectId: body.projectId ?? null,
        orderDate,
        expectedDelivery: body.expectedDelivery,
        paymentTerms: body.paymentTerms ?? vendor.paymentTerms,
        dueDate: body.dueDate,
        subtotal: money(calc.subtotal),
        discount: money(calc.discount),
        tax: money(calc.tax),
        total: money(calc.total),
        notes: body.notes,
        createdBy: user.id,
        items: {
          create: calc.lines.map((l) => ({
            productId: l.productId,
            qty: qty(l.qty),
            unitCost: money(l.unitCost),
            discount: money(l.discount),
            taxRate: l.taxRate.toFixed(2),
            lineTotal: money(l.lineTotal),
          })),
        },
      },
    });
    await this.audit.log(user, { action: 'po.created', entityType: 'PurchaseOrder', entityId: po.id, summary: `${po.number} for ${vendor.name}: PKR ${money(calc.total)}` }, tx);
    return po;
  }

  async create(user: AuthUser, body: CreatePurchaseOrderDto) {
    const po = await this.prisma.tx((tx) => this.createInTx(tx, user, body));
    return this.get(po.id);
  }

  async update(user: AuthUser, id: string, body: UpdatePurchaseOrderDto) {
    await this.prisma.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id } });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (po.status !== 'DRAFT') throw new BadRequestException('Only draft purchase orders can be edited');
      const calc = await this.lines(tx, body);
      await tx.purchaseOrderItem.deleteMany({ where: { poId: id } });
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          vendorId: body.vendorId,
          projectId: body.projectId ?? null,
          orderDate: body.orderDate,
          expectedDelivery: body.expectedDelivery,
          paymentTerms: body.paymentTerms,
          dueDate: body.dueDate,
          subtotal: money(calc.subtotal),
          discount: money(calc.discount),
          tax: money(calc.tax),
          total: money(calc.total),
          notes: body.notes,
          items: {
            create: calc.lines.map((l) => ({ productId: l.productId, qty: qty(l.qty), unitCost: money(l.unitCost), discount: money(l.discount), taxRate: l.taxRate.toFixed(2), lineTotal: money(l.lineTotal) })),
          },
        },
      });
      await this.audit.log(user, { action: 'po.updated', entityType: 'PurchaseOrder', entityId: id, summary: `${po.number} updated: PKR ${money(po.total)} → PKR ${money(calc.total)}` }, tx);
    });
    return this.get(id);
  }

  /** Confirming a PO creates the vendor payable and marks the ordered quantity as incoming stock. */
  async send(user: AuthUser, id: string) {
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true, vendor: true } });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (po.status !== 'DRAFT') throw new BadRequestException('Only draft purchase orders can be sent');
      for (const i of po.items) {
        await this.stock.addIncoming(tx, i.productId, i.qty);
        if (po.projectId) await this.bumpProjectItem(tx, po.projectId, i.productId, { purchasedQty: D(i.qty) });
      }
      await this.journal.post(tx, {
        date: po.orderDate,
        description: `Products purchased — ${po.number}`,
        sourceType: 'PO_CONFIRM',
        sourceId: po.id,
        reference: po.number,
        createdBy: user.id,
        lines: [
          { account: ACCOUNTS.INVENTORY, debit: po.total, vendorId: po.vendorId, projectId: po.projectId },
          { account: ACCOUNTS.AP, credit: po.total, vendorId: po.vendorId, projectId: po.projectId },
        ],
      });
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'SENT', confirmedAt: new Date() } });
      await this.audit.log(user, { action: 'po.sent', entityType: 'PurchaseOrder', entityId: id, summary: `${po.number} confirmed with ${po.vendor.name}: payable PKR ${money(po.total)}` }, tx);
    });
    return this.get(id);
  }

  private async bumpProjectItem(tx: Tx, projectId: string, productId: string, delta: { purchasedQty?: Decimal; receivedQty?: Decimal }) {
    const item = await tx.projectItem.findUnique({ where: { projectId_productId: { projectId, productId } } });
    if (!item) return null;
    return tx.projectItem.update({
      where: { id: item.id },
      data: {
        ...(delta.purchasedQty ? { purchasedQty: qty(Decimal.max(0, D(item.purchasedQty).plus(delta.purchasedQty))) } : {}),
        ...(delta.receivedQty ? { receivedQty: qty(Decimal.max(0, D(item.receivedQty).plus(delta.receivedQty))) } : {}),
      },
    });
  }

  async receive(user: AuthUser, id: string, body: ReceivePurchaseOrderDto) {
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: { include: { product: true } }, vendor: true } });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (!['SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) throw new BadRequestException('Only sent purchase orders can be received');

      const grn = await this.numbering.next(tx, 'GOODS_RECEIPT');
      const receipt = await tx.goodsReceipt.create({ data: { number: grn, poId: id, receivedBy: user.id, notes: body.notes, lines: [] } });
      const received: { poItemId: string; productId: string; qty: string }[] = [];
      for (const line of body.lines) {
        const item = po.items.find((i) => i.id === line.poItemId);
        if (!item) throw new BadRequestException('Line does not belong to this purchase order');
        const q = D(line.qty);
        if (q.lte(0)) continue;
        const pending = D(item.qty).minus(D(item.receivedQty));
        if (q.gt(pending)) throw new BadRequestException(`${item.product.name}: receiving ${q.toString()} exceeds pending ${pending.toString()}`);
        await tx.purchaseOrderItem.update({ where: { id: item.id }, data: { receivedQty: qty(D(item.receivedQty).plus(q)) } });
        await this.stock.receive(tx, { productId: item.productId, qty: q, unitCost: item.unitCost, projectId: po.projectId, refType: 'GOODS_RECEIPT', refId: receipt.id, notes: `${grn} / ${po.number}`, userId: user.id });
        if (po.projectId) {
          const pi = await this.bumpProjectItem(tx, po.projectId, item.productId, { receivedQty: q });
          if (pi) {
            const need = D(pi.requiredQty).minus(D(pi.deliveredQty)).minus(D(pi.reservedQty));
            if (need.gt(0)) {
              const got = await this.stock.reserve(tx, { productId: item.productId, qty: Decimal.min(need, q), projectId: po.projectId, refType: 'GOODS_RECEIPT', refId: receipt.id, userId: user.id });
              if (got.gt(0)) await tx.projectItem.update({ where: { id: pi.id }, data: { reservedQty: qty(D(pi.reservedQty).plus(got)) } });
            }
          }
        }
        received.push({ poItemId: item.id, productId: item.productId, qty: q.toString() });
      }
      if (!received.length) throw new BadRequestException('Nothing to receive');
      await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { lines: received } });

      const items = await tx.purchaseOrderItem.findMany({ where: { poId: id } });
      const complete = items.every((i) => D(i.receivedQty).gte(D(i.qty)));
      await tx.purchaseOrder.update({ where: { id }, data: { status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED' } });
      await this.audit.log(user, { action: 'po.received', entityType: 'PurchaseOrder', entityId: id, summary: `${grn}: ${received.length} line(s) received on ${po.number}`, after: received }, tx);
      await this.notifications.notify({
        type: 'PO_RECEIVED',
        title: `Goods received: ${po.number}`,
        body: `${po.vendor.name} — ${complete ? 'fully received' : 'partially received'}`,
        entityType: 'PurchaseOrder',
        entityId: id,
        audience: ['Procurement', 'Project Manager'],
      }, tx);
    });
    return this.get(id);
  }

  async cancel(user: AuthUser, id: string, reason: string) {
    await this.prisma.tx(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true, receipts: true } });
      if (!po) throw new NotFoundException('Purchase order not found');
      if (!['DRAFT', 'SENT'].includes(po.status) || po.receipts.length) {
        throw new BadRequestException('Only draft or sent purchase orders with no receipts can be cancelled');
      }
      if (po.status === 'SENT') {
        for (const i of po.items) {
          await this.stock.addIncoming(tx, i.productId, D(i.qty).neg());
          if (po.projectId) await this.bumpProjectItem(tx, po.projectId, i.productId, { purchasedQty: D(i.qty).neg() });
        }
        await this.journal.reverseSource(tx, 'PO_CONFIRM', id, reason, user.id);
      }
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED', notes: [po.notes, `Cancelled: ${reason}`].filter(Boolean).join('\n') } });
      await this.audit.log(user, { action: 'po.cancelled', entityType: 'PurchaseOrder', entityId: id, summary: `${po.number} cancelled: ${reason}` }, tx);
    });
    return this.get(id);
  }

  /** Creates one draft PO per vendor for everything the project still has to buy. */
  async fromShortage(user: AuthUser, body: FromShortageDto) {
    const lines = (await this.projects.procurement({ ...user, permissions: ['*'] }, body.projectId)).filter(
      (l) => D(l.toPurchase).gt(0) && (!body.productIds || body.productIds.includes(l.productId)),
    );
    if (!lines.length) throw new BadRequestException('Nothing to purchase for this project');
    const missingSupplier = lines.filter((l) => !body.vendorId && !l.supplierId);
    if (missingSupplier.length) {
      throw new BadRequestException(`Choose a vendor: no default supplier for ${missingSupplier.map((l) => l.name).join(', ')}`);
    }
    const groups = new Map<string, typeof lines>();
    for (const l of lines) {
      const vendorId = body.vendorId ?? l.supplierId!;
      groups.set(vendorId, [...(groups.get(vendorId) ?? []), l]);
    }
    const ids = await this.prisma.tx(async (tx) => {
      const out: string[] = [];
      for (const [vendorId, group] of groups) {
        const po = await this.createInTx(tx, user, {
          vendorId,
          projectId: body.projectId,
          items: group.map((l) => ({ productId: l.productId, qty: l.toPurchase })),
          notes: 'Generated from project shortage list',
        });
        out.push(po.id);
      }
      return out;
    });
    return Promise.all(ids.map((i) => this.get(i)));
  }

  async renderPdf(id: string) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: { ...include, vendor: true } });
    if (!po) throw new NotFoundException('Purchase order not found');
    const company = await this.settings.get('company');
    const buffer = await this.pdf.render({
      info: { title: po.number },
      content: [
        this.pdf.header(company, 'PURCHASE ORDER', [
          ['PO #', po.number],
          ['Date', fmtDate(po.orderDate)],
          ['Expected', fmtDate(po.expectedDelivery)],
          ['Terms', po.paymentTerms ?? '-'],
        ]),
        { text: 'Vendor', style: 'h2' },
        { text: po.vendor.name, bold: true },
        [po.vendor.contactPerson, po.vendor.phone, po.vendor.email].filter(Boolean).join('  |  '),
        po.vendor.address ?? '',
        po.project ? { text: `Project: ${po.project.number} — ${po.project.name}`, margin: [0, 6, 0, 0] } : '',
        { text: ' ' },
        this.pdf.table(
          ['#', 'Product', 'Qty', 'Unit Cost', 'Discount', 'Tax %', 'Total'],
          po.items.map((i, n) => [String(n + 1), `${i.product.name}\n${i.product.sku}`, D(i.qty).toString(), pkr(i.unitCost), pkr(i.discount), D(i.taxRate).toString(), pkr(i.lineTotal)]),
          [16, '*', 40, 65, 55, 40, 70],
          2,
        ),
        this.pdf.totals([
          ['Subtotal', pkr(po.subtotal)],
          ...(D(po.discount).gt(0) ? ([['Discount', `- ${pkr(po.discount)}`]] as [string, string][]) : []),
          ['Tax', pkr(po.tax)],
          ['Total (PKR)', pkr(po.total), true],
        ]),
        po.notes ? { text: po.notes, margin: [0, 12, 0, 0] } : '',
      ],
    });
    return { buffer, fileName: `${po.number}.pdf` };
  }

  // ── Inventory ──

  async stockList(user: AuthUser, q: InventoryQueryDto) {
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      categoryId: q.categoryId,
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { sku: { contains: q.q, mode: 'insensitive' } }, { brand: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    if (q.lowStock === 'true') {
      const low = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM "Product" p LEFT JOIN "ProductStock" s ON s."productId" = p.id
        WHERE p."isActive" AND COALESCE(s."onHand", 0) - COALESCE(s."reserved", 0) <= p."reorderLevel"`;
      where.id = { in: low.map((r) => r.id) };
    }
    const canSeeCost = hasPermission(user.permissions, PERMISSIONS.PRODUCT_COST_VIEW);
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: { stock: true, category: { select: { name: true } } }, orderBy: { name: 'asc' }, ...pageArgs(q) }),
      this.prisma.product.count({ where }),
    ]);
    return {
      data: rows.map((p) => {
        const onHand = D(p.stock?.onHand);
        const reserved = D(p.stock?.reserved);
        const available = onHand.minus(reserved);
        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          brand: p.brand,
          category: p.category?.name ?? null,
          unit: p.unit,
          onHand: qty(onHand),
          reserved: qty(reserved),
          available: qty(available),
          incoming: qty(p.stock?.incoming),
          reorderLevel: qty(p.reorderLevel),
          lowStock: available.lte(D(p.reorderLevel)),
          stockValue: canSeeCost ? money(onHand.times(D(p.costPrice))) : null,
        };
      }),
      meta: pageMeta(q, total),
    };
  }

  async transactions(productId: string, q: { page: number; pageSize: number }) {
    const where = { productId };
    const [rows, total] = await Promise.all([
      this.prisma.inventoryTransaction.findMany({ where, include: { project: { select: { id: true, number: true } } }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.inventoryTransaction.count({ where }),
    ]);
    return {
      data: rows.map((t) => ({
        id: t.id,
        type: t.type,
        qty: qty(t.qty),
        unitCost: t.unitCost ? money(t.unitCost) : null,
        refType: t.refType,
        refId: t.refId,
        notes: t.notes,
        project: t.project,
        createdAt: t.createdAt.toISOString(),
      })),
      meta: pageMeta(q, total),
    };
  }

  /** Stock count corrections and opening stock. Value moves between Inventory and Equity/Other Expense. */
  async adjust(user: AuthUser, body: AdjustStockDto) {
    const delta = D(body.qty);
    if (delta.isZero()) throw new BadRequestException('Quantity cannot be zero');
    await this.prisma.tx(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: body.productId } });
      if (!product) throw new NotFoundException('Product not found');
      await this.stock.adjust(tx, { productId: product.id, qty: delta, unitCost: product.costPrice, refType: 'ADJUSTMENT', notes: body.reason, userId: user.id });
      const value = delta.abs().times(D(product.costPrice));
      await this.journal.post(tx, {
        date: new Date(),
        description: `Stock adjustment ${product.sku} ${delta.gt(0) ? '+' : ''}${delta.toString()}: ${body.reason}`,
        sourceType: 'STOCK_ADJUSTMENT',
        sourceId: product.id,
        createdBy: user.id,
        lines: delta.gt(0)
          ? [{ account: ACCOUNTS.INVENTORY, debit: value }, { account: ACCOUNTS.EQUITY, credit: value }]
          : [{ account: ACCOUNTS.OTHER_EXPENSE, debit: value }, { account: ACCOUNTS.INVENTORY, credit: value }],
      });
      await this.audit.log(user, { action: 'inventory.adjusted', entityType: 'Product', entityId: product.id, summary: `${product.name}: ${delta.gt(0) ? '+' : ''}${delta.toString()} (${body.reason})` }, tx);
    });
    return this.transactions(body.productId, { page: 1, pageSize: 25 });
  }
}
