import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from './prisma.service';

export interface CompanySettings {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  taxInfo?: string;
  logoKey?: string;
}

export interface QuotationSettings {
  validityDays: number;
  defaultTerms: Record<string, string>;
  defaultPaymentSchedule: { name: string; percent: number }[];
}

export interface AccountingSettings {
  /** When the receivable is booked: at quotation approval (default) or when invoices are issued. */
  receivableOn: 'APPROVAL' | 'INVOICE';
  defaultTaxRate: number;
}

export interface InvoiceSettings {
  dueDays: number;
  footerNote?: string;
}

export const SETTING_DEFAULTS = {
  company: { name: 'Automation Company', address: '', phone: '', email: '', website: '', taxInfo: '' } as CompanySettings,
  quotation: {
    validityDays: 15,
    defaultTerms: {
      paymentTerms: 'As per payment schedule.',
      validity: 'This quotation is valid for 15 days from the date of issue.',
      warranty: 'Products carry manufacturer warranty. Workmanship warranty 1 year.',
      installation: 'Installation assumes wiring and back boxes are ready as per drawings.',
      availability: 'Subject to product availability at time of order.',
      delivery: 'Delivery within 2-4 weeks from advance payment.',
      exclusions: 'Civil work, electrical wiring and networking not included unless specified.',
      taxes: 'Taxes as applicable.',
      cancellation: 'Advance payment is non-refundable after procurement is initiated.',
    },
    defaultPaymentSchedule: [
      { name: 'Advance', percent: 30 },
      { name: 'Procurement', percent: 40 },
      { name: 'Installation', percent: 20 },
      { name: 'Handover', percent: 10 },
    ],
  } as QuotationSettings,
  accounting: { receivableOn: 'APPROVAL', defaultTaxRate: 0 } as AccountingSettings,
  invoice: { dueDays: 7, footerNote: '' } as InvoiceSettings,
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get<K extends SettingKey>(key: K, tx?: Tx): Promise<(typeof SETTING_DEFAULTS)[K]> {
    const row = await (tx ?? this.prisma).setting.findUnique({ where: { key } });
    return { ...SETTING_DEFAULTS[key], ...((row?.value as object) ?? {}) } as (typeof SETTING_DEFAULTS)[K];
  }

  async set<K extends SettingKey>(key: K, value: Partial<(typeof SETTING_DEFAULTS)[K]>) {
    const merged = { ...(await this.get(key)), ...value };
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value: merged as Prisma.InputJsonValue },
      update: { value: merged as Prisma.InputJsonValue },
    });
    return merged;
  }

  async getRaw(key: string) {
    return (await this.prisma.setting.findUnique({ where: { key } }))?.value ?? null;
  }

  async setRaw(key: string, value: Prisma.InputJsonValue) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}
