import { Module } from '@nestjs/common';
import { QuotationPdfService } from './quotation-pdf.service';
import { QuotationsController } from './quotations.controller';
import { QuotationsService } from './quotations.service';

@Module({
  controllers: [QuotationsController],
  providers: [QuotationsService, QuotationPdfService],
  exports: [QuotationsService],
})
export class QuotationsModule {}
