import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, ProductUnit } from '@prisma/client';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth.decorators';
import { D, money, qty } from '../../common/money';
import { hasPermission, PERMISSIONS as P, Permission } from '../../common/permissions';
import { dateRangeWhere } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { NumberingService } from '../../infra/numbering.service';
import { PrismaService, Tx } from '../../infra/prisma.service';
import { InsightsService } from '../insights/insights.service';
import { EXPORT_ENTITIES, IMPORT_ENTITIES } from './system.schemas';

type Row = Record<string, string>;
type Column = { header: string; key: string; width?: number };
type ExportEntity = (typeof EXPORT_ENTITIES)[number];
type ImportEntity = (typeof IMPORT_ENTITIES)[number];

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('error' in v) return '';
  }
  return String(v).trim();
}

const optText = (max = 500) => z.string().trim().max(max).transform((v) => v || null);
const optNum = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ''))
  .refine((v) => v === '' || /^\d+(\.\d+)?$/.test(v), 'must be a number')
  .transform((v) => (v === '' ? null : v));

const IMPORT_SPECS = {
  products: {
    columns: ['sku', 'name', 'brand', 'model', 'category', 'subcategory', 'unit', 'costPrice', 'sellingPrice', 'minPrice', 'specialPrice', 'taxRate', 'supplierCode', 'warranty', 'reorderLevel', 'description', 'active'],
    row: z.object({
      sku: z.string().trim().min(1, 'SKU is required').max(60),
      name: z.string().trim().min(1, 'Name is required').max(200),
      brand: optText(100),
      model: optText(100),
      category: optText(100),
      subcategory: optText(100),
      unit: z
        .string()
        .trim()
        .transform((v) => (v ? v.toUpperCase() : 'PIECE'))
        .pipe(z.enum(Object.values(ProductUnit) as [ProductUnit, ...ProductUnit[]])),
      costPrice: optNum,
      sellingPrice: optNum,
      minPrice: optNum,
      specialPrice: optNum,
      taxRate: optNum,
      supplierCode: optText(30),
      warranty: optText(200),
      reorderLevel: optNum,
      description: optText(2000),
      active: z.string().trim().transform((v) => !/^(no|false|0|inactive)$/i.test(v)),
    }),
  },
  clients: {
    columns: ['code', 'name', 'companyName', 'contactPerson', 'phone', 'whatsapp', 'email', 'cnicNtn', 'billingAddress', 'type', 'notes'],
    row: z.object({
      code: optText(30),
      name: z.string().trim().min(2, 'Name is required').max(200),
      companyName: optText(),
      contactPerson: optText(),
      phone: optText(30),
      whatsapp: optText(30),
      email: z.string().trim().refine((v) => v === '' || z.string().email().safeParse(v).success, 'invalid email').transform((v) => v || null),
      cnicNtn: optText(30),
      billingAddress: optText(),
      type: z
        .string()
        .trim()
        .transform((v) => (v ? v.toUpperCase() : 'RESIDENTIAL'))
        .pipe(z.enum(['RESIDENTIAL', 'COMMERCIAL', 'BUILDER', 'CONTRACTOR', 'CORPORATE', 'OTHER'])),
      notes: optText(4000),
    }),
  },
  vendors: {
    columns: ['code', 'name', 'contactPerson', 'phone', 'email', 'address', 'taxInfo', 'paymentTerms', 'creditLimit', 'notes'],
    row: z.object({
      code: optText(30),
      name: z.string().trim().min(2, 'Name is required').max(200),
      contactPerson: optText(),
      phone: optText(30),
      email: optText(200),
      address: optText(),
      taxInfo: optText(200),
      paymentTerms: optText(200),
      creditLimit: optNum,
      notes: optText(4000),
    }),
  },
} as const;

const IMPORT_PERMISSION: Record<ImportEntity, Permission> = { products: P.PRODUCT_MANAGE, clients: P.CLIENT_MANAGE, vendors: P.VENDOR_MANAGE };

