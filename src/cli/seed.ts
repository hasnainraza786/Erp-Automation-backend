/**
 * Idempotent seed: chart of accounts, default roles, admin user, space presets.
 * `--demo` also adds sample categories, vendors, products, clients and sites for UAT.
 *
 *   yarn db:seed            # base data only (safe in production)
 *   yarn db:seed --demo     # plus demo master data
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEFAULT_ROLES } from '../common/permissions';
import { CHART_OF_ACCOUNTS } from '../infra/journal.service';

const prisma = new PrismaClient();

const SPACE_PRESETS = [
  'Lounge', 'Drawing Room', 'Dining', 'Kitchen', 'Master Bedroom', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3',
  'Kids Room', 'Guest Room', 'TV Lounge', 'Home Theater', 'Study', 'Gym', 'Porch', 'Lawn', 'Roof Top',
  'Staircase', 'Corridor', 'Basement', 'Main Gate', 'Parking', 'Office Cabin', 'Reception', 'Conference Room',
];

async function base() {
  for (const a of CHART_OF_ACCOUNTS) {
    await prisma.account.upsert({ where: { code: a.code }, create: { ...a, isSystem: true }, update: { name: a.name, type: a.type, isSystem: true } });
  }
  for (const [name, r] of Object.entries(DEFAULT_ROLES)) {
    // Existing roles keep their edited permissions; only missing roles are created.
    await prisma.role.upsert({ where: { name }, create: { name, description: r.description, permissions: r.permissions, isSystem: true }, update: { isSystem: true } });
  }
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@erp.local').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    if (!password || password.length < 8) throw new Error('SEED_ADMIN_PASSWORD (min 8 chars) is required to create the admin user');
    const admin = await prisma.role.findUniqueOrThrow({ where: { name: 'Admin' } });
    await prisma.user.create({ data: { email, name: 'Administrator', roleId: admin.id, passwordHash: await bcrypt.hash(password, 10) } });
    console.log(`Created admin user ${email}`);
  }
  for (const [i, name] of SPACE_PRESETS.entries()) {
    await prisma.spacePreset.upsert({ where: { name }, create: { name, sortOrder: i * 10 }, update: {} });
  }
  console.log(`Base data ready: ${CHART_OF_ACCOUNTS.length} accounts, ${Object.keys(DEFAULT_ROLES).length} roles, ${SPACE_PRESETS.length} space presets`);
}

async function demo() {
  if (await prisma.product.count()) {
    console.log('Products already exist; skipping demo data');
    return;
  }
  const cat = async (name: string, parentId: string | null = null, sortOrder = 0) =>
    (await prisma.productCategory.findFirst({ where: { name, parentId } })) ?? prisma.productCategory.create({ data: { name, parentId, sortOrder } });

  const lighting = await cat('Smart Lighting', null, 10);
  const switches = await cat('Smart Switches', null, 20);
  const security = await cat('Security & CCTV', null, 30);
  const network = await cat('Networking', null, 40);
  const audio = await cat('Audio & Theater', null, 50);
  const curtains = await cat('Curtain Automation', null, 60);
  const dimmers = await cat('Dimmers', lighting.id, 10);

  const nextCode = async (prefix: string, type: string, pad: number) => {
    const rows = await prisma.$queryRaw<{ current: number }[]>`
      INSERT INTO "NumberSequence" ("id", "current") VALUES (${type}, 1)
      ON CONFLICT ("id") DO UPDATE SET "current" = "NumberSequence"."current" + 1 RETURNING "current"`;
    return `${prefix}-${String(rows[0].current).padStart(pad, '0')}`;
  };

  const vendorData = [
    { name: 'Techno Distributors', contactPerson: 'Imran Ali', phone: '0300-1112233', paymentTerms: '30 days', email: 'sales@techno.pk' },
    { name: 'SecureVision Pvt Ltd', contactPerson: 'Sana Khan', phone: '0321-4455667', paymentTerms: '15 days' },
    { name: 'NetLink Traders', contactPerson: 'Bilal Ahmed', phone: '0333-7788990', paymentTerms: 'Advance' },
  ];
  const vendors = [];
  for (const v of vendorData) vendors.push(await prisma.vendor.create({ data: { ...v, code: await nextCode('VN', 'VENDOR', 4) } }));

  const products = [
    { sku: 'SW-4G-TOUCH', name: 'Smart Touch Switch 4 Gang', brand: 'Sonoff', categoryId: switches.id, cost: 6500, sell: 9500, min: 8500, supplier: 0, reorder: 10 },
    { sku: 'SW-2G-TOUCH', name: 'Smart Touch Switch 2 Gang', brand: 'Sonoff', categoryId: switches.id, cost: 5200, sell: 7800, min: 7000, supplier: 0, reorder: 10 },
    { sku: 'DIM-1G', name: 'Smart Dimmer 1 Gang', brand: 'Sonoff', categoryId: lighting.id, subcategoryId: dimmers.id, cost: 5800, sell: 8900, min: 8000, supplier: 0, reorder: 5 },
    { sku: 'LED-STRIP-5M', name: 'RGBW LED Strip 5m + Controller', brand: 'Philips Hue', categoryId: lighting.id, cost: 14000, sell: 21000, min: 19000, supplier: 0, reorder: 4, unit: 'SET' as const },
    { sku: 'CAM-4MP-DOME', name: '4MP IP Dome Camera', brand: 'Hikvision', categoryId: security.id, cost: 9500, sell: 14500, min: 13000, supplier: 1, reorder: 8 },
    { sku: 'CAM-4MP-BULLET', name: '4MP IP Bullet Camera', brand: 'Hikvision', categoryId: security.id, cost: 10500, sell: 15500, min: 14000, supplier: 1, reorder: 8 },
    { sku: 'NVR-8CH', name: '8 Channel NVR with 2TB HDD', brand: 'Hikvision', categoryId: security.id, cost: 38000, sell: 52000, min: 48000, supplier: 1, reorder: 2 },
    { sku: 'VDP-7IN', name: 'Video Door Phone 7"', brand: 'Dahua', categoryId: security.id, cost: 28000, sell: 39000, min: 36000, supplier: 1, reorder: 2, unit: 'SET' as const },
    { sku: 'AP-WIFI6', name: 'WiFi 6 Ceiling Access Point', brand: 'Ubiquiti', categoryId: network.id, cost: 32000, sell: 44000, min: 41000, supplier: 2, reorder: 3 },
    { sku: 'SW-POE-8', name: '8 Port PoE Switch', brand: 'TP-Link', categoryId: network.id, cost: 16000, sell: 23000, min: 21000, supplier: 2, reorder: 3 },
    { sku: 'CURT-MOTOR', name: 'Smart Curtain Motor + Track (per m)', brand: 'Aqara', categoryId: curtains.id, cost: 11000, sell: 16500, min: 15000, supplier: 0, reorder: 4, unit: 'METER' as const },
    { sku: 'SPK-CEIL-6', name: '6.5" Ceiling Speaker (pair)', brand: 'Sonos', categoryId: audio.id, cost: 42000, sell: 58000, min: 54000, supplier: 0, reorder: 2, unit: 'PAIR' as const },
    { sku: 'SRV-INSTALL', name: 'Installation Labour', categoryId: null, cost: 0, sell: 2500, supplier: null, reorder: 0, unit: 'HOUR' as const },
  ];
  for (const p of products) {
    await prisma.product.create({
      data: {
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        categoryId: p.categoryId,
        subcategoryId: p.subcategoryId,
        unit: p.unit ?? 'PIECE',
        costPrice: p.cost,
        sellingPrice: p.sell,
        minPrice: p.min,
        supplierId: p.supplier === null ? null : vendors[p.supplier].id,
        warranty: p.cost ? '1 year' : null,
        reorderLevel: p.reorder,
        stock: { create: {} },
      },
    });
  }

  const pm = await prisma.user.findFirst({ where: { role: { name: 'Admin' } } });
  const clients = [
    { name: 'Ahmed Raza', phone: '0300-5551234', whatsapp: '0300-5551234', billingAddress: 'House 12, Street 5, DHA Phase 6, Lahore', type: 'RESIDENTIAL' as const, sites: [{ name: 'DHA Phase 6 House', address: 'House 12, Street 5, DHA Phase 6, Lahore', type: 'HOUSE' as const }, { name: 'Gulberg Office', address: '45-B, Main Boulevard, Gulberg III, Lahore', type: 'OFFICE' as const }] },
    { name: 'Crescent Builders', companyName: 'Crescent Builders (Pvt) Ltd', contactPerson: 'Usman Tariq', phone: '042-35761234', email: 'projects@crescent.pk', type: 'BUILDER' as const, sites: [{ name: 'Bahria Villa 221', address: 'Villa 221, Overseas B, Bahria Town, Lahore', type: 'VILLA' as const }] },
  ];
  for (const c of clients) {
    const { sites, ...data } = c;
    const client = await prisma.client.create({ data: { ...data, code: await nextCode('CL', 'CLIENT', 5) } });
    for (const s of sites) await prisma.site.create({ data: { ...s, clientId: client.id, managerId: pm?.id, code: await nextCode('ST', 'SITE', 5) } });
  }
  console.log(`Demo data: ${vendors.length} vendors, ${products.length} products, ${clients.length} clients`);
}

async function main() {
  await base();
  if (process.argv.includes('--demo') || process.env.SEED_DEMO === 'true') await demo();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
