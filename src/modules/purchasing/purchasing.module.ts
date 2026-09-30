import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { InventoryController, PurchaseOrdersController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';

@Module({
  imports: [ProjectsModule],
  controllers: [PurchaseOrdersController, InventoryController],
  providers: [PurchasingService],
})
export class PurchasingModule {}
