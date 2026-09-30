import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../common/auth.decorators';
import { plain } from '../common/schemas';
import { PrismaService, Tx } from './prisma.service';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string;
  summary?: string;
  before?: unknown;
  after?: unknown;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(actor: AuthUser | null, input: AuditInput, tx?: Tx) {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        actorId: actor?.id,
        actorName: actor?.name,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        summary: input.summary,
        before: input.before === undefined ? undefined : (plain(input.before) as Prisma.InputJsonValue),
        after: input.after === undefined ? undefined : (plain(input.after) as Prisma.InputJsonValue),
      },
    });
  }
}
