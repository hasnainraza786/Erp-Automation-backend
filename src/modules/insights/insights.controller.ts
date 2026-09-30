import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import {
  AccountsDashboardDto,
  AgingReportDto,
  DashboardDto,
  DateRangeQueryDto,
  PaymentsReportDto,
  ProductSalesReportDto,
  ProfitabilityQueryDto,
  ProfitabilityReportDto,
  SalesReportDto,
  SalesReportQueryDto,
  SearchQueryDto,
  SearchResultDto,
} from './insights.schemas';
import { InsightsService } from './insights.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  @RequirePermission(P.DASHBOARD_VIEW)
  @ApiOk(DashboardDto)
  getDashboard(@CurrentUser() user: AuthUser, @Query() q: DateRangeQueryDto) {
    return this.insights.dashboard(user, q);
  }

  @Get('accounts')
  @RequirePermission(P.LEDGER_VIEW)
  @ApiOk(AccountsDashboardDto)
  getAccountsDashboard() {
    return this.insights.accountsDashboard();
  }
}

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('sales')
  @RequirePermission(P.REPORT_VIEW)
  @ApiOk(SalesReportDto)
  getSalesReport(@Query() q: SalesReportQueryDto) {
    return this.insights.salesReport(q);
  }

  @Get('receivables-aging')
  @RequirePermission(P.REPORT_VIEW)
  @ApiOk(AgingReportDto)
  getReceivablesAging() {
    return this.insights.receivablesAging();
  }

  @Get('payables-aging')
  @RequirePermission(P.REPORT_VIEW)
  @ApiOk(AgingReportDto)
  getPayablesAging() {
    return this.insights.payablesAging();
  }

  @Get('project-profitability')
  @RequirePermission(P.REPORT_VIEW, P.PRODUCT_COST_VIEW)
  @ApiOk(ProfitabilityReportDto)
  getProjectProfitability(@Query() q: ProfitabilityQueryDto) {
    return this.insights.profitability(q);
  }

  @Get('product-sales')
  @RequirePermission(P.REPORT_VIEW)
  @ApiOk(ProductSalesReportDto)
  getProductSales(@Query() q: DateRangeQueryDto) {
    return this.insights.productSales(q);
  }

  @Get('payments')
  @RequirePermission(P.REPORT_VIEW)
  @ApiOk(PaymentsReportDto)
  getPaymentsReport(@Query() q: DateRangeQueryDto) {
    return this.insights.paymentsReport(q);
  }
}

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  @ApiOk(SearchResultDto)
  globalSearch(@CurrentUser() user: AuthUser, @Query() q: SearchQueryDto) {
    return this.insights.search(user, q.q);
  }
}
