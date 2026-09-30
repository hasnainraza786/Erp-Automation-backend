import { D, Decimal, round2, round3, sum, type DecimalInput } from '../../common/money';

export type DiscountKind = 'PERCENT' | 'FIXED';

export interface ItemInput {
  productId: string;
  qty: DecimalInput;
  unitPrice?: DecimalInput | null;
  discountType?: DiscountKind | null;
  discountValue?: DecimalInput | null;
  taxRate?: DecimalInput | null;
  description?: string | null;
  /** Values frozen on a saved revision; when present they replace the live catalog cost/flags. */
  stored?: { unitCost: DecimalInput; priceOverridden: boolean };
}

export interface ProductPricing {
  id: string;
  sku: string;
  name: string;
  unit: string;
  sellingPrice: DecimalInput;
  costPrice: DecimalInput;
  minPrice?: DecimalInput | null;
  taxRate: DecimalInput;
}

export interface ChargeInput {
  kind: 'INSTALLATION' | 'PROGRAMMING' | 'ENGINEERING' | 'TRANSPORTATION' | 'OTHER';
  label?: string | null;
  amount: DecimalInput;
}

export interface MilestoneInput {
  name: string;
  percent: DecimalInput;
}

export interface QuotationInput {
  type: 'PRODUCT' | 'SITE_DIVISION';
  items?: ItemInput[];
  spaces?: { name: string; items: ItemInput[] }[];
  overallDiscountType?: DiscountKind | null;
  overallDiscountValue?: DecimalInput | null;
  charges?: ChargeInput[];
  paymentSchedule?: MilestoneInput[];
}

export interface CalculatedLine {
  spaceIndex: number | null;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  description: string | null;
  qty: Decimal;
  unitPrice: Decimal;
  unitCost: Decimal;
  gross: Decimal;
  discountType: DiscountKind | null;
  discountValue: Decimal;
  discountAmount: Decimal;
  net: Decimal;
  taxRate: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
  priceOverridden: boolean;
  belowMinimum: boolean;
}

export interface CalculationResult {
  lines: CalculatedLine[];
  spaces: { name: string; subtotal: Decimal; itemCount: number }[];
  summary: { productId: string; sku: string; name: string; unit: string; qty: Decimal; unitPrice: Decimal; total: Decimal }[];
  subtotal: Decimal;
  itemDiscountTotal: Decimal;
  netItems: Decimal;
  overallDiscount: Decimal;
  taxTotal: Decimal;
  charges: { kind: ChargeInput['kind']; label: string; amount: Decimal }[];
  chargesTotal: Decimal;
  grandTotal: Decimal;
  costTotal: Decimal;
  milestones: { name: string; percent: Decimal; amount: Decimal }[];
  warnings: string[];
}

export class CalculationError extends Error {}

const CHARGE_LABELS: Record<ChargeInput['kind'], string> = {
  INSTALLATION: 'Installation Charges',
  PROGRAMMING: 'Programming Charges',
  ENGINEERING: 'Engineering Charges',
  TRANSPORTATION: 'Transportation',
  OTHER: 'Other Charges',
};

function discountOf(base: Decimal, type: DiscountKind | null | undefined, value: Decimal): Decimal {
  if (!type || value.isZero()) return new Decimal(0);
  if (value.isNegative()) throw new CalculationError('Discount cannot be negative');
  if (type === 'PERCENT') {
    if (value.gt(100)) throw new CalculationError('Percentage discount cannot exceed 100%');
    return round2(base.times(value).div(100));
  }
  if (value.gt(base)) throw new CalculationError('Fixed discount cannot exceed the amount it applies to');
  return round2(value);
}

/**
 * Authoritative quotation math. The server always recomputes with this function; totals sent by clients are ignored.
 *
 *   line gross    = qty × unit price
 *   line net      = gross − item discount (percent of gross, or fixed amount)
 *   subtotal      = Σ gross,  netItems = subtotal − Σ item discounts
 *   overall disc. = percent of netItems, or fixed amount (allocated to lines pro-rata for tax)
 *   tax           = Σ line net × (1 − overall/netItems) × tax rate
 *   grand total   = netItems − overall discount + tax + charges
 */
