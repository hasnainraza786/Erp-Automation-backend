import { Injectable } from '@nestjs/common';
import { WILDCARD } from '../common/permissions';
import { PrismaService, Tx } from './prisma.service';

export interface NotifyInput {
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  /** Role names that should see this notification. Admins always receive every notification. */
  audience?: string[];
  userId?: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fans out one row per recipient so each user has an independent read state. */
  async notify(input: NotifyInput, tx?: Tx) {
    const db = tx ?? this.prisma;
    const audience = input.audience ?? [];
    const recipients = input.userId
      ? [input.userId]
      : (
          await db.user.findMany({
            where: { isActive: true, OR: [{ role: { name: { in: audience } } }, { role: { permissions: { has: WILDCARD } } }] },
            select: { id: true },
          })
        ).map((u) => u.id);
    if (!recipients.length) return;
    await db.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        entityType: input.entityType,
        entityId: input.entityId,
        audience,
      })),
    });
  }

  /** Creates the notification only if one with the same type+entity was not created today. */
  async notifyOncePerDay(input: NotifyInput) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const exists = await this.prisma.notification.findFirst({
      where: { type: input.type, entityId: input.entityId, createdAt: { gte: start } },
    });
    if (!exists) await this.notify(input);
  }
}
