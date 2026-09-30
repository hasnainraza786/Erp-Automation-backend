import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { D, money } from '../../common/money';
import { env } from '../../config/env';
import { AuditService } from '../../infra/audit.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PrismaService } from '../../infra/prisma.service';
import { BackupsService } from './backups.service';

const HOUR = 3600_000;

/**
 * Hourly housekeeping: overdue/expiry/low-stock notices, quotation expiry, nightly backup and cleanup.
 * Runs in-process, and can also be triggered by an external cron (free hosts sleep when idle).
 * A conditional upsert on the Setting table guarantees a single run per window across instances.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private timer?: NodeJS.Timeout;
  private boot?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly backups: BackupsService,
  ) {}

  onApplicationBootstrap() {
    if (env.SCHEDULER_ENABLED !== 'true' || env.NODE_ENV === 'test') return;
    this.boot = setTimeout(() => void this.runSafe(), 60_000);
    this.timer = setInterval(() => void this.runSafe(), HOUR);
  }

  onModuleDestroy() {
    clearTimeout(this.boot);
    clearInterval(this.timer);
  }

  private async runSafe() {
    try {
      await this.run();
    } catch (e) {
      this.logger.error(`Scheduled jobs failed: ${(e as Error).message}`);
    }
  }

  /** Atomically claims a job window; returns false if another instance ran it recently. */
  private async claim(key: string, minutes: number) {
    const rows = await this.prisma.$queryRaw<{ key: string }[]>`
      INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${key}, jsonb_build_object('at', now()), now())
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
      WHERE ("Setting"."value"->>'at')::timestamptz < now() - make_interval(mins => ${minutes}::int)
      RETURNING "key"`;
    return rows.length > 0;
  }

  async run(force = false) {
    const result = { ran: false, overdueNotices: 0, expiringNotices: 0, expiredQuotations: 0, lowStockNotices: 0, vendorDueNotices: 0, backup: null as string | null };
    if (!force && !(await this.claim('job:hourly', 50))) return result;
    result.ran = true;

    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const inDays = (n: number) => new Date(today.getTime() + n * 86400_000);

    // Overdue client milestones
    const overdue = await this.prisma.paymentMilestone.findMany({
      where: { status: { not: 'RECEIVED' }, dueDate: { lt: today }, project: { status: { notIn: ['CANCELLED'] } } },
      include: { project: { select: { id: true, number: true, client: { select: { name: true } } } } },
    });
    for (const m of overdue) {
      await this.notifications.notifyOncePerDay({
        type: 'PAYMENT_OVERDUE',
        title: `Payment overdue: ${m.project.client.name}`,
        body: `${m.project.number} · ${m.name} · PKR ${money(m.amount)} was due ${m.dueDate!.toISOString().slice(0, 10)}`,
        entityType: 'Project',
        entityId: m.projectId,
        audience: ['Accounts'],
      });
      result.overdueNotices++;
    }

    // Quotations expiring soon / expired
    const open = await this.prisma.quotation.findMany({
      where: { status: { in: ['SENT', 'UNDER_DISCUSSION', 'REVISED'] } },
      include: { client: { select: { name: true } }, revisions: { select: { revisionNo: true, validUntil: true } } },
    });
    for (const q of open) {
      const validUntil = q.revisions.find((r) => r.revisionNo === q.currentRevisionNo)?.validUntil;
      if (!validUntil) continue;
      if (validUntil < today) {
        await this.prisma.quotation.update({ where: { id: q.id }, data: { status: 'EXPIRED', version: { increment: 1 } } });
        await this.audit.log(null, { action: 'quotation.expired', entityType: 'Quotation', entityId: q.id, summary: `${q.number} expired (valid until ${validUntil.toISOString().slice(0, 10)})` });
        await this.notifications.notify({ type: 'QUOTATION_EXPIRED', title: `Quotation expired: ${q.number}`, body: q.client.name, entityType: 'Quotation', entityId: q.id, audience: ['Sales'] });
        result.expiredQuotations++;
      } else if (validUntil <= inDays(2)) {
        await this.notifications.notifyOncePerDay({ type: 'QUOTATION_EXPIRING', title: `Quotation expiring: ${q.number}`, body: `${q.client.name} · valid until ${validUntil.toISOString().slice(0, 10)}`, entityType: 'Quotation', entityId: q.id, audience: ['Sales'] });
        result.expiringNotices++;
      }
    }

    // Low stock
    const low = await this.prisma.$queryRaw<{ id: string; name: string; available: string; reorder: string }[]>`
      SELECT p.id, p.name, (COALESCE(s."onHand",0) - COALESCE(s.reserved,0))::text AS available, p."reorderLevel"::text AS reorder
      FROM "Product" p LEFT JOIN "ProductStock" s ON s."productId" = p.id
      WHERE p."isActive" AND p."reorderLevel" > 0 AND COALESCE(s."onHand",0) - COALESCE(s.reserved,0) + COALESCE(s.incoming,0) <= p."reorderLevel"`;
    for (const p of low) {
      await this.notifications.notifyOncePerDay({ type: 'LOW_STOCK', title: `Low stock: ${p.name}`, body: `Available ${D(p.available).toString()} (reorder level ${D(p.reorder).toString()})`, entityType: 'Product', entityId: p.id, audience: ['Procurement'] });
      result.lowStockNotices++;
    }

    // Vendor payments due within 3 days
    const duePos = await this.prisma.purchaseOrder.findMany({
      where: { status: { in: ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'] }, dueDate: { gte: today, lte: inDays(3) } },
      include: { vendor: { select: { name: true } } },
    });
    for (const po of duePos) {
      await this.notifications.notifyOncePerDay({ type: 'VENDOR_PAYMENT_DUE', title: `Vendor payment due: ${po.vendor.name}`, body: `${po.number} · PKR ${money(po.total)} due ${po.dueDate!.toISOString().slice(0, 10)}`, entityType: 'PurchaseOrder', entityId: po.id, audience: ['Accounts'] });
      result.vendorDueNotices++;
    }

    // Cleanup
    await this.prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 86400_000) } } });
    await this.prisma.refreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 30 * 86400_000) } }] } });

    // Nightly backup
    if (await this.claim('job:backup', 20 * 60)) {
      result.backup = (await this.backups.create(null)).fileName;
    }
    this.logger.log(`Jobs: ${JSON.stringify(result)}`);
    return result;
  }
}
