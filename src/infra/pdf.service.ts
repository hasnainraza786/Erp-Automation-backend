import { Injectable } from '@nestjs/common';
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import { D } from '../common/money';
import { CompanySettings } from './settings.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PdfPrinter = require('pdfmake');

const printer = new PdfPrinter({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});

export const pkr = (v: unknown) =>
  D(v as string).toNumber().toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const fmtDate = (v: Date | string | null | undefined) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '-';

@Injectable()
export class PdfService {
  render(doc: TDocumentDefinitions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const pdf = printer.createPdfKitDocument({
        pageSize: 'A4',
        pageMargins: [36, 36, 36, 48],
        defaultStyle: { font: 'Helvetica', fontSize: 9 },
        styles: {
          h1: { fontSize: 16, bold: true },
          h2: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
          th: { bold: true, fillColor: '#eef2f7' },
          muted: { color: '#666666' },
        },
        footer: (page: number, pages: number) => ({
          text: `Page ${page} of ${pages}`,
          alignment: 'center',
          fontSize: 8,
          color: '#888888',
          margin: [0, 16, 0, 0],
        }),
        ...doc,
      });
      const chunks: Buffer[] = [];
      pdf.on('data', (c: Buffer) => chunks.push(c));
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);
      pdf.end();
    });
  }

  header(company: CompanySettings, title: string, meta: [string, string][]): Content {
    return {
      columns: [
        {
          width: '*',
          stack: [
            { text: company.name, style: 'h1' },
            { text: [company.address, company.phone, company.email, company.website].filter(Boolean).join('  |  '), style: 'muted' },
            company.taxInfo ? { text: company.taxInfo, style: 'muted' } : '',
          ],
        },
        {
          width: 200,
          stack: [
            { text: title, fontSize: 14, bold: true, alignment: 'right' },
            {
              table: {
                widths: ['*', 'auto'],
                body: meta.map(([k, v]) => [{ text: k, style: 'muted' }, { text: v, bold: true, alignment: 'right' }]),
              },
              layout: 'noBorders',
            },
          ],
        },
      ],
      margin: [0, 0, 0, 12],
    };
  }

  table(headers: string[], rows: TableCell[][], widths: (string | number)[], rightAlignFrom = headers.length): Content {
    return <Content>{
      table: {
        headerRows: 1,
        widths,
        body: [
          headers.map((h, i) => ({ text: h, style: 'th', alignment: i >= rightAlignFrom ? 'right' : 'left' })),
          ...rows.map((r) =>
            r.map((c, i) => (typeof c === 'string' && i >= rightAlignFrom ? { text: c, alignment: 'right' } : c)),
          ),
        ],
      },
      layout: 'lightHorizontalLines',
      margin: [0, 0, 0, 8],
    };
  }

  totals(rows: [string, string, boolean?][]): Content {
    return {
      columns: [
        { width: '*', text: '' },
        {
          width: 220,
          table: {
            widths: ['*', 'auto'],
            body: rows.map(([k, v, bold]) => [
              { text: k, bold: !!bold },
              { text: v, alignment: 'right', bold: !!bold },
            ]),
          },
          layout: 'lightHorizontalLines',
        },
      ],
    };
  }
}
