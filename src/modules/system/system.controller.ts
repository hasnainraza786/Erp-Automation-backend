import { Body, Controller, Delete, Get, Headers, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBody, ApiBodyOptions, ApiConsumes, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { ApiFile, ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../../common/auth.decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { OkDto, pageArgs, pageMeta, plain } from '../../common/schemas';
import { env } from '../../config/env';
import { PrismaService } from '../../infra/prisma.service';
import { BackupsService } from './backups.service';
import { DataIoService } from './data-io.service';
import { DocumentsService } from './documents.service';
import { JobsService } from './jobs.service';
import {
  BackupDto,
  BackupListDto,
  DocumentDto,
  DocumentListDto,
  DocumentQueryDto,
  DocumentUrlDto,
  EXPORT_ENTITIES,
  ExportQueryDto,
  IMPORT_ENTITIES,
  ImportQueryDto,
  ImportResultDto,
  JobsResultDto,
  MarkReadDto,
  NotificationPageDto,
  NotificationQueryDto,
  UnreadCountDto,
  UploadQueryDto,
} from './system.schemas';

const FILE_BODY: ApiBodyOptions = {
  schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
};

function sendFile(reply: FastifyReply, file: { buffer: Buffer | NodeJS.ReadableStream; fileName: string; mimeType: string }, inline = false) {
  reply
    .header('content-type', file.mimeType)
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.fileName)}"`)
    .send(file.buffer);
}

@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, q: NotificationQueryDto) {
    const where = { userId: user.id, ...(q.unread === 'true' ? { readAt: null } : q.unread === 'false' ? { readAt: { not: null } } : {}) };
    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return { data: plain(rows.map(({ userId: _u, audience: _a, ...n }) => n)), meta: pageMeta(q, total), unreadCount };
  }

  async unread(user: AuthUser) {
    return { unreadCount: await this.prisma.notification.count({ where: { userId: user.id, readAt: null } }) };
  }

  async markRead(user: AuthUser, ids?: string[]) {
    await this.prisma.notification.updateMany({ where: { userId: user.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
    return { ok: true };
  }
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @ApiOk(NotificationPageDto)
  listNotifications(@CurrentUser() user: AuthUser, @Query() q: NotificationQueryDto) {
    return this.inbox.list(user, q);
  }

  @Get('unread-count')
  @ApiOk(UnreadCountDto)
  getUnreadNotificationCount(@CurrentUser() user: AuthUser) {
    return this.inbox.unread(user);
  }

  @Post('read')
  @HttpCode(200)
  @ApiOk(OkDto)
  markNotificationsRead(@CurrentUser() user: AuthUser, @Body() body: MarkReadDto) {
    return this.inbox.markRead(user, body.ids);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOk(OkDto)
  markAllNotificationsRead(@CurrentUser() user: AuthUser) {
    return this.inbox.markRead(user);
  }
}

@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get()
  @ApiOk(DocumentListDto)
  listDocuments(@CurrentUser() user: AuthUser, @Query() q: DocumentQueryDto) {
    return this.docs.list(user, q);
  }

  /** Owner, category and photo stage go in the query string; the multipart body carries only the file. */
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @ApiOk(DocumentDto)
  async uploadDocument(@CurrentUser() user: AuthUser, @Query() q: UploadQueryDto, @Req() req: FastifyRequest) {
    return this.docs.upload(user, q, await DocumentsService.readFile(await req.file()));
  }

  @Get(':id/download')
  @ApiFile('application/octet-stream')
  async downloadDocument(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply, @Query('inline') inline?: string) {
    const { doc, stream } = await this.docs.open(user, id);
    sendFile(reply, { buffer: stream, fileName: doc.fileName, mimeType: doc.mimeType }, inline === 'true' || doc.mimeType.startsWith('image/'));
  }

  @Get(':id/url')
  @ApiOk(DocumentUrlDto)
  getDocumentUrl(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.signedUrl(user, id);
  }

  @Delete(':id')
  @ApiOk(OkDto)
  archiveDocument(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.archive(user, id);
  }
}

@ApiTags('settings')
@Controller('settings/company/logo')
export class CompanyLogoController {
  constructor(private readonly docs: DocumentsService) {}

  @Get()
  @ApiFile('image/png')
  async getCompanyLogo(@Res() reply: FastifyReply) {
    const { stream, mimeType } = await this.docs.logo();
    reply.header('content-type', mimeType).header('cache-control', 'private, max-age=300').send(stream);
  }

  @Post()
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @ApiOk(OkDto)
  async uploadCompanyLogo(@CurrentUser() user: AuthUser, @Req() req: FastifyRequest) {
    return this.docs.uploadLogo(user, await DocumentsService.readFile(await req.file()));
  }
}

@ApiTags('import-export')
@Controller()
export class DataIoController {
  constructor(private readonly io: DataIoService) {}

  @Get('imports/:entity/template')
  @RequirePermission(P.IMPORT_EXPORT)
  @ApiFile('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async downloadImportTemplate(@Param('entity') entity: string, @Res() reply: FastifyReply) {
    if (!(IMPORT_ENTITIES as readonly string[]).includes(entity)) throw new NotFoundException();
    sendFile(reply, await this.io.template(entity as (typeof IMPORT_ENTITIES)[number]));
  }

  /** Validates every row first; nothing is written unless dryRun=false and there are no errors. */
  @Post('imports/:entity')
  @HttpCode(200)
  @RequirePermission(P.IMPORT_EXPORT)
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @ApiOk(ImportResultDto)
  async importData(@CurrentUser() user: AuthUser, @Param('entity') entity: string, @Query() q: ImportQueryDto, @Req() req: FastifyRequest) {
    const file = await DocumentsService.readFile(await req.file());
    return this.io.import(user, entity, file, q.dryRun === 'true');
  }

  @Get('exports/:entity')
  @RequirePermission(P.IMPORT_EXPORT)
  @ApiFile('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportData(@CurrentUser() user: AuthUser, @Param('entity') entity: string, @Query() q: ExportQueryDto, @Res() reply: FastifyReply) {
    if (!(EXPORT_ENTITIES as readonly string[]).includes(entity)) throw new NotFoundException();
    sendFile(reply, await this.io.export(user, entity, q));
  }
}

@ApiTags('backups')
@Controller('backups')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  @RequirePermission(P.BACKUP_MANAGE)
  @ApiOk(BackupListDto)
  listBackups() {
    return this.backups.list();
  }

  @Post()
  @RequirePermission(P.BACKUP_MANAGE)
  @ApiOk(BackupDto)
  createBackup(@CurrentUser() user: AuthUser) {
    return this.backups.create(user);
  }

  @Get(':id/download')
  @RequirePermission(P.BACKUP_MANAGE)
  @ApiFile('application/gzip')
  async downloadBackup(@Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    const { meta, stream } = await this.backups.open(id);
    sendFile(reply, { buffer: stream, fileName: meta.fileName, mimeType: 'application/gzip' });
  }
}

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(private readonly jobs: JobsService) {}

  /** Called by an external scheduler (e.g. GitHub Actions cron) with the X-Cron-Secret header. */
  @Public()
  @Post('jobs')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  runScheduledJobs(@Headers('x-cron-secret') secret?: string) {
    const expected = env.CRON_SECRET;
    if (!expected) throw new NotFoundException();
    const a = Buffer.from(secret ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Invalid cron secret');
    return this.jobs.run();
  }

  @Post('jobs/run-now')
  @HttpCode(200)
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(JobsResultDto)
  runJobsNow() {
    return this.jobs.run(true);
  }
}
