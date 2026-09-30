import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Invoice, InvoiceStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, Decimal, money, qty, round2, sum } from '../../common/money';
import { dateRangeWhere, pageArgs, pageMeta } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { ACCOUNTS, JournalService } from '../../infra/journal.service';
import { NumberingService } from '../../infra/numbering.service';
import { fmtDate, PdfService, pkr } from '../../infra/pdf.service';
import { PrismaService, Tx } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { recomputeMilestones } from '../projects/project-finance';
import { CreateInvoiceDto, InvoiceQueryDto } from './finance.schemas';

const include = {
  client: { select: { id: true, name: true, code: true } },
  project: { select: { id: true, number: true, name: true, site: { select: { id: true, name: true, code: true } } } },
  milestone: { select: { id: true, name: true } },
  items: true,
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof include }>;

/** Overdue is derived at read time so it never goes stale. */
export function effectiveStatus(inv: Pick<Invoice, 'status' | 'dueDate'>): InvoiceStatus {
  if (['ISSUED', 'PARTIALLY_PAID'].includes(inv.status) && inv.dueDate && inv.dueDate < new Date(new Date().toISOString().slice(0, 10))) {
    return 'OVERDUE';
  }
  return inv.status;
}

export function invoiceStatusFor(total: Decimal, paid: Decimal): InvoiceStatus {
  if (paid.gte(total)) return 'PAID';
  if (paid.gt(0)) return 'PARTIALLY_PAID';
  return 'ISSUED';
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly settings: SettingsService,
    private readonly pdf: PdfService,
  ) {}

  present(inv: InvoiceRow) {
    return {
      id: inv.id,
      number: inv.number,
      kind: inv.kind as 'MILESTONE' | 'BALANCE' | 'ADDITIONAL',
      status: effectiveStatus(inv),
      invoiceDate: inv.invoiceDate.toISOString(),
      dueDate: inv.dueDate?.toISOString() ?? null,
      subtotal: money(inv.subtotal),
      discount: money(inv.discount),
      tax: money(inv.tax),
      total: money(inv.total),
      paidAmount: money(inv.paidAmount),
      balance: money(D(inv.total).minus(D(inv.paidAmount))),
      notes: inv.notes,
      client: inv.client,
      project: { id: inv.project.id, number: inv.project.number, name: inv.project.name },
      site: inv.project.site,
      milestone: inv.milestone,
      items: inv.items.map((i) => ({ id: i.id, description: i.description, qty: qty(i.qty), unitPrice: money(i.unitPrice), lineTotal: money(i.lineTotal) })),
      createdAt: inv.createdAt.toISOString(),
    };
  }

  async list(q: InvoiceQueryDto) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const statusWhere: Prisma.InvoiceWhereInput =
      q.status === 'OVERDUE'
        ? { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lt: today } }
        : q.status
          ? { status: q.status }
          : {};
    const where: Prisma.InvoiceWhereInput = {
      clientId: q.clientId,
      projectId: q.projectId,
      invoiceDate: dateRangeWhere(q),
      ...statusWhere,
      ...(q.q
        ? { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { client: { name: { contains: q.q, mode: 'insensitive' } } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, include, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.invoice.count({ where }),
    ]);
    return { data: rows.map((r) => ({ ...this.present(r), items: undefined })), meta: pageMeta(q, total) };
  }

  async get(id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id }, include });
    if (!inv) throw new NotFoundException('Invoice not found');
    return this.present(inv);
  }

  async create(user: AuthUser, body: CreateInvoiceDto) {
    const invSettings = await this.settings.get('invoice');
    const id = await this.prisma.tx(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: body.projectId }, include: { quotation: true } });
      if (!project) throw new NotFoundException('Project not found');
      if (project.status === 'CANCELLED') throw new BadRequestException('Project is cancelled');

      let lines: { description: string; qty: Decimal; unitPrice: Decimal; productId?: string }[] = [];
      let milestoneId: string | undefined;

      const alreadyBilled = await tx.invoice.aggregate({
        where: { projectId: project.id, kind: { in: ['MILESTONE', 'BALANCE'] }, status: { not: 'CANCELLED' } },
        _sum: { total: true },
      });
      const remainingContract = D(project.contractValue).minus(D(alreadyBilled._sum.total));

      if (body.kind === 'MILESTONE') {
        if (!body.milestoneId) throw new BadRequestException('Select a payment milestone');
        const m = await tx.paymentMilestone.findUnique({ where: { id: body.milestoneId }, include: { invoice: true } });
        if (!m || m.projectId !== project.id) throw new NotFoundException('Milestone not found');
        if (m.invoice && m.invoice.status !== 'CANCELLED') throw new BadRequestException(`Milestone already invoiced (${m.invoice.number})`);
        if (m.invoice) await tx.invoice.update({ where: { id: m.invoice.id }, data: { milestoneId: null } });
        milestoneId = m.id;
        lines = [{ description: `${m.name} (${D(m.percent).toString()}%) — ${project.number}, ${project.quotation.number}`, qty: D(1), unitPrice: D(m.amount) }];
      } else if (body.kind === 'BALANCE') {
        if (remainingContract.lte(0)) throw new BadRequestException('The full contract value has already been invoiced');
        lines = [{ description: `Balance of contract value — ${project.number}, ${project.quotation.number}`, qty: D(1), unitPrice: remainingContract }];
      } else {
        if (!body.items?.length) throw new BadRequestException('Add at least one line for an additional invoice');
        lines = body.items.map((i) => ({ description: i.description, qty: D(i.qty), unitPrice: D(i.unitPrice), productId: i.productId }));
      }

      const lineTotals = lines.map((l) => round2(l.qty.times(l.unitPrice)));
      const subtotal = sum(lineTotals);
      const discount = round2(body.discount ?? 0);
      if (discount.gt(subtotal)) throw new BadRequestException('Discount exceeds subtotal');
      const tax = body.kind === 'ADDITIONAL' ? round2(subtotal.minus(discount).times(D(body.taxRate ?? 0)).div(100)) : D(0);
      const total = subtotal.minus(discount).plus(tax);
      if (total.lte(0)) throw new BadRequestException('Invoice total must be greater than zero');
      if (body.kind !== 'ADDITIONAL' && total.gt(remainingContract)) {
        throw new BadRequestException(`Invoice exceeds un-billed contract value (PKR ${money(remainingContract)})`);
      }

      const invoiceDate = body.invoiceDate ?? new Date(new Date().toISOString().slice(0, 10));
      const inv = await tx.invoice.create({
        data: {
          number: await this.numbering.next(tx, 'INVOICE', invoiceDate),
          kind: body.kind,
          clientId: project.clientId,
          projectId: project.id,
          milestoneId,
          invoiceDate,
          dueDate: body.dueDate === undefined ? new Date(invoiceDate.getTime() + invSettings.dueDays * 86400_000) : body.dueDate,
          subtotal: money(subtotal),
          discount: money(discount),
          tax: money(tax),
          total: money(total),
          notes: body.notes,
          createdBy: user.id,
          items: {
            create: lines.map((l, i) => ({ description: l.description, qty: qty(l.qty), unitPrice: money(l.unitPrice), lineTotal: money(lineTotals[i]), productId: l.productId })),
          },
        },
      });
      await this.audit.log(user, { action: 'invoice.created', entityType: 'Invoice', entityId: inv.id, summary: `${inv.number} (${body.kind}) PKR ${money(total)} for ${project.number}` }, tx);
      if (body.issue) await this.issueInTx(tx, user, inv.id);
      return inv.id;
    });
    return this.get(id);
  }

  private async issueInTx(tx: Tx, user: AuthUser, id: string) {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { project: true } });
    if (inv.status !== 'DRAFT') throw new BadRequestException('Only draft invoices can be issued');
    const accounting = await this.settings.get('accounting', tx);
    const postsReceivable = inv.kind === 'ADDITIONAL' || accounting.receivableOn === 'INVOICE';
    if (postsReceivable) {
      const dims = { clientId: inv.clientId, siteId: inv.project.siteId, projectId: inv.projectId };
      await this.journal.post(tx, {
        date: inv.invoiceDate,
        description: `Invoice ${inv.number} issued`,
        sourceType: 'INVOICE',
        sourceId: inv.id,
        reference: inv.number,
        createdBy: user.id,
        lines: [
          { account: ACCOUNTS.AR, debit: inv.total, ...dims },
          { account: inv.kind === 'ADDITIONAL' ? ACCOUNTS.OTHER_INCOME : ACCOUNTS.SALES, credit: D(inv.total).minus(D(inv.tax)), ...dims },
          { account: ACCOUNTS.TAX_PAYABLE, credit: inv.tax, ...dims },
        ],
      });
    }
    const paid = D(inv.paidAmount);
    await tx.invoice.update({ where: { id }, data: { status: paid.gt(0) ? invoiceStatusFor(D(inv.total), paid) : 'ISSUED' } });
    if (inv.milestoneId && inv.dueDate) {
      await tx.paymentMilestone.updateMany({ where: { id: inv.milestoneId, dueDate: null }, data: { dueDate: inv.dueDate } });
    }
    await recomputeMilestones(tx, inv.projectId);
    await this.audit.log(user, { action: 'invoice.issued', entityType: 'Invoice', entityId: id, summary: `${inv.number} issued` }, tx);
  }

  async issue(user: AuthUser, id: string) {
    await this.prisma.tx((tx) => this.issueInTx(tx, user, id));
    return this.get(id);
  }

  async cancel(user: AuthUser, id: string, reason: string) {
    await this.prisma.tx(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id } });
      if (!inv) throw new NotFoundException('Invoice not found');
      if (inv.status === 'CANCELLED') throw new BadRequestException('Invoice already cancelled');
      if (D(inv.paidAmount).gt(0)) throw new BadRequestException('Invoice has payments; void or reallocate them first');
      await this.journal.reverseSource(tx, 'INVOICE', id, reason, user.id);
      await tx.invoice.update({ where: { id }, data: { status: 'CANCELLED', notes: [inv.notes, `Cancelled: ${reason}`].filter(Boolean).join('\n') } });
      await recomputeMilestones(tx, inv.projectId);
      await this.audit.log(user, { action: 'invoice.cancelled', entityType: 'Invoice', entityId: id, summary: `${inv.number} cancelled: ${reason}` }, tx);
    });
    return this.get(id);
  }

  async renderPdf(id: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: { ...include, client: true, project: { include: { site: true, quotation: true } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    const [company, invSettings] = await Promise.all([this.settings.get('company'), this.settings.get('invoice')]);
    const totals: [string, string, boolean?][] = [['Subtotal', pkr(inv.subtotal)]];
    if (D(inv.discount).gt(0)) totals.push(['Discount', `- ${pkr(inv.discount)}`]);
    if (D(inv.tax).gt(0)) totals.push(['Tax', pkr(inv.tax)]);
    totals.push(['Total (PKR)', pkr(inv.total), true]);
    if (D(inv.paidAmount).gt(0)) {
      totals.push(['Paid', `- ${pkr(inv.paidAmount)}`], ['Balance Due', pkr(D(inv.total).minus(D(inv.paidAmount))), true]);
    }
    const buffer = await this.pdf.render({
      info: { title: inv.number },
      content: [
        this.pdf.header(company, 'INVOICE', [
          ['Invoice #', inv.number],
          ['Date', fmtDate(inv.invoiceDate)],
          ['Due Date', fmtDate(inv.dueDate)],
          ['Status', effectiveStatus(inv)],
        ]),
        {
          columns: [
            { stack: [{ text: 'Bill To', style: 'h2' }, { text: inv.client.name, bold: true }, inv.client.companyName ?? '', inv.client.billingAddress ?? '', inv.client.phone ?? ''] },
            { stack: [{ text: 'Project', style: 'h2' }, `${inv.project.number} — ${inv.project.name}`, `Site: ${inv.project.site.name}`, `Quotation: ${inv.project.quotation.number}`] },
          ],
        },
        { text: ' ' },
        this.pdf.table(
          ['#', 'Description', 'Qty', 'Unit Price', 'Amount'],
          inv.items.map((i, n) => [String(n + 1), i.description, D(i.qty).toString(), pkr(i.unitPrice), pkr(i.lineTotal)]),
          [16, '*', 40, 80, 90],
          2,
        ),
        this.pdf.totals(totals),
        inv.notes ? { text: inv.notes, margin: [0, 12, 0, 0] } : '',
        invSettings.footerNote ? { text: invSettings.footerNote, style: 'muted', margin: [0, 12, 0, 0] } : '',
      ],
    });
    return { buffer, fileName: `${inv.number}.pdf` };
  }
}
