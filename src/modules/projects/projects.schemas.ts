import { z } from 'zod';
import { createDto } from '../../common/dto';
import { paginated, zDateInput, zMoney, zPageQuery, zQty, zQtyInput } from '../../common/schemas';

export const zProjectStatus = z.enum(['APPROVED', 'PROCUREMENT', 'INSTALLATION', 'TESTING', 'COMPLETED', 'ON_HOLD', 'CANCELLED']);
export const zTaskStatus = z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
export const zMilestoneStatus = z.enum(['PENDING', 'INVOICED', 'PARTIALLY_RECEIVED', 'RECEIVED']);

export const PROGRESS_STAGES = ['quotation', 'approval', 'procurement', 'delivery', 'installation', 'programming', 'testing', 'handover'] as const;
export const zProgress = z.object(Object.fromEntries(PROGRESS_STAGES.map((s) => [s, z.number().min(0).max(100)])) as Record<(typeof PROGRESS_STAGES)[number], z.ZodNumber>);

export const zProjectQuery = zPageQuery.extend({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  status: zProjectStatus.optional(),
  active: z.enum(['true', 'false']).optional(),
});
export class ProjectQueryDto extends createDto(zProjectQuery) {}

export const zFinancials = z.object({
  contractValue: zMoney,
  revenueExTax: zMoney,
  taxTotal: zMoney,
  invoiced: zMoney,
  received: zMoney,
  balanceToCollect: zMoney,
  outstanding: zMoney,
  estimatedProductCost: zMoney,
  actualProductCost: zMoney,
  expenses: zMoney,
  expensesByCategory: z.array(z.object({ category: z.string(), amount: zMoney })),
  estimatedCost: zMoney,
  estimatedProfit: zMoney,
  estimatedMargin: z.string(),
  actualProfit: zMoney,
  actualMargin: z.string(),
});

const zRef = z.object({ id: z.string(), name: z.string(), code: z.string() });

export const zProjectListItem = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string(),
  status: zProjectStatus,
  contractValue: zMoney,
  received: zMoney,
  outstanding: zMoney,
  overallProgress: z.number(),
  startDate: z.string().nullable(),
  expectedCompletion: z.string().nullable(),
  client: zRef,
  site: zRef,
  quotation: z.object({ id: z.string(), number: z.string() }),
  createdAt: z.string(),
});
export class ProjectPageDto extends createDto(paginated(zProjectListItem)) {}

export const zProjectItem = z.object({
  id: z.string(),
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  requiredQty: zQty,
  reservedQty: zQty,
  purchasedQty: zQty,
  receivedQty: zQty,
  deliveredQty: zQty,
  installedQty: zQty,
  remainingQty: zQty.describe('Required − installed'),
  unitPrice: zMoney,
  unitCost: zMoney.nullable(),
});

export const zMilestone = z.object({
  id: z.string(),
  name: z.string(),
  percent: z.string(),
  amount: zMoney,
  dueDate: z.string().nullable(),
  status: zMilestoneStatus,
  invoiceId: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
});

export const zTask = z.object({
  id: z.string(),
  name: z.string(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  dueDate: z.string().nullable(),
  status: zTaskStatus,
  notes: z.string().nullable(),
  sortOrder: z.number(),
});
export class TaskDto extends createDto(zTask) {}

export const zProjectDetail = zProjectListItem.extend({
  version: z.number(),
  revisionNo: z.number(),
  completedAt: z.string().nullable(),
  progress: zProgress,
  financials: zFinancials,
  items: z.array(zProjectItem),
  spaces: z.array(z.object({ name: z.string(), items: z.array(z.object({ productId: z.string(), name: z.string(), qty: z.string() })) })),
  milestones: z.array(zMilestone),
  tasks: z.array(zTask),
});
export class ProjectDetailDto extends createDto(zProjectDetail) {}

export const zProcurementLine = z.object({
  projectItemId: z.string(),
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  supplierId: z.string().nullable(),
  supplierName: z.string().nullable(),
  required: zQty,
  delivered: zQty,
  reservedForProject: zQty,
  onOrder: zQty,
  availableStock: zQty.describe('Free (unreserved) stock in the warehouse'),
  toPurchase: zQty,
  unitCost: zMoney.nullable(),
});
export class ProcurementListDto extends createDto(z.array(zProcurementLine)) {}

export const zUpdateStatus = z.object({ status: zProjectStatus, note: z.string().max(1000).optional(), version: z.number().int() });
export class UpdateProjectStatusDto extends createDto(zUpdateStatus) {}

export const zUpdateProgress = z.object({ progress: zProgress.partial() });
export class UpdateProjectProgressDto extends createDto(zUpdateProgress) {}

export const zUpdateProject = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  expectedCompletion: zDateInput.optional().nullable(),
  startDate: zDateInput.optional().nullable(),
});
export class UpdateProjectDto extends createDto(zUpdateProject) {}

export const zDeliverItem = z.object({ qty: zQtyInput, notes: z.string().max(500).optional() });
export class DeliverItemDto extends createDto(zDeliverItem) {}

export const zInstallItem = z.object({ installedQty: zQtyInput });
export class InstallItemDto extends createDto(zInstallItem) {}

export const zTaskInput = z.object({
  name: z.string().trim().min(2).max(200),
  assigneeId: z.string().uuid().optional().nullable(),
  dueDate: zDateInput.optional().nullable(),
  status: zTaskStatus.default('TODO'),
  notes: z.string().max(4000).optional().nullable(),
  sortOrder: z.number().int().default(0),
});
export class CreateTaskDto extends createDto(zTaskInput) {}
export class UpdateTaskDto extends createDto(zTaskInput.partial()) {}

export const zUpdateMilestone = z.object({ dueDate: zDateInput.nullable() });
export class UpdateMilestoneDto extends createDto(zUpdateMilestone) {}

export const DEFAULT_TASKS = [
  'Site Survey', 'Wiring Inspection', 'Product Delivery', 'Switch Installation', 'Curtain Installation',
  'Controller Installation', 'Programming', 'Testing', 'Client Training', 'Handover',
];
