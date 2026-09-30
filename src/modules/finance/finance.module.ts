import { Module } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { ExpensesController, InvoicesController, LedgersController, PaymentsController } from './finance.controller';
import { InvoicesService } from './invoices.service';
import { LedgersService } from './ledgers.service';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [InvoicesController, PaymentsController, LedgersController, ExpensesController],
  providers: [InvoicesService, PaymentsService, LedgersService, ExpensesService],
  exports: [LedgersService],
})
export class FinanceModule {}
