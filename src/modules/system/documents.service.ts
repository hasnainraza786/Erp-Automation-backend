import { BadRequestException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { AuthUser } from '../../common/auth.decorators';
import { hasPermission, PERMISSIONS as P, Permission } from '../../common/permissions';
import { plain } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { PrismaService } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { StorageService } from '../../infra/storage.service';
import { OWNER_TYPES, zUploadFields } from './system.schemas';

type OwnerType = (typeof OWNER_TYPES)[number];

const OWNER_RULES: Record<OwnerType, { view: Permission; upload: Permission; exists: (db: PrismaService, id: string) => Promise<unknown> }> = {
  CLIENT: { view: P.CLIENT_VIEW, upload: P.CLIENT_MANAGE, exists: (db, id) => db.client.findUnique({ where: { id } }) },
  SITE: { view: P.SITE_VIEW, upload: P.SITE_MANAGE, exists: (db, id) => db.site.findUnique({ where: { id } }) },
  PROJECT: { view: P.PROJECT_VIEW, upload: P.PROJECT_PROGRESS, exists: (db, id) => db.project.findUnique({ where: { id } }) },
  TASK: { view: P.PROJECT_VIEW, upload: P.PROJECT_PROGRESS, exists: (db, id) => db.projectTask.findUnique({ where: { id } }) },
  QUOTATION: { view: P.QUOTATION_VIEW, upload: P.QUOTATION_MANAGE, exists: (db, id) => db.quotation.findUnique({ where: { id } }) },
  PAYMENT: { view: P.PAYMENT_VIEW, upload: P.PAYMENT_CREATE, exists: (db, id) => db.payment.findUnique({ where: { id } }) },
  PURCHASE_ORDER: { view: P.PURCHASE_VIEW, upload: P.PURCHASE_MANAGE, exists: (db, id) => db.purchaseOrder.findUnique({ where: { id } }) },
  EXPENSE: { view: P.EXPENSE_VIEW, upload: P.EXPENSE_MANAGE, exists: (db, id) => db.expense.findUnique({ where: { id } }) },
  PRODUCT: { view: P.PRODUCT_VIEW, upload: P.PRODUCT_MANAGE, exists: (db, id) => db.product.findUnique({ where: { id } }) },
  VENDOR: { view: P.VENDOR_VIEW, upload: P.VENDOR_MANAGE, exists: (db, id) => db.vendor.findUnique({ where: { id } }) },
};

const ALLOWED_MIME = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document)|application\/msword|application\/vnd\.ms-excel|text\/csv|text\/plain|application\/dxf|image\/vnd\.dwg|application\/acad|application\/octet-stream)$/;
const IMAGE_MIME = /^image\/(jpeg|png|webp)$/;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private assertCan(user: AuthUser, ownerType: string, kind: 'view' | 'upload') {
    const rule = OWNER_RULES[ownerType as OwnerType];
    if (!rule) throw new BadRequestException('Unknown owner type');
    if (!hasPermission(user.permissions, rule[kind])) throw new ForbiddenException(`Missing permission: ${rule[kind]}`);
    return rule;
  }

  static async readFile(file: MultipartFile | undefined) {
    if (!file) throw new BadRequestException('A file is required (multipart field "file")');
    const buffer = await file.toBuffer().catch((e: Error) => {
      if (/limit/i.test(e.message)) throw new PayloadTooLargeException('File exceeds 20 MB');
      throw e;
    });
    return { buffer, fileName: file.filename, mimeType: file.mimetype };
  }

  async list(user: AuthUser, q: { ownerType: string; ownerId: string; category?: string }) {
    this.assertCan(user, q.ownerType, 'view');
    const rows = await this.prisma.document.findMany({
      where: { ownerType: q.ownerType, ownerId: q.ownerId, category: q.category, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return plain(rows.map(({ storageKey: _k, archivedAt: _a, ...d }) => d));
  }

  async upload(user: AuthUser, fields: unknown, file: { buffer: Buffer; fileName: string; mimeType: string }) {
    const meta = zUploadFields.parse(fields);
    const rule = this.assertCan(user, meta.ownerType, 'upload');
    if (!(await rule.exists(this.prisma, meta.ownerId))) throw new NotFoundException(`${meta.ownerType} not found`);
    if (!ALLOWED_MIME.test(file.mimeType)) throw new BadRequestException(`File type ${file.mimeType} is not allowed`);
    if (meta.photoStage && !file.mimeType.startsWith('image/')) throw new BadRequestException('Photo stage applies to images only');

    const key = `${meta.ownerType.toLowerCase()}/${meta.ownerId}/${randomUUID()}${extname(file.fileName).toLowerCase().slice(0, 10)}`;
    await this.storage.put(key, file.buffer, file.mimeType);
    const doc = await this.prisma.document.create({
      data: {
        ownerType: meta.ownerType,
        ownerId: meta.ownerId,
        category: meta.category,
        photoStage: meta.photoStage,
        fileName: file.fileName.slice(0, 200),
        mimeType: file.mimeType,
        size: file.buffer.length,
        storageKey: key,
        uploadedBy: user.id,
      },
    });
    if (meta.ownerType === 'PRODUCT' && meta.category === 'PRODUCT_IMAGE' && IMAGE_MIME.test(file.mimeType)) {
      await this.prisma.product.update({ where: { id: meta.ownerId }, data: { imageKey: key } });
    }
    if (meta.ownerType === 'PRODUCT' && meta.category === 'DATASHEET') {
      await this.prisma.product.update({ where: { id: meta.ownerId }, data: { datasheetKey: key } });
    }
    await this.audit.log(user, {
      action: 'document.uploaded',
      entityType: meta.ownerType,
      entityId: meta.ownerId,
      summary: `${meta.category.replace(/_/g, ' ').toLowerCase()} "${doc.fileName}" uploaded`,
    });
    const { storageKey: _k, archivedAt: _a, ...rest } = doc;
    return plain(rest);
  }

  async open(user: AuthUser, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc || doc.archivedAt) throw new NotFoundException('Document not found');
    this.assertCan(user, doc.ownerType, 'view');
    return { doc, stream: await this.storage.get(doc.storageKey) };
  }

  async signedUrl(user: AuthUser, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc || doc.archivedAt) throw new NotFoundException('Document not found');
    this.assertCan(user, doc.ownerType, 'view');
    const url = await this.storage.signedUrl(doc.storageKey, 300);
    return { url: url ?? `/api/v1/documents/${id}/download`, expiresIn: url ? 300 : 0 };
  }

  async archive(user: AuthUser, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc || doc.archivedAt) throw new NotFoundException('Document not found');
    this.assertCan(user, doc.ownerType, 'upload');
    await this.prisma.document.update({ where: { id }, data: { archivedAt: new Date() } });
    await this.audit.log(user, { action: 'document.archived', entityType: doc.ownerType, entityId: doc.ownerId, summary: `"${doc.fileName}" removed` });
    return { ok: true };
  }

  async uploadLogo(user: AuthUser, file: { buffer: Buffer; fileName: string; mimeType: string }) {
    if (!/^image\/(png|jpeg)$/.test(file.mimeType)) throw new BadRequestException('Logo must be a PNG or JPEG image');
    if (file.buffer.length > 2 * 1024 * 1024) throw new PayloadTooLargeException('Logo must be under 2 MB');
    const key = `company/logo-${Date.now()}${file.mimeType === 'image/png' ? '.png' : '.jpg'}`;
    await this.storage.put(key, file.buffer, file.mimeType);
    await this.settings.set('company', { logoKey: key });
    await this.audit.log(user, { action: 'settings.updated', entityType: 'Setting', summary: 'Company logo updated' });
    return { ok: true };
  }

  async logo() {
    const { logoKey } = await this.settings.get('company');
    if (!logoKey) throw new NotFoundException('No logo uploaded');
    return { stream: await this.storage.get(logoKey), mimeType: logoKey.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }
}
