import { Injectable } from '@nestjs/common';
import type { Content } from 'pdfmake/interfaces';
import { D, money } from '../../common/money';
import { fmtDate, PdfService, pkr } from '../../infra/pdf.service';
import { SettingsService } from '../../infra/settings.service';
import { QuotationsService } from './quotations.service';

const TERM_LABELS: Record<string, string> = {
  paymentTerms: 'Payment Terms',
  validity: 'Validity',
  warranty: 'Warranty',
  installation: 'Installation Conditions',
  availability: 'Product Availability',
  delivery: 'Delivery Timeline',
  exclusions: 'Exclusions',
  taxes: 'Taxes',
  cancellation: 'Cancellation',
};

@Injectable()
export class QuotationPdfService {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly pdf: PdfService,
    private readonly settings: SettingsService,
  ) {}

  async render(id: string, revisionNo?: number) {
    const { qt, rev } = await this.quotations.load(id, revisionNo);
    const { calc, spaceNames } = QuotationsService.calcStored(qt.type, rev);
    const company = await this.settings.get('company');
    const number = rev.revisionNo > 1 ? `${qt.number} Rev ${rev.revisionNo}` : qt.number;

    const itemTable = (lines: typeof calc.lines) =>
      this.pdf.table(
        ['#', 'Product', 'Qty', 'Unit Price', 'Discount', 'Tax', 'Total'],
        lines.map((l, i) => [
          String(i + 1),
          { text: [{ text: l.name, bold: true }, `\n${l.sku}${l.description ? ` — ${l.description}` : ''}`] },
          D(l.qty).toString(),
          pkr(l.unitPrice),
          l.discountAmount.isZero() ? '-' : pkr(l.discountAmount),
          l.taxAmount.isZero() ? '-' : pkr(l.taxAmount),
          pkr(l.lineTotal),
        ]),
        [16, '*', 36, 60, 50, 45, 65],
        2,
      );

    const body: Content[] = [
      this.pdf.header(company, 'QUOTATION', [
        ['Quotation #', number],
        ['Date', fmtDate(rev.quotationDate)],
        ['Valid Until', fmtDate(rev.validUntil)],
        ['Type', qt.type === 'PRODUCT' ? 'Product Based' : 'Site Division'],
      ]),
      {
        columns: [
          {
            stack: [
              { text: 'Client', style: 'h2' },
              { text: qt.client.name, bold: true },
              qt.client.companyName ?? '',
              qt.client.contactPerson ? `Attn: ${qt.client.contactPerson}` : '',
              [qt.client.phone, qt.client.email].filter(Boolean).join('  |  '),
              qt.client.billingAddress ?? '',
            ],
          },
          {
            stack: [
              { text: 'Site', style: 'h2' },
              { text: qt.site.name, bold: true },
              qt.site.address ?? '',
              `Site type: ${qt.site.type.toLowerCase()}`,
            ],
          },
        ],
      },
    ];

    if (qt.type === 'SITE_DIVISION') {
      spaceNames.forEach((name, i) => {
        const lines = calc.lines.filter((l) => l.spaceIndex === i);
        if (!lines.length) return;
        body.push({ text: name, style: 'h2' }, itemTable(lines));
      });
      body.push(
        { text: 'Product Summary', style: 'h2' },
        this.pdf.table(
          ['Product', 'SKU', 'Total Qty', 'Unit Price', 'Total'],
          calc.summary.map((s) => [s.name, s.sku, D(s.qty).toString(), pkr(s.unitPrice), pkr(s.total)]),
          ['*', 70, 50, 70, 80],
          2,
        ),
      );
    } else {
      body.push({ text: 'Products', style: 'h2' }, itemTable(calc.lines));
    }

    const totals: [string, string, boolean?][] = [['Subtotal', pkr(calc.subtotal)]];
    if (!calc.itemDiscountTotal.isZero()) totals.push(['Item Discounts', `- ${pkr(calc.itemDiscountTotal)}`]);
    if (!calc.overallDiscount.isZero()) totals.push(['Overall Discount', `- ${pkr(calc.overallDiscount)}`]);
    if (!calc.taxTotal.isZero()) totals.push(['Tax', pkr(calc.taxTotal)]);
    for (const c of calc.charges) totals.push([c.label, pkr(c.amount)]);
    totals.push(['Grand Total (PKR)', pkr(calc.grandTotal), true]);
    body.push(this.pdf.totals(totals));

    if (calc.milestones.length) {
      body.push(
        { text: 'Payment Schedule', style: 'h2' },
        this.pdf.table(
          ['Milestone', '%', 'Amount (PKR)'],
          calc.milestones.map((m) => [m.name, `${m.percent.toString()}%`, pkr(m.amount)]),
          ['*', 50, 100],
          1,
        ),
      );
    }

    const terms = Object.entries((rev.terms ?? {}) as Record<string, string>).filter(([, v]) => v?.trim());
    if (terms.length) {
      body.push(
        { text: 'Terms & Conditions', style: 'h2' },
        { ol: terms.map(([k, v]) => ({ text: [{ text: `${TERM_LABELS[k] ?? k}: `, bold: true }, v] })), margin: [0, 0, 0, 8] },
      );
    }
    if (rev.notes) body.push({ text: 'Notes', style: 'h2' }, rev.notes);

    body.push({
      margin: [0, 40, 0, 0],
      columns: [
        { stack: [{ text: '_____________________________' }, { text: 'Authorized Signature', bold: true }, company.name] },
        { stack: [{ text: '_____________________________' }, { text: 'Client Acceptance', bold: true }, 'Name / Signature / Date'], alignment: 'right' },
      ],
    });

    const buffer = await this.pdf.render({ content: body, info: { title: number } });
    return { buffer, fileName: `${number.replace(/\s+/g, '-')}.pdf`, total: money(calc.grandTotal) };
  }
}
