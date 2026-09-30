import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { AuthUser } from '../../common/auth.decorators';
import { invalidateUserCache } from '../../common/guards';
import { ALL_PERMISSIONS, WILDCARD } from '../../common/permissions';
import { dateRangeWhere, pageArgs, pageMeta, plain } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { DEFAULT_NUMBERING, DocType } from '../../infra/numbering.service';
import { PrismaService } from '../../infra/prisma.service';
import { SettingKey, SettingsService } from '../../infra/settings.service';
import {
  AuditQueryDto,
  CreateRoleDto,
  CreateSpacePresetDto,
  CreateUserDto,
  UpdateRoleDto,
  UpdateSpacePresetDto,
  UpdateUserDto,
} from './admin.schemas';

const GROUP_LABELS: Record<string, string> = {
  dashboard: 'Dashboard', client: 'Clients', site: 'Sites', product: 'Products', vendor: 'Vendors',
  quotation: 'Quotations', project: 'Projects', invoice: 'Invoices', payment: 'Payments', ledger: 'Ledgers',
  expense: 'Expenses', purchase: 'Purchasing', inventory: 'Inventory', report: 'Reports', settings: 'Settings',
  user: 'Users', audit: 'Audit', backup: 'Backups', data: 'Import / Export',
};

const userSelect = {
  id: true, email: true, name: true, phone: true, isActive: true, lastLoginAt: true, createdAt: true,
  role: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // ─────────── users ───────────

  async listUsers() {
    return plain(await this.prisma.user.findMany({ select: userSelect, orderBy: { name: 'asc' } }));
  }

  async createUser(actor: AuthUser, dto: CreateUserDto) {
    const user = await this.prisma.user.create({
      data: { email: dto.email, name: dto.name, phone: dto.phone, roleId: dto.roleId, passwordHash: await bcrypt.hash(dto.password, 10) },
      select: userSelect,
    });
    await this.audit.log(actor, { action: 'user.created', entityType: 'User', entityId: user.id, summary: `User ${user.email} created as ${user.role.name}` });
    return plain(user);
  }

  async updateUser(actor: AuthUser, id: string, dto: UpdateUserDto) {
    if (id === actor.id && (dto.isActive === false || dto.roleId)) throw new BadRequestException('You cannot deactivate yourself or change your own role');
    const before = await this.prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!before) throw new NotFoundException('User not found');
    if (dto.isActive === false || dto.roleId) await this.assertAdminRemains(id, dto.roleId);
    const user = await this.prisma.user.update({ where: { id }, data: dto, select: userSelect });
    if (dto.isActive === false) await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    invalidateUserCache(id);
    await this.audit.log(actor, { action: 'user.updated', entityType: 'User', entityId: id, summary: `User ${user.email} updated`, before, after: user });
    return plain(user);
  }

  async resetPassword(actor: AuthUser, id: string, password: string) {
    const user = await this.prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(password, 10) } });
    await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log(actor, { action: 'user.password_reset', entityType: 'User', entityId: id, summary: `Password reset for ${user.email}` });
    return { ok: true };
  }

  /** Prevents locking everyone out by removing the last active full-access user. */
  private async assertAdminRemains(changingUserId: string, newRoleId?: string) {
    const admins = await this.prisma.user.findMany({ where: { isActive: true, role: { permissions: { has: WILDCARD } } }, select: { id: true } });
    if (!admins.some((a) => a.id === changingUserId)) return;
    if (newRoleId) {
      const role = await this.prisma.role.findUniqueOrThrow({ where: { id: newRoleId } });
      if (role.permissions.includes(WILDCARD)) return;
    }
    if (admins.length <= 1) throw new ConflictException('At least one active administrator is required');
  }

  // ─────────── roles ───────────

  permissionCatalog() {
    const groups = new Map<string, { key: string; label: string }[]>();
    for (const key of ALL_PERMISSIONS) {
      const [group, action] = key.split(':');
      const list = groups.get(group) ?? [];
      list.push({ key, label: action.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) });
      groups.set(group, list);
    }
    return [...groups.entries()].map(([g, permissions]) => ({ group: GROUP_LABELS[g] ?? g, permissions }));
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({ include: { _count: { select: { users: true } } }, orderBy: { name: 'asc' } });
    return roles.map(({ _count, createdAt: _c, updatedAt: _u, ...r }) => ({ ...r, userCount: _count.users }));
  }

  private validatePermissions(perms: string[]) {
    const unknown = perms.filter((p) => p !== WILDCARD && !(ALL_PERMISSIONS as string[]).includes(p));
    if (unknown.length) throw new BadRequestException(`Unknown permissions: ${unknown.join(', ')}`);
    return [...new Set(perms)];
  }

  async createRole(actor: AuthUser, dto: CreateRoleDto) {
    const role = await this.prisma.role.create({ data: { name: dto.name, description: dto.description, permissions: this.validatePermissions(dto.permissions) } });
    await this.audit.log(actor, { action: 'role.created', entityType: 'Role', entityId: role.id, summary: `Role ${role.name} created`, after: role });
    return { ...role, userCount: 0 };
  }

  async updateRole(actor: AuthUser, id: string, dto: UpdateRoleDto) {
    const before = await this.prisma.role.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Role not found');
    if (before.isSystem && before.permissions.includes(WILDCARD) && dto.permissions && !dto.permissions.includes(WILDCARD)) {
      throw new BadRequestException('The Admin role must keep full access');
    }
    const role = await this.prisma.role.update({
      where: { id },
      data: { name: before.isSystem ? undefined : dto.name, description: dto.description, permissions: dto.permissions ? this.validatePermissions(dto.permissions) : undefined },
      include: { _count: { select: { users: true } } },
    });
    invalidateUserCache();
    await this.audit.log(actor, { action: 'role.updated', entityType: 'Role', entityId: id, summary: `Role ${role.name} updated`, before, after: role });
    const { _count, createdAt: _c, updatedAt: _u, ...rest } = role;
    return { ...rest, userCount: _count.users };
  }

  async deleteRole(actor: AuthUser, id: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new BadRequestException('System roles cannot be deleted');
    if (role._count.users) throw new ConflictException('Reassign the users of this role before deleting it');
    await this.prisma.role.delete({ where: { id } });
    await this.audit.log(actor, { action: 'role.deleted', entityType: 'Role', entityId: id, summary: `Role ${role.name} deleted`, before: role });
    return { ok: true };
  }

  // ─────────── settings ───────────

  async allSettings() {
    const [company, quotation, accounting, invoice, numbering] = await Promise.all([
      this.settings.get('company'),
      this.settings.get('quotation'),
      this.settings.get('accounting'),
      this.settings.get('invoice'),
      this.settings.getRaw('numbering'),
    ]);
    const merged: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(DEFAULT_NUMBERING)) merged[k] = { ...v, ...(((numbering ?? {}) as Record<string, object>)[k] ?? {}) };
    return { company, quotation, accounting, invoice, numbering: merged };
  }

  async updateSetting<K extends SettingKey>(actor: AuthUser, key: K, input: object) {
    const value = input as Record<string, unknown>;
    if (key === 'quotation' && Array.isArray(value.defaultPaymentSchedule)) {
      const total = (value.defaultPaymentSchedule as { percent: number }[]).reduce((s, x) => s + x.percent, 0);
      if (Math.abs(total - 100) > 0.001) throw new BadRequestException('Payment schedule must total 100%');
    }
    if (key === 'accounting' && value.receivableOn) {
      const current = await this.settings.get('accounting');
      if (current.receivableOn !== value.receivableOn && (await this.prisma.project.count()) > 0) {
        throw new ConflictException('The receivable posting mode cannot change once projects exist');
      }
    }
    const before = await this.settings.get(key);
    const after = await this.settings.set(key, value as never);
    await this.audit.log(actor, { action: 'settings.updated', entityType: 'Setting', entityId: undefined, summary: `Settings "${key}" updated`, before, after });
    return this.allSettings();
  }

  async updateNumbering(actor: AuthUser, value: Record<string, { prefix: string; yearly: boolean; padding: number }>) {
    const unknown = Object.keys(value).filter((k) => !(k in DEFAULT_NUMBERING));
    if (unknown.length) throw new BadRequestException(`Unknown document types: ${unknown.join(', ')}`);
    const before = await this.settings.getRaw('numbering');
    const merged = { ...((before ?? {}) as object), ...value } as Partial<Record<DocType, object>>;
    await this.settings.setRaw('numbering', merged as Prisma.InputJsonValue);
    await this.audit.log(actor, { action: 'settings.updated', entityType: 'Setting', summary: 'Numbering formats updated', before, after: merged });
    return this.allSettings();
  }

  // ─────────── space presets ───────────

  listSpacePresets() {
    return this.prisma.spacePreset.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  createSpacePreset(dto: CreateSpacePresetDto) {
    return this.prisma.spacePreset.create({ data: dto });
  }

  updateSpacePreset(id: string, dto: UpdateSpacePresetDto) {
    return this.prisma.spacePreset.update({ where: { id }, data: dto });
  }

  // ─────────── audit ───────────

  async auditLogs(q: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      entityType: q.entityType,
      entityId: q.entityId,
      actorId: q.actorId,
      action: q.action ? { startsWith: q.action } : undefined,
      createdAt: dateRangeWhere(q),
      ...(q.q ? { OR: [{ summary: { contains: q.q, mode: 'insensitive' } }, { actorName: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data: plain(rows.map(({ ip: _ip, ...r }) => r)), meta: pageMeta(q, total) };
  }
}
