import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { AuthUser, IS_PUBLIC, REQUIRED_PERMISSIONS } from './auth.decorators';
import { hasPermission } from './permissions';

interface AccessPayload {
  sub: string;
}

/** Caches role permissions briefly so permission edits take effect within seconds without a DB hit per request. */
const userCache = new Map<string, { user: AuthUser; at: number }>();
const CACHE_MS = 15_000;

export function invalidateUserCache(userId?: string) {
  if (userId) userCache.delete(userId);
  else userCache.clear();
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const queryToken: string | undefined = req.query?.access_token;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;
    if (!token) throw new UnauthorizedException('Missing access token');

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token, { secret: env.JWT_ACCESS_SECRET });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    const cached = userCache.get(payload.sub);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      req.user = cached.user;
      return true;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('User is inactive');

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      roleName: user.role.name,
      permissions: user.role.permissions,
    };
    userCache.set(user.id, { user: authUser, at: Date.now() });
    req.user = authUser;
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const user: AuthUser | undefined = context.switchToHttp().getRequest().user;
    if (!user) return false;
    const missing = required.filter((p) => !hasPermission(user.permissions, p));
    if (missing.length) throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    return true;
  }
}
