import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ApiExcludeController } from '@nestjs/swagger';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from './common/auth.decorators';
import { JwtAuthGuard, PermissionsGuard } from './common/guards';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { ProblemFilter } from './common/problem.filter';
import { InfraModule } from './infra/infra.module';
import { PrismaService } from './infra/prisma.service';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { ClientsModule } from './modules/clients/clients.module';
import { FinanceModule } from './modules/finance/finance.module';
import { InsightsModule } from './modules/insights/insights.module';
import { ProductsModule } from './modules/products/products.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { QuotationsModule } from './modules/quotations/quotations.module';
import { SitesModule } from './modules/sites/sites.module';
import { SystemModule } from './modules/system/system.module';
import { VendorsModule } from './modules/vendors/vendors.module';

@ApiExcludeController()
@Controller()
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    InfraModule,
    JwtModule.register({ global: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    AuthModule,
    ClientsModule,
    SitesModule,
    ProductsModule,
    VendorsModule,
    QuotationsModule,
    ProjectsModule,
    FinanceModule,
    PurchasingModule,
    InsightsModule,
    AdminModule,
    SystemModule,
  ],
  controllers: [HealthController],
  providers: [
    IdempotencyInterceptor,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