export function calculateQuotation(input: QuotationInput, products: Map<string, ProductPricing>): CalculationResult {
  const warnings: string[] = [];
  const groups: { spaceIndex: number | null; items: ItemInput[] }[] =
    input.type === 'SITE_DIVISION'
      ? (input.spaces ?? []).map((s, i) => ({ spaceIndex: i, items: s.items }))
      : [{ spaceIndex: null, items: input.items ?? [] }];

  const lines: CalculatedLine[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const product = products.get(item.productId);
      if (!product) throw new CalculationError(`Unknown product ${item.productId}`);
      const qty = round3(item.qty);
      if (qty.lte(0)) throw new CalculationError(`Quantity for ${product.name} must be greater than zero`);

      const listPrice = round2(product.sellingPrice);
      const unitPrice = item.unitPrice === undefined || item.unitPrice === null ? listPrice : round2(item.unitPrice);
      if (unitPrice.isNegative()) throw new CalculationError('Unit price cannot be negative');

      const gross = round2(qty.times(unitPrice));
      const discountValue = D(item.discountValue);
      const discountAmount = discountOf(gross, item.discountType, discountValue);
      const net = gross.minus(discountAmount);
      const taxRate = item.taxRate === undefined || item.taxRate === null ? D(product.taxRate) : D(item.taxRate);
      if (taxRate.isNegative() || taxRate.gt(100)) throw new CalculationError('Tax rate must be between 0 and 100');
      const taxAmount = round2(net.times(taxRate).div(100));

      const minPrice = product.minPrice === null || product.minPrice === undefined || item.stored ? null : D(product.minPrice);
      const effectiveUnit = net.div(qty);
      const belowMinimum = minPrice !== null && effectiveUnit.lt(minPrice);
      if (belowMinimum) warnings.push(`${product.name} is priced below its minimum selling price`);

      lines.push({
        spaceIndex: group.spaceIndex,
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        description: item.description ?? null,
        qty,
        unitPrice,
        unitCost: round2(item.stored ? item.stored.unitCost : product.costPrice),
        gross,
        discountType: item.discountType ?? null,
        discountValue: discountValue,
        discountAmount,
        net,
        taxRate,
        taxAmount,
        lineTotal: net.plus(taxAmount),
        priceOverridden: item.stored ? item.stored.priceOverridden : !unitPrice.equals(listPrice),
        belowMinimum,
      });
    }
  }

  const subtotal = sum(lines.map((l) => l.gross));
  const itemDiscountTotal = sum(lines.map((l) => l.discountAmount));
  const netItems = subtotal.minus(itemDiscountTotal);
  const overallDiscount = discountOf(netItems, input.overallDiscountType, D(input.overallDiscountValue));
  const keepRatio = netItems.isZero() ? new Decimal(1) : netItems.minus(overallDiscount).div(netItems);
  const taxTotal = round2(sum(lines.map((l) => l.net.times(keepRatio).times(l.taxRate).div(100))));

  const charges = (input.charges ?? [])
    .map((c) => ({ kind: c.kind, label: c.label?.trim() || CHARGE_LABELS[c.kind], amount: round2(c.amount) }))
    .filter((c) => !c.amount.isZero());
  if (charges.some((c) => c.amount.isNegative())) throw new CalculationError('Charges cannot be negative');
  const chargesTotal = sum(charges.map((c) => c.amount));

  const grandTotal = netItems.minus(overallDiscount).plus(taxTotal).plus(chargesTotal);
  const costTotal = round2(sum(lines.map((l) => l.qty.times(l.unitCost))));

  // Product aggregation across spaces (drives procurement)
  const agg = new Map<string, CalculationResult['summary'][number]>();
  for (const l of lines) {
    const existing = agg.get(l.productId);
    if (existing) {
      existing.qty = existing.qty.plus(l.qty);
      existing.total = existing.total.plus(l.net);
    } else {
      agg.set(l.productId, { productId: l.productId, sku: l.sku, name: l.name, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, total: l.net });
    }
  }
  const summary = [...agg.values()].map((s) => ({ ...s, unitPrice: s.qty.isZero() ? s.unitPrice : round2(s.total.div(s.qty)) }));

  const spaces = (input.type === 'SITE_DIVISION' ? input.spaces ?? [] : []).map((s, i) => ({
    name: s.name,
    subtotal: sum(lines.filter((l) => l.spaceIndex === i).map((l) => l.net)),
    itemCount: lines.filter((l) => l.spaceIndex === i).length,
  }));

  // Payment milestones: last milestone absorbs rounding so the schedule always equals the grand total.
  const schedule = input.paymentSchedule ?? [];
  const pctTotal = sum(schedule.map((m) => m.percent));
  if (schedule.length && !pctTotal.equals(100)) throw new CalculationError(`Payment schedule must total 100% (currently ${pctTotal.toString()}%)`);
  let allocated = new Decimal(0);
  const milestones = schedule.map((m, i) => {
    const percent = D(m.percent);
    const amount = i === schedule.length - 1 ? grandTotal.minus(allocated) : round2(grandTotal.times(percent).div(100));
    allocated = allocated.plus(amount);
    return { name: m.name, percent, amount };
  });

  return {
    lines,
    spaces,
    summary,
    subtotal,
    itemDiscountTotal,
    netItems,
    overallDiscount,
    taxTotal,
    charges,
    chargesTotal,
    grandTotal,
    costTotal,
    milestones,
    warnings,
  };
}
