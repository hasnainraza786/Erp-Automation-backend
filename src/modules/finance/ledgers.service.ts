import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { D, Decimal, money } from '../../common/money';
import { ACCOUNTS } from '../../infra/journal.service';
import { fmtDate, PdfService, pkr } from '../../infra/pdf.service';
import { PrismaService } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { LedgerQueryDto } from './finance.schemas';

interface Entry {
  entryId: string;
  date: string;
  reference: string | null;
  entryNumber: string;
  description: string;
  sourceType: string;
  sourceId: string | null;
  site: string | null;
  project: string | null;
  debit: string;
  credit: string;
  balance: string;
}

/**
 * Ledgers are views over journal lines — balances are always derived, never stored.
 * Client ledger: AR account (debit = owed by client). Vendor ledger: AP account, shown as
 * debit = purchases, credit = payments, balance = amount owed to the vendor.
 */
@Injectable()
export class LedgersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly settings: SettingsService,
  ) {}

  private async build(accountCode: string, where: Prisma.JournalLineWhereInput, q: LedgerQueryDto, invert: boolean) {
    const account = await this.prisma.account.findUniqueOrThrow({ where: { code: accountCode } });
    const from = q.dateFrom ? new Date(q.dateFrom + 'T00:00:00.000Z') : undefined;
    const to = q.dateTo ? new Date(q.dateTo + 'T23:59:59.999Z') : undefined;
    const base: Prisma.JournalLineWhereInput = { accountId: account.id, ...where };

    const opening = from
      ? await this.prisma.journalLine.aggregate({ where: { ...base, entry: { entryDate: { lt: from } } }, _sum: { debit: true, credit: true } })
      : null;
    const sign = (debit: Decimal, credit: Decimal) => (invert ? credit.minus(debit) : debit.minus(credit));
    const openingBalance = opening ? sign(D(opening._sum.debit), D(opening._sum.credit)) : new Decimal(0);

    const lines = await this.prisma.journalLine.findMany({
      where: { ...base, entry: { entryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } },
      include: {
        entry: true,
        site: { select: { name: true } },
        project: { select: { number: true } },
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { createdAt: 'asc' } }],
    });

    // One row per journal entry: split payments show once in the master ledger with all their sites.
    const grouped = new Map<string, { entry: (typeof lines)[number]['entry']; debit: Decimal; credit: Decimal; sites: Set<string>; projects: Set<string> }>();
    for (const l of lines) {
      const g = grouped.get(l.entryId) ?? { entry: l.entry, debit: new Decimal(0), credit: new Decimal(0), sites: new Set(), projects: new Set() };
      g.debit = g.debit.plus(D(l.debit));
      g.credit = g.credit.plus(D(l.credit));
      if (l.site) g.sites.add(l.site.name);
      if (l.project) g.projects.add(l.project.number);
      grouped.set(l.entryId, g);
    }

    let running = openingBalance;
    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    const entries: Entry[] = [];
    for (const g of grouped.values()) {
      // Net within the entry (e.g. an allocation moves money between projects of the same client).
      const net = g.debit.minus(g.credit);
      if (net.isZero() && g.entry.sourceType === 'PAYMENT_ALLOCATION') continue;
      let debit = net.gt(0) ? net : new Decimal(0);
      let credit = net.lt(0) ? net.neg() : new Decimal(0);
      if (invert) [debit, credit] = [credit, debit];
      totalDebit = totalDebit.plus(debit);
      totalCredit = totalCredit.plus(credit);
      running = running.plus(debit).minus(credit);
      entries.push({
        entryId: g.entry.id,
        date: g.entry.entryDate.toISOString(),
        reference: g.entry.reference,
        entryNumber: g.entry.number,
        description: g.entry.description,
        sourceType: g.entry.sourceType,
        sourceId: g.entry.sourceId,
        site: g.sites.size ? [...g.sites].join(', ') : null,
        project: g.projects.size ? [...g.projects].join(', ') : null,
        debit: money(debit),
        credit: money(credit),
        balance: money(running),
      });
    }
    return {
      period: { from: q.dateFrom ?? null, to: q.dateTo ?? null },
      openingBalance: money(openingBalance),
      totalDebit: money(totalDebit),
      totalCredit: money(totalCredit),
      closingBalance: money(running),
      entries,
    };
  }

  async clientLedger(clientId: string, q: LedgerQueryDto) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException('Client not found');
    const ledger = await this.build(ACCOUNTS.AR, { clientId, siteId: q.siteId, projectId: q.projectId }, q, false);
    return { party: { id: client.id, name: client.name, code: client.code }, ...ledger };
  }

  async vendorLedger(vendorId: string, q: LedgerQueryDto) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    const ledger = await this.build(ACCOUNTS.AP, { vendorId }, q, true);
    return { party: { id: vendor.id, name: vendor.name, code: vendor.code }, ...ledger };
  }

  async statementPdf(kind: 'client' | 'vendor', id: string, q: LedgerQueryDto) {
    const ledger = kind === 'client' ? await this.clientLedger(id, q) : await this.vendorLedger(id, q);
    const company = await this.settings.get('company');
    let siteName: string | null = null;
    if (q.siteId) siteName = (await this.prisma.site.findUnique({ where: { id: q.siteId } }))?.name ?? null;
    const period = `${q.dateFrom ? fmtDate(q.dateFrom) : 'Beginning'} – ${q.dateTo ? fmtDate(q.dateTo) : fmtDate(new Date())}`;
    const chargesLabel = kind === 'client' ? 'Charges' : 'Purchases';

    const buffer = await this.pdf.render({
      info: { title: `Statement ${ledger.party.name}` },
      pageOrientation: 'portrait',
      content: [
        this.pdf.header(company, kind === 'client' ? 'CLIENT STATEMENT' : 'VENDOR STATEMENT', [
          [kind === 'client' ? 'Client' : 'Vendor', ledger.party.code],
          ['Period', period],
          ['Generated', fmtDate(new Date())],
        ]),
        { text: ledger.party.name + (siteName ? ` — ${siteName}` : ''), style: 'h2' },
        this.pdf.totals([
          ['Opening Balance', pkr(ledger.openingBalance)],
          [chargesLabel, pkr(ledger.totalDebit)],
          ['Payments', pkr(ledger.totalCredit)],
          [kind === 'client' ? 'Closing Balance' : 'Closing Payable', pkr(ledger.closingBalance), true],
        ]),
        { text: 'Transactions', style: 'h2' },
        this.pdf.table(
          ['Date', 'Reference', 'Description', ...(kind === 'client' ? ['Site'] : []), 'Debit', 'Credit', 'Balance'],
          [
            ['', '', { text: 'Opening balance', italics: true }, ...(kind === 'client' ? [''] : []), '', '', pkr(ledger.openingBalance)],
            ...ledger.entries.map((e) => [
              fmtDate(e.date),
              e.reference ?? e.entryNumber,
              e.description,
              ...(kind === 'client' ? [e.site ?? '-'] : []),
              D(e.debit).isZero() ? '-' : pkr(e.debit),
              D(e.credit).isZero() ? '-' : pkr(e.credit),
              pkr(e.balance),
            ]),
          ],
          kind === 'client' ? [52, 62, '*', 70, 58, 58, 64] : [55, 70, '*', 65, 65, 70],
          kind === 'client' ? 4 : 3,
        ),
      ],
    });
    return { buffer, fileName: `statement-${ledger.party.code}.pdf` };
  }
}
