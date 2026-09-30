import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ApiFile, ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { Idempotent } from '../../common/idempotency.interceptor';
import { PERMISSIONS as P } from '../../common/permissions';
import { VoidDto } from '../../common/schemas';
import { ExpensesService } from './expenses.service';
import {
  AllocatePaymentDto,
  CreateExpenseDto,
  CreateInvoiceDto,
  CreatePaymentDto,
  ExpenseDto,
  ExpensePageDto,
  ExpenseQueryDto,
  InvoiceDto,
  InvoicePageDto,
  InvoiceQueryDto,
  LedgerDto,
  LedgerQueryDto,
  OpenItemsDto,
  PaymentDto,
  PaymentPageDto,
  PaymentQueryDto,
} from './finance.schemas';
import { InvoicesService } from './invoices.service';
import { LedgersService } from './ledgers.service';
import { PaymentsService } from './payments.service';

function sendPdf(reply: FastifyReply, file: { buffer: Buffer; fileName: string }) {
  reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${file.fileName}"`).send(file.buffer);
}

@ApiTags('invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermission(P.INVOICE_VIEW)
  @ApiOk(InvoicePageDto)
  listInvoices(@Query() q: InvoiceQueryDto) {
    return this.invoices.list(q);
  }

  @Get(':id')
  @RequirePermission(P.INVOICE_VIEW)
  @ApiOk(InvoiceDto)
  getInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(id);
  }

  @Get(':id/pdf')
  @RequirePermission(P.INVOICE_VIEW)
  @ApiFile('application/pdf')
  async downloadInvoicePdf(@Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    sendPdf(reply, await this.invoices.renderPdf(id));
  }

  @Post()
  @RequirePermission(P.INVOICE_MANAGE)
  @ApiOk(InvoiceDto)
  createInvoice(@CurrentUser() user: AuthUser, @Body() body: CreateInvoiceDto) {
    return this.invoices.create(user, body);
  }

  @Post(':id/issue')
  @HttpCode(200)
  @RequirePermission(P.INVOICE_MANAGE)
  @ApiOk(InvoiceDto)
  issueInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.issue(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission(P.INVOICE_MANAGE)
  @ApiOk(InvoiceDto)
  cancelInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: VoidDto) {
    return this.invoices.cancel(user, id, body.reason);
  }
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermission(P.PAYMENT_VIEW)
  @ApiOk(PaymentPageDto)
  listPayments(@Query() q: PaymentQueryDto) {
    return this.payments.list(q);
  }

  @Get('open-items/:clientId')
  @RequirePermission(P.PAYMENT_VIEW)
  @ApiOk(OpenItemsDto)
  getClientOpenItems(@Param('clientId', ParseUUIDPipe) clientId: string) {
    return this.payments.openItems(clientId);
  }

  @Get(':id')
  @RequirePermission(P.PAYMENT_VIEW)
  @ApiOk(PaymentDto)
  getPayment(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(id);
  }

  @Post()
  @RequirePermission(P.PAYMENT_CREATE)
  @Idempotent()
  @ApiOk(PaymentDto)
  createPayment(@CurrentUser() user: AuthUser, @Body() body: CreatePaymentDto) {
    return this.payments.create(user, body);
  }

  @Post(':id/allocate')
  @HttpCode(200)
  @RequirePermission(P.PAYMENT_CREATE)
  @Idempotent()
  @ApiOk(PaymentDto)
  allocatePayment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: AllocatePaymentDto) {
    return this.payments.allocate(user, id, body);
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermission(P.PAYMENT_VOID)
  @ApiOk(PaymentDto)
  voidPayment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: VoidDto) {
    return this.payments.void(user, id, body.reason);
  }
}

@ApiTags('ledgers')
@Controller('ledgers')
export class LedgersController {
  constructor(private readonly ledgers: LedgersService) {}

  @Get('clients/:clientId')
  @RequirePermission(P.LEDGER_VIEW)
  @ApiOk(LedgerDto)
  getClientLedger(@Param('clientId', ParseUUIDPipe) clientId: string, @Query() q: LedgerQueryDto) {
    return this.ledgers.clientLedger(clientId, q);
  }

  @Get('clients/:clientId/statement.pdf')
  @RequirePermission(P.LEDGER_VIEW)
  @ApiFile('application/pdf')
  async downloadClientStatement(@Param('clientId', ParseUUIDPipe) clientId: string, @Query() q: LedgerQueryDto, @Res() reply: FastifyReply) {
    sendPdf(reply, await this.ledgers.statementPdf('client', clientId, q));
  }

  @Get('vendors/:vendorId')
  @RequirePermission(P.LEDGER_VIEW)
  @ApiOk(LedgerDto)
  getVendorLedger(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() q: LedgerQueryDto) {
    return this.ledgers.vendorLedger(vendorId, q);
  }

  @Get('vendors/:vendorId/statement.pdf')
  @RequirePermission(P.LEDGER_VIEW)
  @ApiFile('application/pdf')
  async downloadVendorStatement(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() q: LedgerQueryDto, @Res() reply: FastifyReply) {
    sendPdf(reply, await this.ledgers.statementPdf('vendor', vendorId, q));
  }
}

@ApiTags('expenses')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermission(P.EXPENSE_VIEW)
  @ApiOk(ExpensePageDto)
  listExpenses(@Query() q: ExpenseQueryDto) {
    return this.expenses.list(q);
  }

  @Post()
  @RequirePermission(P.EXPENSE_MANAGE)
  @ApiOk(ExpenseDto)
  createExpense(@CurrentUser() user: AuthUser, @Body() body: CreateExpenseDto) {
    return this.expenses.create(user, body);
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermission(P.EXPENSE_MANAGE)
  @ApiOk(ExpenseDto)
  voidExpense(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: VoidDto) {
    return this.expenses.void(user, id, body.reason);
  }
}
