import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { AuthUser } from '../../common/auth.decorators';
import { env } from '../../config/env';
import { AuditService } from '../../infra/audit.service';
import { PrismaService } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { StorageService } from '../../infra/storage.service';

const gzipAsync = promisify(gzip);
const INDEX_KEY = 'backups';
/** Session and replay data are not business records and are regenerated on use. */
const SKIP_MODELS = new Set(['RefreshToken', 'IdempotencyKey']);

interface BackupMeta {
  id: string;
  fileName: string;
  storageKey: string;
  size: number;
  tables: number;
  rows: number;
  createdAt: string;
  createdBy: string | null;
}

/**
 * Application-level JSON snapshots, stored gzip-compressed in object storage. They complement
 * (not replace) the managed database's point-in-time restore and a periodic pg_dump.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private async index(): Promise<BackupMeta[]> {
    return ((await this.settings.getRaw(INDEX_KEY)) as unknown as BackupMeta[] | null) ?? [];
  }

  async list() {
    return (await this.index()).map(({ storageKey: _k, ...b }) => b);
  }

  async create(actor: AuthUser | null) {
    const snapshot: Record<string, unknown[]> = {};
    let rows = 0;
    await this.prisma.$transaction(
      async (tx) => {
        for (const model of Prisma.dmmf.datamodel.models) {
          if (SKIP_MODELS.has(model.name)) continue;
          const delegate = (tx as unknown as Record<string, { findMany: () => Promise<unknown[]> }>)[model.name[0].toLowerCase() + model.name.slice(1)];
          const data = await delegate.findMany();
          snapshot[model.name] = data;
          rows += data.length;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 10_000 },
    );
    const createdAt = new Date().toISOString();
    const body = await gzipAsync(Buffer.from(JSON.stringify({ format: 'erp-backup/1', createdAt, tables: snapshot })));
    const id = randomUUID();
    const fileName = `erp-backup-${createdAt.slice(0, 16).replace(/[:T]/g, '-')}.json.gz`;
    const storageKey = `backups/${fileName}`;
    await this.storage.put(storageKey, body, 'application/gzip');

    const meta: BackupMeta = { id, fileName, storageKey, size: body.length, tables: Object.keys(snapshot).length, rows, createdAt, createdBy: actor?.name ?? 'scheduler' };
    const all = [meta, ...(await this.index())];
    const keep = all.slice(0, env.BACKUP_RETENTION);
    await this.settings.setRaw(INDEX_KEY, keep as unknown as Prisma.InputJsonValue);
    // Old snapshots drop out of the index; object-storage lifecycle rules can delete the files.
    if (actor) await this.audit.log(actor, { action: 'backup.created', entityType: 'Backup', summary: `Backup ${fileName} created (${rows} rows)` });
    this.logger.log(`Backup ${fileName} stored (${rows} rows, ${body.length} bytes)`);
    const { storageKey: _k, ...rest } = meta;
    return rest;
  }

  async open(id: string) {
    const meta = (await this.index()).find((b) => b.id === id);
    if (!meta) throw new NotFoundException('Backup not found');
    return { meta, stream: await this.storage.get(meta.storageKey) };
  }

  async lastBackupAt() {
    return (await this.index())[0]?.createdAt ?? null;
  }
}
