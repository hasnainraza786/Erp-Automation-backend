import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env';
import { AuditService } from '../../infra/audit.service';
import { PrismaService } from '../../infra/prisma.service';
import type { AuthUser } from '../../common/auth.decorators';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

function ttlSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 900;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { email }, include: { role: true } });
    if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log(
      { id: user.id, name: user.name, email: user.email, roleName: user.role.name, permissions: [] },
      { action: 'auth.login', entityType: 'User', entityId: user.id, summary: `${user.name} signed in` },
    );
    return this.issue(user.id, userAgent);
  }

  /** Rotates the refresh token: the presented token is revoked and a new pair is issued. */
  async refresh(refreshToken: string, userAgent?: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
    if (!row || row.expiresAt < new Date()) throw new UnauthorizedException('Refresh token expired');
    if (row.revokedAt) {
      // Reuse of a rotated token suggests theft: revoke every session of this user.
      await this.prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException('Refresh token already used');
    }
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return this.issue(row.userId, userAgent);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(user: AuthUser, currentPassword: string, newPassword: string) {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(currentPassword, row.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } });
    await this.prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log(user, { action: 'auth.password_changed', entityType: 'User', entityId: user.id });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { role: true } });
    return { id: user.id, email: user.email, name: user.name, role: user.role.name, permissions: user.role.permissions };
  }

  private async issue(userId: string, userAgent?: string) {
    const user = await this.me(userId);
    if (!user) throw new UnauthorizedException();
    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      { secret: env.JWT_ACCESS_SECRET, expiresIn: ttlSeconds(env.JWT_ACCESS_TTL) },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + env.REFRESH_TTL_DAYS * 86400_000),
        userAgent: userAgent?.slice(0, 250),
      },
    });
    return { accessToken, refreshToken, expiresIn: ttlSeconds(env.JWT_ACCESS_TTL), user };
  }
}
