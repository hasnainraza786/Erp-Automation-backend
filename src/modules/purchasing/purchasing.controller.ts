import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ApiFile, ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { Idempotent } from '../../common/idempotency.interceptor';
import { PERMISSIONS as P } from '../../common/permissions';
import { VoidDto, zPageQuery } from '../../common/schemas';
import { createDto } from '../../common/dto';
import {
  AdjustStockDto,
  CreatePurchaseOrderDto,
  FromShortageDto,
  InventoryQueryDto,
  InventoryTxnPageDto,
  PurchaseOrderDto,
  PurchaseOrderListDto,
  PurchaseOrderPageDto,
  PurchaseOrderQueryDto,
  ReceivePurchaseOrderDto,
  StockPageDto,
  UpdatePurchaseOrderDto,
} from './purchasing.schemas';
import { PurchasingService } from './purchasing.service';

class PageQueryDto extends createDto(zPageQuery.pick({ page: true, pageSize: true })) {}

@ApiTags('purchasing')
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Get()
  @RequirePermission(P.PURCHASE_VIEW)
  @ApiOk(PurchaseOrderPageDto)
  listPurchaseOrders(@Query() q: PurchaseOrderQueryDto) {
    return this.purchasing.list(q);
  }

  @Get(':id')
  @RequirePermission(P.PURCHASE_VIEW)
  @ApiOk(PurchaseOrderDto)
  getPurchaseOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.get(id);
  }

  @Get(':id/pdf')
  @RequirePermission(P.PURCHASE_VIEW)
  @ApiFile('application/pdf')
  async downloadPurchaseOrderPdf(@Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    const f = await this.purchasing.renderPdf(id);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${f.fileName}"`).send(f.buffer);
  }

  @Post()
  @RequirePermission(P.PURCHASE_MANAGE)
  @ApiOk(PurchaseOrderDto)
  createPurchaseOrder(@CurrentUser() user: AuthUser, @Body() body: CreatePurchaseOrderDto) {
    return this.purchasing.create(user, body);
  }

  @Post('from-shortage')
  @HttpCode(200)
  @RequirePermission(P.PURCHASE_MANAGE)
  @ApiOk(PurchaseOrderListDto)
  createPurchaseOrdersFromShortage(@CurrentUser() user: AuthUser, @Body() body: FromShortageDto) {
    return this.purchasing.fromShortage(user, body);
  }

  @Put(':id')
  @RequirePermission(P.PURCHASE_MANAGE)
  @ApiOk(PurchaseOrderDto)
  updatePurchaseOrder(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdatePurchaseOrderDto) {
    return this.purchasing.update(user, id, body);
  }

  @Post(':id/send')
  @HttpCode(200)
  @RequirePermission(P.PURCHASE_MANAGE)
  @ApiOk(PurchaseOrderDto)
  sendPurchaseOrder(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.send(user, id);
  }

  @Post(':id/receive')
  @HttpCode(200)
  @RequirePermission(P.PURCHASE_MANAGE)
  @Idempotent()
  @ApiOk(PurchaseOrderDto)
  receivePurchaseOrder(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReceivePurchaseOrderDto) {
    return this.purchasing.receive(user, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission(P.PURCHASE_MANAGE)
  @ApiOk(PurchaseOrderDto)
  cancelPurchaseOrder(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: VoidDto) {
    return this.purchasing.cancel(user, id, body.reason);
  }
}

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Get()
  @RequirePermission(P.INVENTORY_VIEW)
  @ApiOk(StockPageDto)
  listStock(@CurrentUser() user: AuthUser, @Query() q: InventoryQueryDto) {
    return this.purchasing.stockList(user, q);
  }

  @Get(':productId/transactions')
  @RequirePermission(P.INVENTORY_VIEW)
  @ApiOk(InventoryTxnPageDto)
  listInventoryTransactions(@Param('productId', ParseUUIDPipe) productId: string, @Query() q: PageQueryDto) {
    return this.purchasing.transactions(productId, q);
  }

  @Post('adjust')
  @HttpCode(200)
  @RequirePermission(P.INVENTORY_MANAGE)
  @ApiOk(InventoryTxnPageDto)
  adjustStock(@CurrentUser() user: AuthUser, @Body() body: AdjustStockDto) {
    return this.purchasing.adjust(user, body);
  }
}