@Injectable()
export class DataIoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly insights: InsightsService,
  ) {}

  // ─────────── file helpers ───────────

  private async readSheet(buffer: Buffer, fileName: string): Promise<Row[]> {
    const wb = new ExcelJS.Workbook();
    const isCsv = /\.csv$/i.test(fileName);
    try {
      if (isCsv) await wb.csv.read(Readable.from(buffer));
      else await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException('Could not read the file. Upload an .xlsx or .csv file.');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('The file has no worksheet');
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => (headers[col] = normalizeHeader(cellText(cell.value))));
    const rows: Row[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row: Row = {};
      let any = false;
      ws.getRow(r).eachCell({ includeEmpty: true }, (cell, col) => {
        const h = headers[col];
        if (!h) return;
        row[h] = cellText(cell.value);
        if (row[h]) any = true;
      });
      if (any) rows.push({ ...row, __row: String(r) });
    }
    return rows;
  }

  private async toFile(title: string, columns: Column[], rows: Record<string, unknown>[], format: 'xlsx' | 'csv') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERP';
    const ws = wb.addWorksheet(title.slice(0, 31));
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 2) }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) ws.addRow(r);
    const buffer = Buffer.from(format === 'csv' ? await wb.csv.writeBuffer() : await wb.xlsx.writeBuffer());
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      buffer,
      fileName: `${title.toLowerCase().replace(/\s+/g, '-')}-${stamp}.${format}`,
      mimeType: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  // ─────────── import ───────────

  async template(entity: ImportEntity) {
    const spec = IMPORT_SPECS[entity];
    return this.toFile(`${entity} import`, spec.columns.map((c) => ({ header: c, key: c, width: 18 })), [], 'xlsx');
  }

  async import(user: AuthUser, entity: string, file: { buffer: Buffer; fileName: string }, dryRun: boolean) {
    if (!(IMPORT_ENTITIES as readonly string[]).includes(entity)) throw new BadRequestException(`Import is supported for: ${IMPORT_ENTITIES.join(', ')}`);
    const e = entity as ImportEntity;
    if (!hasPermission(user.permissions, IMPORT_PERMISSION[e])) throw new ForbiddenException(`Missing permission: ${IMPORT_PERMISSION[e]}`);
    const spec = IMPORT_SPECS[e];
    const raw = await this.readSheet(file.buffer, file.fileName);
    if (raw.length > 5000) throw new BadRequestException('Import at most 5000 rows at a time');

    const errors: { row: number; message: string }[] = [];
    const parsed: { row: number; data: Record<string, unknown> }[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const input = Object.fromEntries(spec.columns.map((c) => [c, r[normalizeHeader(c)] ?? '']));
      const res = (spec.row as z.ZodType).safeParse(input);
      const rowNo = Number(r.__row);
      if (!res.success) {
        errors.push({ row: rowNo, message: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        continue;
      }
      const data = res.data as Record<string, unknown>;
      const uniq = String(data.sku ?? data.code ?? '');
      if (uniq && seen.has(uniq)) errors.push({ row: rowNo, message: `Duplicate ${e === 'products' ? 'SKU' : 'code'} ${uniq} in file` });
      if (uniq) seen.add(uniq);
      parsed.push({ row: rowNo, data });
    }

    let created = 0;
    let updated = 0;
    const plan = await this.planImport(e, parsed, errors);
    created = plan.filter((p) => !p.existingId).length;
    updated = plan.length - created;

    if (!dryRun && errors.length === 0) {
      for (let i = 0; i < plan.length; i += 200) {
        await this.prisma.tx(async (tx) => {
          for (const item of plan.slice(i, i + 200)) await this.applyRow(tx, user, e, item);
        });
      }
      await this.audit.log(user, { action: `${e}.imported`, entityType: 'Import', summary: `Imported ${e}: ${created} created, ${updated} updated from ${file.fileName}` });
    }
    return { dryRun: dryRun || errors.length > 0, totalRows: raw.length, created, updated, errors };
  }

  private async planImport(entity: ImportEntity, rows: { row: number; data: Record<string, unknown> }[], errors: { row: number; message: string }[]) {
    type Planned = { row: number; data: Record<string, unknown>; existingId?: string };
    const out: Planned[] = [];
    if (entity === 'products') {
      const [existing, vendors] = await Promise.all([
        this.prisma.product.findMany({ where: { sku: { in: rows.map((r) => String(r.data.sku)) } }, select: { id: true, sku: true } }),
        this.prisma.vendor.findMany({ select: { id: true, code: true } }),
      ]);
      const bySku = new Map(existing.map((p) => [p.sku, p.id]));
      const vendorByCode = new Map(vendors.map((v) => [v.code.toUpperCase(), v.id]));
      for (const r of rows) {
        const code = r.data.supplierCode as string | null;
        if (code && !vendorByCode.has(code.toUpperCase())) {
          errors.push({ row: r.row, message: `Unknown supplier code ${code}` });
          continue;
        }
        if (r.data.minPrice && r.data.sellingPrice && D(r.data.minPrice as string).gt(D(r.data.sellingPrice as string))) {
          errors.push({ row: r.row, message: 'minPrice is higher than sellingPrice' });
          continue;
        }
        out.push({ ...r, data: { ...r.data, supplierId: code ? vendorByCode.get(code.toUpperCase()) : null }, existingId: bySku.get(String(r.data.sku)) });
      }
    } else {
      const codes = rows.map((r) => r.data.code).filter(Boolean) as string[];
      const existing =
        entity === 'clients'
          ? await this.prisma.client.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })
          : await this.prisma.vendor.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
      const byCode = new Map(existing.map((x) => [x.code, x.id]));
      for (const r of rows) {
        const code = r.data.code as string | null;
        if (code && !byCode.has(code)) {
          errors.push({ row: r.row, message: `Code ${code} not found (leave code empty to create a new record)` });
          continue;
        }
        out.push({ ...r, existingId: code ? byCode.get(code) : undefined });
      }
    }
    return out;
  }

  private async categoryId(tx: Tx, name: string | null, parentId: string | null) {
    if (!name) return null;
    const found = await tx.productCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, parentId } });
    return (found ?? (await tx.productCategory.create({ data: { name, parentId } }))).id;
  }

  private async applyRow(tx: Tx, user: AuthUser, entity: ImportEntity, item: { data: Record<string, unknown>; existingId?: string }) {
    const d = item.data;
    if (entity === 'products') {
      const categoryId = await this.categoryId(tx, d.category as string | null, null);
      const subcategoryId = categoryId ? await this.categoryId(tx, d.subcategory as string | null, categoryId) : null;
      const data = {
        sku: d.sku as string,
        name: d.name as string,
        brand: d.brand as string | null,
        model: d.model as string | null,
        categoryId,
        subcategoryId,
        unit: d.unit as ProductUnit,
        costPrice: (d.costPrice as string | null) ?? '0',
        sellingPrice: (d.sellingPrice as string | null) ?? '0',
        minPrice: d.minPrice as string | null,
        specialPrice: d.specialPrice as string | null,
        taxRate: (d.taxRate as string | null) ?? '0',
        supplierId: d.supplierId as string | null,
        warranty: d.warranty as string | null,
        reorderLevel: (d.reorderLevel as string | null) ?? '0',
        description: d.description as string | null,
        isActive: d.active as boolean,
      };
      if (!item.existingId) {
        await tx.product.create({ data: { ...data, stock: { create: {} } } });
        return;
      }
      const before = await tx.product.findUniqueOrThrow({ where: { id: item.existingId } });
      await tx.product.update({ where: { id: item.existingId }, data });
      for (const field of ['costPrice', 'sellingPrice', 'minPrice', 'specialPrice'] as const) {
        const oldV = before[field];
        const newV = data[field];
        if ((oldV === null && newV === null) || (oldV !== null && newV !== null && D(oldV).equals(D(newV)))) continue;
        await tx.productPriceHistory.create({ data: { productId: item.existingId, field, oldValue: oldV, newValue: newV, changedBy: user.id, changedByName: `${user.name} (import)` } });
      }
      return;
    }
    if (entity === 'clients') {
      const { code: _c, ...data } = d as Prisma.ClientUncheckedCreateInput;
      if (item.existingId) await tx.client.update({ where: { id: item.existingId }, data });
      else await tx.client.create({ data: { ...data, code: await this.numbering.next(tx, 'CLIENT') } });
      return;
    }
    const { code: _c, ...data } = d as Prisma.VendorUncheckedCreateInput;
    if (item.existingId) await tx.vendor.update({ where: { id: item.existingId }, data });
    else await tx.vendor.create({ data: { ...data, code: await this.numbering.next(tx, 'VENDOR') } });
  }

  // ─────────── export ───────────

  async export(user: AuthUser, entity: string, q: { format: 'xlsx' | 'csv'; dateFrom?: string; dateTo?: string }) {
    if (!(EXPORT_ENTITIES as readonly string[]).includes(entity)) throw new BadRequestException(`Unknown export: ${entity}`);
    const can = (p: Permission) => hasPermission(user.permissions, p);
    const need = (p: Permission) => {
      if (!can(p)) throw new ForbiddenException(`Missing permission: ${p}`);
    };
    const range = dateRangeWhere(q);
    const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : '');
    const n = (v: Prisma.Decimal | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
    const col = (key: string, header: string, width?: number): Column => ({ key, header, width });

    const e = entity as ExportEntity;
    switch (e) {
      case 'clients': {
        need(P.CLIENT_VIEW);
        const rows = await this.prisma.client.findMany({ orderBy: { code: 'asc' } });
        return this.toFile('Clients', [col('code', 'Code'), col('name', 'Name', 30), col('companyName', 'Company', 25), col('contactPerson', 'Contact'), col('phone', 'Phone'), col('whatsapp', 'WhatsApp'), col('email', 'Email', 25), col('cnicNtn', 'CNIC/NTN'), col('billingAddress', 'Billing address', 40), col('type', 'Type'), col('status', 'Status'), col('notes', 'Notes', 30)], rows, q.format);
      }
      case 'sites': {
        need(P.SITE_VIEW);
        const rows = await this.prisma.site.findMany({ include: { client: true, manager: true }, orderBy: { code: 'asc' } });
        return this.toFile('Sites', [col('code', 'Code'), col('name', 'Site', 30), col('client', 'Client', 30), col('address', 'Address', 40), col('type', 'Type'), col('status', 'Status'), col('manager', 'Manager'), col('startDate', 'Start'), col('expectedCompletion', 'Expected completion')], rows.map((s) => ({ ...s, client: s.client.name, manager: s.manager?.name ?? '', startDate: d(s.startDate), expectedCompletion: d(s.expectedCompletion) })), q.format);
      }
      case 'products': {
        need(P.PRODUCT_VIEW);
        const cost = can(P.PRODUCT_COST_VIEW);
        const rows = await this.prisma.product.findMany({ include: { category: true, subcategory: true, supplier: true, stock: true }, orderBy: { sku: 'asc' } });
        return this.toFile(
          'Products',
          [col('sku', 'sku'), col('name', 'name', 30), col('brand', 'brand'), col('model', 'model'), col('category', 'category'), col('subcategory', 'subcategory'), col('unit', 'unit'), ...(cost ? [col('costPrice', 'costPrice')] : []), col('sellingPrice', 'sellingPrice'), col('minPrice', 'minPrice'), col('specialPrice', 'specialPrice'), col('taxRate', 'taxRate'), col('supplierCode', 'supplierCode'), col('warranty', 'warranty'), col('reorderLevel', 'reorderLevel'), col('onHand', 'onHand'), col('reserved', 'reserved'), col('active', 'active')],
          rows.map((p) => ({ ...p, category: p.category?.name ?? '', subcategory: p.subcategory?.name ?? '', costPrice: n(p.costPrice), sellingPrice: n(p.sellingPrice), minPrice: n(p.minPrice), specialPrice: n(p.specialPrice), taxRate: n(p.taxRate), reorderLevel: n(p.reorderLevel), supplierCode: p.supplier?.code ?? '', onHand: n(p.stock?.onHand), reserved: n(p.stock?.reserved), active: p.isActive ? 'yes' : 'no' })),
          q.format,
        );
      }
      case 'vendors': {
        need(P.VENDOR_VIEW);
        const rows = await this.prisma.vendor.findMany({ orderBy: { code: 'asc' } });
        return this.toFile('Vendors', [col('code', 'code'), col('name', 'name', 30), col('contactPerson', 'contactPerson'), col('phone', 'phone'), col('email', 'email', 25), col('address', 'address', 40), col('taxInfo', 'taxInfo'), col('paymentTerms', 'paymentTerms'), col('creditLimit', 'creditLimit'), col('status', 'status'), col('notes', 'notes', 30)], rows.map((v) => ({ ...v, creditLimit: n(v.creditLimit) })), q.format);
      }
      case 'quotations': {
        need(P.QUOTATION_VIEW);
        const rows = await this.prisma.quotation.findMany({ where: { createdAt: range }, include: { client: true, site: true, revisions: true }, orderBy: { createdAt: 'desc' } });
        return this.toFile(
          'Quotations',
          [col('number', 'Number'), col('date', 'Date'), col('client', 'Client', 25), col('site', 'Site', 25), col('type', 'Type'), col('status', 'Status'), col('revision', 'Rev'), col('subtotal', 'Subtotal'), col('discount', 'Discount'), col('tax', 'Tax'), col('charges', 'Charges'), col('total', 'Grand total'), col('validUntil', 'Valid until')],
          rows.map((x) => {
            const r = x.revisions.find((v) => v.revisionNo === x.currentRevisionNo)!;
            return { number: x.number, date: d(r.quotationDate), client: x.client.name, site: x.site.name, type: x.type, status: x.status, revision: x.currentRevisionNo, subtotal: n(r.subtotal), discount: n(D(r.itemDiscountTotal).plus(D(r.overallDiscount)).toString()), tax: n(r.taxTotal), charges: n(r.chargesTotal), total: n(r.grandTotal), validUntil: d(r.validUntil) };
          }),
          q.format,
        );
      }
      case 'projects': {
        need(P.PROJECT_VIEW);
        const rows = await this.prisma.project.findMany({ where: { startDate: range }, include: { client: true, site: true, allocations: { where: { status: 'POSTED' } } }, orderBy: { createdAt: 'desc' } });
        return this.toFile(
          'Projects',
          [col('number', 'Number'), col('name', 'Project', 30), col('client', 'Client', 25), col('site', 'Site', 25), col('status', 'Status'), col('startDate', 'Start'), col('contractValue', 'Contract value'), col('received', 'Received'), col('balance', 'Balance')],
          rows.map((p) => {
            const received = p.allocations.reduce((s, a) => s.plus(D(a.amount)), D(0));
            return { number: p.number, name: p.name, client: p.client.name, site: p.site.name, status: p.status, startDate: d(p.startDate), contractValue: n(p.contractValue), received: n(received.toString()), balance: n(D(p.contractValue).minus(received).toString()) };
          }),
          q.format,
        );
      }
      case 'invoices': {
        need(P.INVOICE_VIEW);
        const rows = await this.prisma.invoice.findMany({ where: { invoiceDate: range }, include: { client: true, project: true }, orderBy: { invoiceDate: "desc" } });
        return this.toFile('Invoices', [col('number', 'Number'), col('kind', 'Kind'), col('issueDate', 'Issue date'), col('dueDate', 'Due date'), col('client', 'Client', 25), col('project', 'Project'), col('status', 'Status'), col('total', 'Total'), col('paid', 'Paid'), col('balance', 'Balance')], rows.map((i) => ({ number: i.number, kind: i.kind, issueDate: d(i.invoiceDate), dueDate: d(i.dueDate), client: i.client.name, project: i.project.number, status: i.status, total: n(i.total), paid: n(i.paidAmount), balance: n(D(i.total).minus(D(i.paidAmount)).toString()) })), q.format);
      }
      case 'payments': {
        need(P.PAYMENT_VIEW);
        const rows = await this.prisma.payment.findMany({ where: { paidOn: range }, include: { client: true, allocations: { include: { project: true } } }, orderBy: { paidOn: 'desc' } });
        return this.toFile('Payments', [col('number', 'Number'), col('paidOn', 'Date'), col('client', 'Client', 25), col('method', 'Method'), col('reference', 'Reference'), col('amount', 'Amount'), col('allocated', 'Allocated'), col('projects', 'Projects', 30), col('status', 'Status')], rows.map((p) => ({ number: p.number, paidOn: d(p.paidOn), client: p.client.name, method: p.method, reference: p.reference ?? p.chequeNo ?? '', amount: n(p.amount), allocated: n(p.allocations.filter((a) => a.status === 'POSTED').reduce((s, a) => s.plus(D(a.amount)), D(0)).toString()), projects: [...new Set(p.allocations.map((a) => a.project.number))].join(', '), status: p.status })), q.format);
      }
      case 'expenses': {
        need(P.EXPENSE_VIEW);
        const rows = await this.prisma.expense.findMany({ where: { expenseDate: range }, include: { project: true, vendor: true }, orderBy: { expenseDate: 'desc' } });
        return this.toFile('Expenses', [col('number', 'Number'), col('expenseDate', 'Date'), col('category', 'Category'), col('description', 'Description', 35), col('project', 'Project'), col('vendor', 'Vendor'), col('method', 'Method'), col('amount', 'Amount'), col('status', 'Status')], rows.map((x) => ({ ...x, expenseDate: d(x.expenseDate), project: x.project?.number ?? '', vendor: x.vendor?.name ?? '', amount: n(x.amount) })), q.format);
      }
      case 'purchase-orders': {
        need(P.PURCHASE_VIEW);
        const rows = await this.prisma.purchaseOrder.findMany({ where: { orderDate: range }, include: { vendor: true, project: true }, orderBy: { orderDate: 'desc' } });
        return this.toFile('Purchase orders', [col('number', 'Number'), col('orderDate', 'Date'), col('vendor', 'Vendor', 25), col('project', 'Project'), col('status', 'Status'), col('expectedDate', 'Expected'), col('dueDate', 'Payment due'), col('total', 'Total')], rows.map((p) => ({ number: p.number, orderDate: d(p.orderDate), vendor: p.vendor.name, project: p.project?.number ?? '', status: p.status, expectedDate: d(p.expectedDelivery), dueDate: d(p.dueDate), total: n(p.total) })), q.format);
      }
      case 'stock': {
        need(P.INVENTORY_VIEW);
        const cost = can(P.PRODUCT_COST_VIEW);
        const rows = await this.prisma.product.findMany({ where: { isActive: true }, include: { stock: true }, orderBy: { sku: 'asc' } });
        return this.toFile('Stock', [col('sku', 'SKU'), col('name', 'Product', 30), col('onHand', 'On hand'), col('reserved', 'Reserved'), col('available', 'Available'), col('incoming', 'Incoming'), col('reorderLevel', 'Reorder level'), ...(cost ? [col('value', 'Stock value (cost)')] : [])], rows.map((p) => { const onHand = D(p.stock?.onHand); const reserved = D(p.stock?.reserved); return { sku: p.sku, name: p.name, onHand: n(qty(onHand)), reserved: n(qty(reserved)), available: n(qty(onHand.minus(reserved))), incoming: n(p.stock?.incoming), reorderLevel: n(p.reorderLevel), value: n(money(onHand.times(D(p.costPrice)))) }; }), q.format);
      }
      case 'receivables-aging':
      case 'payables-aging': {
        need(P.REPORT_VIEW);
        const rep = e === 'receivables-aging' ? await this.insights.receivablesAging() : await this.insights.payablesAging();
        const cols = [col('name', e === 'receivables-aging' ? 'Client' : 'Vendor', 30), col('current', 'Not due'), col('d0_30', '0-30'), col('d31_60', '31-60'), col('d61_90', '61-90'), col('d90plus', '90+'), col('total', 'Total')];
        const num = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'name' || k === 'partyId' ? v : Number(v)]));
        return this.toFile(e === 'receivables-aging' ? 'Receivables aging' : 'Payables aging', cols, [...rep.rows.map(num), num({ name: 'TOTAL', ...rep.totals })], q.format);
      }
      case 'product-sales': {
        need(P.REPORT_VIEW);
        const cost = can(P.PRODUCT_COST_VIEW);
        const rows = await this.insights.productSales(q);
        return this.toFile('Product sales', [col('sku', 'SKU'), col('name', 'Product', 30), col('category', 'Category'), col('qty', 'Qty'), col('revenue', 'Revenue'), ...(cost ? [col('cost', 'Cost'), col('margin', 'Margin'), col('marginPct', 'Margin %')] : []), col('projects', 'Projects')], rows.map((r) => ({ ...r, qty: Number(r.qty), revenue: Number(r.revenue), cost: Number(r.cost), margin: Number(r.margin), marginPct: Number(r.marginPct) })), q.format);
      }
      case 'project-profitability': {
        need(P.REPORT_VIEW);
        need(P.PRODUCT_COST_VIEW);
        const rep = await this.insights.profitability({ page: 1, pageSize: 10_000, status: 'ALL' });
        return this.toFile('Project profitability', [col('number', 'Project'), col('name', 'Name', 30), col('client', 'Client', 25), col('status', 'Status'), col('contractValue', 'Contract'), col('revenueExTax', 'Revenue ex tax'), col('productCost', 'Product cost'), col('otherCosts', 'Other costs'), col('estimatedProfit', 'Profit'), col('estimatedMargin', 'Margin %'), col('received', 'Received')], rep.rows.map((r) => ({ ...r, contractValue: Number(r.contractValue), revenueExTax: Number(r.revenueExTax), productCost: Number(r.productCost), otherCosts: Number(r.otherCosts), estimatedProfit: Number(r.estimatedProfit), estimatedMargin: Number(r.estimatedMargin), received: Number(r.received) })), q.format);
      }
    }
  }
}
