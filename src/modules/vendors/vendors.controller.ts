import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { Idempotent } from '../../common/idempotency.interceptor';
import { PERMISSIONS as P } from '../../common/permissions';
import { VoidDto } from '../../common/schemas';
import {
  CreateVendorDto,
  CreateVendorPaymentDto,
  UpdateVendorDto,
  VendorDto,
  VendorPageDto,
  VendorPaymentDto,
  VendorPaymentPageDto,
  VendorPaymentQueryDto,
  VendorQueryDto,
} from './vendors.schemas';
import { VendorsService } from './vendors.service';

@ApiTags('vendors')
@Controller()
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get('vendors')
  @RequirePermission(P.VENDOR_VIEW)
  @ApiOk(VendorPageDto)
  listVendors(@Query() q: VendorQueryDto) {
    return this.vendors.list(q);
  }

  @Get('vendors/:id')
  @RequirePermission(P.VENDOR_VIEW)
  @ApiOk(VendorDto)
  getVendor(@Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.get(id);
  }

  @Post('vendors')
  @RequirePermission(P.VENDOR_MANAGE)
  @ApiOk(VendorDto)
  createVendor(@CurrentUser() user: AuthUser, @Body() body: CreateVendorDto) {
    return this.vendors.create(user, body);
  }

  @Patch('vendors/:id')
  @RequirePermission(P.VENDOR_MANAGE)
  @ApiOk(VendorDto)
  updateVendor(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateVendorDto) {
    return this.vendors.update(user, id, body);
  }

  @Get('vendor-payments')
  @RequirePermission(P.PURCHASE_VIEW)
  @ApiOk(VendorPaymentPageDto)
  listVendorPayments(@Query() q: VendorPaymentQueryDto) {
    return this.vendors.listPayments(q);
  }

  @Post('vendor-payments')
  @RequirePermission(P.PAYMENT_CREATE)
  @Idempotent()
  @ApiOk(VendorPaymentDto)
  createVendorPayment(@CurrentUser() user: AuthUser, @Body() body: CreateVendorPaymentDto) {
    return this.vendors.createPayment(user, body);
  }

  @Post('vendor-payments/:id/void')
  @HttpCode(200)
  @RequirePermission(P.PAYMENT_VOID)
  @ApiOk(VendorPaymentDto)
  voidVendorPayment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: VoidDto) {
    return this.vendors.voidPayment(user, id, body.reason);
  }
}
