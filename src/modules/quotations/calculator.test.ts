import { describe, expect, it } from 'vitest';
import { calculateQuotation, CalculationError, ProductPricing } from './calculator';

const products = new Map<string, ProductPricing>(
  [
    { id: 'sw', sku: 'SW-1', name: 'Smart Switch', unit: 'PIECE', sellingPrice: '15000', costPrice: '10000', minPrice: '13000', taxRate: '0' },
    { id: 'dm', sku: 'DM-1', name: 'Dimmer', unit: 'PIECE', sellingPrice: '12000', costPrice: '8000', minPrice: null, taxRate: '0' },
    { id: 'ms', sku: 'MS-1', name: 'Motion Sensor', unit: 'PIECE', sellingPrice: '8000', costPrice: '5000', minPrice: null, taxRate: '0' },
    { id: 'tx', sku: 'TX-1', name: 'Taxed Item', unit: 'PIECE', sellingPrice: '1000', costPrice: '600', minPrice: null, taxRate: '17' },
  ].map((p) => [p.id, p]),
);

describe('calculateQuotation', () => {
  it('computes a product-based quotation (document example)', () => {
    const r = calculateQuotation(
      {
        type: 'PRODUCT',
        items: [
          { productId: 'sw', qty: 20 },
          { productId: 'dm', qty: 10 },
          { productId: 'ms', qty: 8 },
        ],
      },
      products,
    );
    expect(r.subtotal.toFixed(2)).toBe('484000.00');
    expect(r.grandTotal.toFixed(2)).toBe('484000.00');
    expect(r.costTotal.toFixed(2)).toBe('320000.00');
  });

  it('aggregates products across spaces for site-division quotations', () => {
    const r = calculateQuotation(
      {
        type: 'SITE_DIVISION',
        spaces: [
          { name: 'Living Room', items: [{ productId: 'sw', qty: 6 }, { productId: 'dm', qty: 4 }, { productId: 'ms', qty: 2 }] },
          { name: 'Master Bedroom', items: [{ productId: 'sw', qty: 5 }] },
          { name: 'Kitchen', items: [{ productId: 'sw', qty: 4 }, { productId: 'ms', qty: 1 }] },
        ],
      },
      products,
    );
    const sw = r.summary.find((s) => s.productId === 'sw')!;
    expect(sw.qty.toString()).toBe('15');
    expect(sw.total.toFixed(2)).toBe('225000.00');
    expect(r.summary.find((s) => s.productId === 'dm')!.qty.toString()).toBe('4');
    expect(r.summary.find((s) => s.productId === 'ms')!.qty.toString()).toBe('3');
    expect(r.spaces.map((s) => s.subtotal.toFixed(2))).toEqual(['154000.00', '75000.00', '68000.00']);
  });

  it('applies item + overall discounts, tax on discounted base, and charges', () => {
    const r = calculateQuotation(
      {
        type: 'PRODUCT',
        items: [{ productId: 'tx', qty: 10, discountType: 'PERCENT', discountValue: 10 }],
        overallDiscountType: 'FIXED',
        overallDiscountValue: 900,
        charges: [{ kind: 'INSTALLATION', amount: 5000 }],
      },
      products,
    );
    // gross 10000, item disc 1000, net 9000, overall 900 → taxable 8100 × 17% = 1377
    expect(r.subtotal.toFixed(2)).toBe('10000.00');
    expect(r.itemDiscountTotal.toFixed(2)).toBe('1000.00');
    expect(r.overallDiscount.toFixed(2)).toBe('900.00');
    expect(r.taxTotal.toFixed(2)).toBe('1377.00');
    expect(r.grandTotal.toFixed(2)).toBe('14477.00');
  });

  it('splits payment schedule so milestones sum exactly to grand total', () => {
    const r = calculateQuotation(
      {
        type: 'PRODUCT',
        items: [{ productId: 'ms', qty: 1, unitPrice: '1000.01' }],
        paymentSchedule: [
          { name: 'Advance', percent: 33.33 },
          { name: 'Middle', percent: 33.33 },
          { name: 'Final', percent: 33.34 },
        ],
      },
      products,
    );
    const total = r.milestones.reduce((a, m) => a.plus(m.amount), r.milestones[0].amount.minus(r.milestones[0].amount));
    expect(total.toFixed(2)).toBe(r.grandTotal.toFixed(2));
  });

  it('rejects schedules that do not total 100%', () => {
    expect(() =>
      calculateQuotation({ type: 'PRODUCT', items: [{ productId: 'ms', qty: 1 }], paymentSchedule: [{ name: 'A', percent: 50 }] }, products),
    ).toThrow(CalculationError);
  });

  it('flags price overrides and below-minimum prices', () => {
    const r = calculateQuotation({ type: 'PRODUCT', items: [{ productId: 'sw', qty: 1, unitPrice: 12000 }] }, products);
    expect(r.lines[0].priceOverridden).toBe(true);
    expect(r.lines[0].belowMinimum).toBe(true);
    expect(r.warnings.length).toBe(1);
  });

  it('never uses floating point (0.1 + 0.2 style inputs)', () => {
    const r = calculateQuotation({ type: 'PRODUCT', items: [{ productId: 'ms', qty: 3, unitPrice: '0.10' }, { productId: 'dm', qty: 1, unitPrice: '0.20' }] }, products);
    expect(r.grandTotal.toFixed(2)).toBe('0.50');
  });
});
