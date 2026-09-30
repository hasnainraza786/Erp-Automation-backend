/**
 * End-to-end business workflow against a running API (local, staging or production-like).
 *
 *   API_URL=http://localhost:4000 yarn test:e2e
 *
 * Creates its own vendor, products, client and site (unique per run), so it can run repeatedly.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api/v1';
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@erp.local';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345';
const RUN = Date.now().toString(36).toUpperCase();
const today = new Date().toISOString().slice(0, 10);

let token = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(method: string, path: string, body?: unknown, opts: { key?: string; expect?: number; raw?: boolean } = {}): Promise<Json> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  if (method === 'POST') headers['idempotency-key'] = opts.key ?? randomUUID();
  const res = await fetch(API + path, { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const expected = opts.expect ?? 200;
  if (res.status !== expected && !(expected === 200 && res.status === 201)) {
    throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  if (opts.raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const get = (p: string) => call('GET', p);
const post = (p: string, b?: unknown, o?: { key?: string; expect?: number }) => call('POST', p, b ?? {}, o);

const ids: Record<string, string> = {};

describe('ERP workflow', () => {
  beforeAll(async () => {
    const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    expect(res.status).toBeLessThan(300);
    token = (await res.json()).accessToken;
  });

  it('rejects unauthenticated requests with problem+json', async () => {
    const res = await fetch(`${API}/clients`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('creates master data', async () => {
    const vendor = await post('/vendors', { name: `E2E Vendor ${RUN}`, paymentTerms: '30 days' });
    ids.vendor = vendor.id;
    const a = await post('/products', { sku: `E2E-A-${RUN}`, name: `E2E Switch ${RUN}`, unit: 'PIECE', costPrice: 1000, sellingPrice: 1500, minPrice: 1400, taxRate: 0, supplierId: vendor.id });
    const b = await post('/products', { sku: `E2E-B-${RUN}`, name: `E2E Sensor ${RUN}`, unit: 'PIECE', costPrice: 500, sellingPrice: 800, taxRate: 0, supplierId: vendor.id });
    ids.productA = a.id;
    ids.productB = b.id;
    const client = await post('/clients', { name: `E2E Client ${RUN}`, phone: '0300-0000000', type: 'RESIDENTIAL' });
    ids.client = client.id;
    const site = await post('/sites', { clientId: client.id, name: `E2E Villa ${RUN}`, type: 'VILLA', address: 'Lahore' });
    ids.site = site.id;
    expect(client.code).toMatch(/^CL-/);
  });

  const content = () => ({
    type: 'SITE_DIVISION',
    spaces: [
      { name: 'Lounge', items: [{ productId: ids.productA, qty: 2 }, { productId: ids.productB, qty: 1 }] },
      { name: 'Master Bedroom', items: [{ productId: ids.productA, qty: 1 }] },
    ],
    charges: [{ kind: 'INSTALLATION', amount: 1000 }],
  });

  it('calculates, creates, sends and approves a site-division quotation', async () => {
    const calc = await post('/quotations/calculate', content());
    expect(calc.subtotal).toBe('5300.00');
    expect(calc.grandTotal).toBe('6300.00');
    expect(calc.costTotal).toBe('3500.00');
    expect(calc.summary.find((s: Json) => s.productId === ids.productA).qty).toBe('3.000');

    const q = await post('/quotations', { ...content(), clientId: ids.client, siteId: ids.site });
    ids.quotation = q.id;
    expect(q.number).toMatch(/^QT-\d{4}-\d+/);
    await post(`/quotations/${q.id}/send`);

    const pdf: Response = await call('GET', `/quotations/${q.id}/pdf`, undefined, { raw: true });
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');

    const key = randomUUID();
    const approved = await post(`/quotations/${q.id}/approve`, { approvedBy: 'Mr. Client', method: 'MANUAL' }, { key });
    const replay = await post(`/quotations/${q.id}/approve`, { approvedBy: 'Mr. Client', method: 'MANUAL' }, { key });
    expect(replay.projectId).toBe(approved.projectId);
    ids.project = approved.projectId;
    await post(`/quotations/${q.id}/approve`, { approvedBy: 'Again' }, { expect: 409 });
  });

  it('project carries contract value, items and milestones; receivable is booked', async () => {
    const p = await get(`/projects/${ids.project}`);
    expect(p.contractValue).toBe('6300.00');
    expect(p.items).toHaveLength(2);
    expect(p.milestones.map((m: Json) => m.amount)).toEqual(['1890.00', '2520.00', '1260.00', '630.00']);
    const ledger = await get(`/ledgers/clients/${ids.client}`);
    expect(ledger.closingBalance).toBe('6300.00');
  });

  it('purchases the shortage, receives and delivers', async () => {
    const proc = await get(`/projects/${ids.project}/procurement`);
    expect(proc.find((r: Json) => r.productId === ids.productA).toPurchase).toBe('3.000');
    const pos = await post('/purchase-orders/from-shortage', { projectId: ids.project });
    expect(pos).toHaveLength(1);
    ids.po = pos[0].id;
    expect(pos[0].total).toBe('3500.00');
    await post(`/purchase-orders/${ids.po}/send`);
    expect((await get(`/ledgers/vendors/${ids.vendor}`)).closingBalance).toBe('3500.00');

    const po = await get(`/purchase-orders/${ids.po}`);
    await post(`/purchase-orders/${ids.po}/receive`, { lines: po.items.map((i: Json) => ({ poItemId: i.id, qty: i.qty })) });
    expect((await get(`/purchase-orders/${ids.po}`)).status).toBe('RECEIVED');

    const project = await get(`/projects/${ids.project}`);
    const itemA = project.items.find((i: Json) => i.productId === ids.productA);
    expect(itemA.reservedQty).toBe('3.000');
    await post(`/projects/${ids.project}/items/${itemA.id}/deliver`, { qty: 3 });
    await post(`/projects/${ids.project}/items/${itemA.id}/deliver`, { qty: 1 }, { expect: 400 });
    const after = await get(`/projects/${ids.project}`);
    expect(after.items.find((i: Json) => i.productId === ids.productA).deliveredQty).toBe('3.000');
  });

  it('records allocated and unallocated payments', async () => {
    const key = randomUUID();
    const body = { clientId: ids.client, paidOn: today, amount: 2000, method: 'BANK_TRANSFER', reference: `E2E-${RUN}`, allocations: [{ projectId: ids.project, amount: 2000 }] };
    const p1 = await post('/payments', body, { key });
    const again = await post('/payments', body, { key });
    expect(again.id).toBe(p1.id);
    ids.payment1 = p1.id;
    expect((await get(`/ledgers/clients/${ids.client}`)).closingBalance).toBe('4300.00');

    const milestones = (await get(`/projects/${ids.project}`)).milestones;
    expect(milestones[0].status).toBe('RECEIVED');
    expect(milestones[1].status).toBe('PARTIALLY_RECEIVED');

    const p2 = await post('/payments', { clientId: ids.client, paidOn: today, amount: 1000, method: 'CASH' });
    expect(p2.unallocated).toBe('1000.00');
    expect((await get(`/clients/${ids.client}`)).overview.unallocated).toBe('1000.00');
    await post(`/payments/${p2.id}/allocate`, { allocations: [{ projectId: ids.project, amount: 1000 }] });
    expect((await get(`/ledgers/clients/${ids.client}`)).closingBalance).toBe('3300.00');
    await post(`/payments/${p2.id}/allocate`, { allocations: [{ projectId: ids.project, amount: 1 }] }, { expect: 400 });
  });

  it('bills additional work, books expenses and pays the vendor', async () => {
    const inv = await post('/invoices', { projectId: ids.project, kind: 'ADDITIONAL', items: [{ description: 'Extra sensor wiring', qty: 1, unitPrice: 500 }], issue: true });
    expect(inv.status).toBe('ISSUED');
    expect((await get(`/ledgers/clients/${ids.client}`)).closingBalance).toBe('3800.00');

    await post('/expenses', { expenseDate: today, category: 'TRANSPORT', amount: 200, method: 'CASH', projectId: ids.project, description: 'Delivery van' });
    const fin = (await get(`/projects/${ids.project}`)).financials;
    expect(fin.expenses).toBe('200.00');

    await post('/vendor-payments', { vendorId: ids.vendor, paidOn: today, amount: 3500, method: 'BANK_TRANSFER' });
    expect((await get(`/ledgers/vendors/${ids.vendor}`)).closingBalance).toBe('0.00');
  });

  it('dashboards and reports reflect the activity', async () => {
    const dash = await get('/dashboard');
    expect(Number(dash.kpis.totalSales)).toBeGreaterThanOrEqual(6300);
    expect(dash.salesOverview).toHaveLength(12);
    await get('/dashboard/accounts');
    const aging = await get('/reports/receivables-aging');
    const row = aging.rows.find((r: Json) => r.partyId === ids.client);
    expect(row.total).toBe('3800.00');
    const prof = await get('/reports/project-profitability?pageSize=200');
    const pr = prof.rows.find((r: Json) => r.projectId === ids.project);
    expect(pr.productCost).toBe('3500.00');
    expect(pr.estimatedProfit).toBe('2600.00');
    const sales = await get('/reports/sales?groupBy=client');
    expect(sales.rows.find((r: Json) => r.key === ids.client).value).toBe('6300.00');
    const search = await get(`/search?q=${encodeURIComponent(`E2E Client ${RUN}`)}`);
    expect(search.some((r: Json) => r.type === 'CLIENT' && r.id === ids.client)).toBe(true);
  });

  it('voiding a payment reverses its effect', async () => {
    await post(`/payments/${ids.payment1}/void`, { reason: 'Cheque bounced' });
    expect((await get(`/ledgers/clients/${ids.client}`)).closingBalance).toBe('5800.00');
    await post(`/payments/${ids.payment1}/void`, { reason: 'Twice' }, { expect: 400 });
    const audit = await get(`/audit-logs?entityId=${ids.payment1}`);
    expect(audit.data.some((a: Json) => a.action === 'payment.voided')).toBe(true);
  });

  it('uploads project photos and imports / exports spreadsheets', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'before.png');
    const doc = await call('POST', `/documents?ownerType=PROJECT&ownerId=${ids.project}&category=SITE_PHOTO&photoStage=BEFORE`, form);
    expect(doc.photoStage).toBe('BEFORE');
    const docs = await get(`/documents?ownerType=PROJECT&ownerId=${ids.project}`);
    expect(docs.some((d: Json) => d.id === doc.id)).toBe(true);

    const csv = new FormData();
    csv.append('file', new Blob([`sku,name,sellingPrice,unit\nE2E-C-${RUN},Imported ${RUN},999,PIECE\n,Missing SKU,1,PIECE\n`], { type: 'text/csv' }), 'products.csv');
    const dry = await call('POST', '/imports/products?dryRun=true', csv);
    expect(dry.errors).toHaveLength(1);
    expect(dry.dryRun).toBe(true);

    const xlsx: Response = await call('GET', '/exports/clients', undefined, { raw: true });
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml');
  });

  it('creates a backup snapshot', async () => {
    const b = await post('/backups');
    expect(b.rows).toBeGreaterThan(0);
    expect((await get('/backups')).some((x: Json) => x.id === b.id)).toBe(true);
  });

  it('renders every PDF and export', async () => {
    const inv = (await get(`/invoices?projectId=${ids.project}`)).data[0];
    for (const p of [`/quotations/${ids.quotation}/pdf`, `/invoices/${inv.id}/pdf`, `/purchase-orders/${ids.po}/pdf`, `/ledgers/clients/${ids.client}/statement.pdf`, `/ledgers/vendors/${ids.vendor}/statement.pdf`]) {
      const res: Response = await call('GET', p, undefined, { raw: true });
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), p).toBe('%PDF');
    }
    const entities = ['clients', 'sites', 'products', 'vendors', 'quotations', 'projects', 'invoices', 'payments', 'expenses', 'purchase-orders', 'stock', 'receivables-aging', 'payables-aging', 'product-sales', 'project-profitability'];
    for (const e of entities) {
      const res: Response = await call('GET', `/exports/${e}?format=${e === 'stock' ? 'csv' : 'xlsx'}`, undefined, { raw: true });
      expect((await res.arrayBuffer()).byteLength, e).toBeGreaterThan(20);
    }
    await call('GET', '/imports/products/template', undefined, { raw: true });
    for (const p of ['/reports/payables-aging', '/reports/product-sales', '/reports/payments', '/settings', '/roles/permissions', '/users', '/roles', '/inventory', '/settings/space-presets']) await get(p);
  });

  it('enforces settings rules and runs scheduled jobs', async () => {
    await call('PUT', '/settings/accounting', { receivableOn: 'INVOICE' }, { expect: 409 });
    await call('PUT', '/settings/quotation', { defaultPaymentSchedule: [{ name: 'Advance', percent: 50 }] }, { expect: 400 });
    const jobs = await post('/system/jobs/run-now');
    expect(jobs.ran).toBe(true);
  });

  it('delivers notifications to the admin inbox', async () => {
    const n = await get('/notifications');
    expect(n.data.length).toBeGreaterThan(0);
    await post('/notifications/read-all');
    expect((await get('/notifications/unread-count')).unreadCount).toBe(0);
  });
});
