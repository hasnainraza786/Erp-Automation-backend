import { Module } from '@nestjs/common';
import { DashboardController, ReportsController, SearchController } from './insights.controller';
import { InsightsService } from './insights.service';

@Module({
  controllers: [DashboardController, ReportsController, SearchController],
  providers: [InsightsService],
  exports: [InsightsService],
})
export class InsightsModule {}
