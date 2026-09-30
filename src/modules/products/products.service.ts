import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, money, qty } from '../../common/money';
import { hasPermission, PERMISSIONS } from '../../common/permissions';
import { pageArgs, pageMeta, plain } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PrismaService } from '../../infra/prisma.service';
import {
  CreateCategoryDto,
  CreateProductDto,
  ProductQueryDto,
  UpdateCategoryDto,
  UpdateProductDto,
} from './products.schemas';

const include = {
  category: { select: { id: true, name: true } },
  subcategory: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  stock: true,
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof include }>;

const PRICE_FIELDS = ['costPrice', 'sellingPrice', 'minPrice', 'specialPrice'] as const;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private present(p: ProductRow, user: AuthUser) {
    const canSeeCost = hasPermission(user.permissions, PERMISSIONS.PRODUCT_COST_VIEW);
    const onHand = D(p.stock?.onHand);
    const reserved = D(p.stock?.reserved);
    return {
      ...plain({ ...p, stock: undefined }),
      costPrice: canSeeCost ? money(p.costPrice) : null,
      stock: {
        onHand: qty(onHand),
        reserved: qty(reserved),
        incoming: qty(p.stock?.incoming),
        available: qty(onHand.minus(reserved)),
      },
    };
  }

  private toData(input: Partial<CreateProductDto>) {
    const data: Record<string, unknown> = { ...input };
    for (const f of [...PRICE_FIELDS, 'taxRate', 'reorderLevel'] as const) {
      const v = (input as Record<string, unknown>)[f];
      if (v !== undefined) data[f] = v === null ? null : String(v);
    }
    return data;
  }

  async list(user: AuthUser, q: ProductQueryDto) {
    const where: Prisma.ProductWhereInput = {
      categoryId: q.categoryId,
      supplierId: q.supplierId,
      ...(q.active ? { isActive: q.active === 'true' } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { sku: { contains: q.q, mode: 'insensitive' } },
              { brand: { contains: q.q, mode: 'insensitive' } },
              { model: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    if (q.lowStock === 'true') {
      const low = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM "Product" p LEFT JOIN "ProductStock" s ON s."productId" = p.id
        WHERE p."isActive" AND COALESCE(s."onHand", 0) - COALESCE(s."reserved", 0) <= p."reorderLevel"`;
      where.id = { in: low.map((r) => r.id) };
    }
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, include, orderBy: { name: 'asc' }, ...pageArgs(q) }),
      this.prisma.product.count({ where }),
    ]);
    return { data: rows.map((p) => this.present(p, user)), meta: pageMeta(q, total) };
  }

  /** Fast autocomplete for the quotation builder: name, SKU, brand, price and available stock. */
  async search(q: string, limit: number) {
    const rows = await this.prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { brand: { contains: q, mode: 'insensitive' } },
          { model: { contains: q, mode: 'insensitive' } },
        ],
      },
      include: { stock: true },
      orderBy: { name: 'asc' },
      take: limit,
    });
    return rows.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      unit: p.unit,
      sellingPrice: money(p.sellingPrice),
      minPrice: p.minPrice ? money(p.minPrice) : null,
      taxRate: D(p.taxRate).toFixed(2),
      available: qty(D(p.stock?.onHand).minus(D(p.stock?.reserved))),
    }));
  }

  async get(user: AuthUser, id: string) {
    const p = await this.prisma.product.findUnique({ where: { id }, include });
    if (!p) throw new NotFoundException('Product not found');
    return this.present(p, user);
  }

  async create(user: AuthUser, input: CreateProductDto) {
    return this.prisma.tx(async (tx) => {
      const p = await tx.product.create({
        data: { ...(this.toData(input) as Prisma.ProductUncheckedCreateInput), stock: { create: {} } },
        include,
      });
      await this.audit.log(user, { action: 'product.created', entityType: 'Product', entityId: p.id, summary: `Product ${p.sku} ${p.name} created`, after: p }, tx);
      return this.present(p, user);
    });
  }

  async update(user: AuthUser, id: string, input: UpdateProductDto) {
    return this.prisma.tx(async (tx) => {
      const before = await tx.product.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Product not found');
      const p = await tx.product.update({
        where: { id },
        data: this.toData(input) as Prisma.ProductUncheckedUpdateInput,
        include,
      });

      for (const field of PRICE_FIELDS) {
        if (input[field] === undefined) continue;
        const oldV = before[field];
        const newV = p[field];
        const changed = (oldV === null) !== (newV === null) || (oldV && newV && !D(oldV).equals(D(newV)));
        if (!changed) continue;
        await tx.productPriceHistory.create({
          data: { productId: id, field, oldValue: oldV, newValue: newV, changedBy: user.id, changedByName: user.name },
        });
        await this.audit.log(user, {
          action: 'product.price_changed',
          entityType: 'Product',
          entityId: id,
          summary: `${p.name} ${field} changed from PKR ${oldV ? money(oldV) : '-'} to PKR ${newV ? money(newV) : '-'}`,
          before: { [field]: oldV },
          after: { [field]: newV },
        }, tx);
        await this.notifications.notify({
          type: 'PRICE_CHANGED',
          title: `Price changed: ${p.name}`,
          body: `${field}: ${oldV ? money(oldV) : '-'} → ${newV ? money(newV) : '-'}`,
          entityType: 'Product',
          entityId: id,
          audience: ['Sales'],
        }, tx);
      }
      await this.audit.log(user, { action: 'product.updated', entityType: 'Product', entityId: id, summary: `Product ${p.sku} updated`, before, after: p }, tx);
      return this.present(p, user);
    });
  }

  async priceHistory(id: string) {
    const rows = await this.prisma.productPriceHistory.findMany({ where: { productId: id }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({
      id: r.id,
      field: r.field,
      oldValue: r.oldValue ? money(r.oldValue) : null,
      newValue: r.newValue ? money(r.newValue) : null,
      changedByName: r.changedByName,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ── Categories ──

  async listCategories() {
    const rows = await this.prisma.productCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    return rows.map(({ _count, ...c }) => ({ ...c, productCount: _count.products }));
  }

  async createCategory(user: AuthUser, input: CreateCategoryDto) {
    const c = await this.prisma.productCategory.create({ data: input });
    await this.audit.log(user, { action: 'category.created', entityType: 'ProductCategory', entityId: c.id, summary: `Category ${c.name} created` });
    return { ...c, productCount: 0 };
  }

  async updateCategory(user: AuthUser, id: string, input: UpdateCategoryDto) {
    const c = await this.prisma.productCategory.update({ where: { id }, data: input, include: { _count: { select: { products: true } } } });
    await this.audit.log(user, { action: 'category.updated', entityType: 'ProductCategory', entityId: id, summary: `Category ${c.name} updated` });
    const { _count, ...rest } = c;
    return { ...rest, productCount: _count.products };
  }
}
