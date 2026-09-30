import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { JournalService } from './journal.service';
import { NotificationsService } from './notifications.service';
import { NumberingService } from './numbering.service';
import { PdfService } from './pdf.service';
import { PrismaService } from './prisma.service';
import { SettingsService } from './settings.service';
import { StockService } from './stock.service';
import { StorageService } from './storage.service';

const services = [
  PrismaService,
  NumberingService,
  AuditService,
  JournalService,
  SettingsService,
  NotificationsService,
  StockService,
  StorageService,
  PdfService,
];

@Global()
@Module({ providers: services, exports: services })
export class InfraModule {}
