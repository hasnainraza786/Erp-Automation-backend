import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { OkDto } from '../../common/schemas';
import {
  AuditLogPageDto,
  AuditQueryDto,
  CreateRoleDto,
  CreateSpacePresetDto,
  CreateUserDto,
  PermissionCatalogDto,
  ResetPasswordDto,
  RoleDto,
  RoleListDto,
  SettingsDto,
  SpacePresetDto,
  SpacePresetListDto,
  UpdateAccountingSettingsDto,
  UpdateCompanySettingsDto,
  UpdateInvoiceSettingsDto,
  UpdateNumberingSettingsDto,
  UpdateQuotationSettingsDto,
  UpdateRoleDto,
  UpdateSpacePresetDto,
  UpdateUserDto,
  UserDto,
  UserListDto,
} from './admin.schemas';
import { AdminService } from './admin.service';

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(UserListDto)
  listUsers() {
    return this.admin.listUsers();
  }

  @Post('users')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(UserDto)
  createUser(@CurrentUser() user: AuthUser, @Body() body: CreateUserDto) {
    return this.admin.createUser(user, body);
  }

  @Patch('users/:id')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(UserDto)
  updateUser(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateUserDto) {
    return this.admin.updateUser(user, id, body);
  }

  @Post('users/:id/reset-password')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(OkDto)
  resetUserPassword(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: ResetPasswordDto) {
    return this.admin.resetPassword(user, id, body.password);
  }

  @Get('roles')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(RoleListDto)
  listRoles() {
    return this.admin.listRoles();
  }

  @Get('roles/permissions')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(PermissionCatalogDto)
  getPermissionCatalog() {
    return this.admin.permissionCatalog();
  }

  @Post('roles')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(RoleDto)
  createRole(@CurrentUser() user: AuthUser, @Body() body: CreateRoleDto) {
    return this.admin.createRole(user, body);
  }

  @Patch('roles/:id')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(RoleDto)
  updateRole(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRoleDto) {
    return this.admin.updateRole(user, id, body);
  }

  @Delete('roles/:id')
  @RequirePermission(P.USER_MANAGE)
  @ApiOk(OkDto)
  deleteRole(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.deleteRole(user, id);
  }
}

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly admin: AdminService) {}

  /** Readable by every signed-in user: the UI needs company details, terms and tax defaults. */
  @Get()
  @ApiOk(SettingsDto)
  getSettings() {
    return this.admin.allSettings();
  }

  @Put('company')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(SettingsDto)
  updateCompanySettings(@CurrentUser() user: AuthUser, @Body() body: UpdateCompanySettingsDto) {
    return this.admin.updateSetting(user, 'company', body);
  }

  @Put('quotation')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(SettingsDto)
  updateQuotationSettings(@CurrentUser() user: AuthUser, @Body() body: UpdateQuotationSettingsDto) {
    return this.admin.updateSetting(user, 'quotation', body);
  }

  @Put('accounting')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(SettingsDto)
  updateAccountingSettings(@CurrentUser() user: AuthUser, @Body() body: UpdateAccountingSettingsDto) {
    return this.admin.updateSetting(user, 'accounting', body);
  }

  @Put('invoice')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(SettingsDto)
  updateInvoiceSettings(@CurrentUser() user: AuthUser, @Body() body: UpdateInvoiceSettingsDto) {
    return this.admin.updateSetting(user, 'invoice', body);
  }

  @Put('numbering')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(SettingsDto)
  updateNumberingSettings(@CurrentUser() user: AuthUser, @Body() body: UpdateNumberingSettingsDto) {
    return this.admin.updateNumbering(user, body as Record<string, { prefix: string; yearly: boolean; padding: number }>);
  }

  @Get('space-presets')
  @ApiOk(SpacePresetListDto)
  listSpacePresets() {
    return this.admin.listSpacePresets();
  }

  @Post('space-presets')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(SpacePresetDto)
  createSpacePreset(@Body() body: CreateSpacePresetDto) {
    return this.admin.createSpacePreset(body);
  }

  @Patch('space-presets/:id')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(SpacePresetDto)
  updateSpacePreset(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSpacePresetDto) {
    return this.admin.updateSpacePreset(id, body);
  }
}

@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @RequirePermission(P.AUDIT_VIEW)
  @ApiOk(AuditLogPageDto)
  listAuditLogs(@Query() q: AuditQueryDto) {
    return this.admin.auditLogs(q);
  }
}
