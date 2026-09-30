import { Module } from '@nestjs/common';
import { InsightsModule } from '../insights/insights.module';
import { BackupsService } from './backups.service';
import { DataIoService } from './data-io.service';
import { DocumentsService } from './documents.service';
import { JobsService } from './jobs.service';
import {
  BackupsController,
  CompanyLogoController,
  DataIoController,
  DocumentsController,
  InboxService,
  NotificationsController,
  SystemController,
} from './system.controller';

@Module({
  imports: [InsightsModule],
  controllers: [NotificationsController, DocumentsController, CompanyLogoController, DataIoController, BackupsController, SystemController],
  providers: [InboxService, DocumentsService, DataIoService, BackupsService, JobsService],
})
export class SystemModule {}
