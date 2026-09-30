import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  applyDecorators,
  UseInterceptors,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Observable, from, of, switchMap, catchError, throwError } from 'rxjs';
import { PrismaService } from '../infra/prisma.service';

const IN_PROGRESS = 0;

/**
 * Requires an Idempotency-Key header. Replays of the same key by the same user return the
 * stored response instead of performing the action twice (prevents duplicate payments).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest();
    const key: string | undefined = req.headers['idempotency-key'];
    if (!key || key.length < 8 || key.length > 200) {
      throw new BadRequestException('Idempotency-Key header (8-200 chars) is required');
    }
    const userId: string = req.user.id;
    const route = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const storageKey = `${userId}:${key}`;

    try {
      await this.prisma.idempotencyKey.create({
        data: { key: storageKey, userId, route, statusCode: IN_PROGRESS, response: {} },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.idempotencyKey.findUnique({ where: { key: storageKey } });
        if (!existing || existing.statusCode === IN_PROGRESS) {
          throw new ConflictException('A request with this Idempotency-Key is still being processed');
        }
        if (existing.route !== route) throw new ConflictException('Idempotency-Key was used for a different operation');
        return of(existing.response);
      }
      throw err;
    }

    return next.handle().pipe(
      switchMap((body) =>
        from(
          this.prisma.idempotencyKey.update({
            where: { key: storageKey },
            data: { statusCode: 200, response: (body ?? {}) as Prisma.InputJsonValue },
          }),
        ).pipe(switchMap(() => of(body))),
      ),
      catchError((err) =>
        from(this.prisma.idempotencyKey.delete({ where: { key: storageKey } }).catch(() => undefined)).pipe(
          switchMap(() => throwError(() => err)),
        ),
      ),
    );
  }
}

export const Idempotent = () =>
  applyDecorators(
    SetMetadata('idempotent', true),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Unique key per logical operation (e.g. a UUID)' }),
  );
