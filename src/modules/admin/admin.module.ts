import { Module } from '@nestjs/common';
import { AuditController, SettingsController, UsersController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  controllers: [UsersController, SettingsController, AuditController],
  providers: [AdminService],
})
export class AdminModule {}
