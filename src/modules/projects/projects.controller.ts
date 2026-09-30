import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import {
  CreateTaskDto,
  DeliverItemDto,
  InstallItemDto,
  ProcurementListDto,
  ProjectDetailDto,
  ProjectPageDto,
  ProjectQueryDto,
  TaskDto,
  UpdateMilestoneDto,
  UpdateProjectDto,
  UpdateProjectProgressDto,
  UpdateProjectStatusDto,
  UpdateTaskDto,
} from './projects.schemas';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission(P.PROJECT_VIEW)
  @ApiOk(ProjectPageDto)
  listProjects(@Query() q: ProjectQueryDto) {
    return this.projects.list(q);
  }

  @Get(':id')
  @RequirePermission(P.PROJECT_VIEW)
  @ApiOk(ProjectDetailDto)
  getProject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.get(user, id);
  }

  @Patch(':id')
  @RequirePermission(P.PROJECT_MANAGE)
  @ApiOk(ProjectDetailDto)
  updateProject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProjectDto) {
    return this.projects.update(user, id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission(P.PROJECT_MANAGE)
  @ApiOk(ProjectDetailDto)
  updateProjectStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProjectStatusDto) {
    return this.projects.updateStatus(user, id, body);
  }

  @Post(':id/progress')
  @HttpCode(200)
  @RequirePermission(P.PROJECT_PROGRESS)
  @ApiOk(ProjectDetailDto)
  updateProjectProgress(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProjectProgressDto) {
    return this.projects.updateProgress(user, id, body);
  }

  @Get(':id/procurement')
  @RequirePermission(P.PROJECT_VIEW)
  @ApiOk(ProcurementListDto)
  getProjectProcurement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.procurement(user, id);
  }

  @Post(':id/reserve-stock')
  @HttpCode(200)
  @RequirePermission(P.INVENTORY_MANAGE)
  @ApiOk(ProcurementListDto)
  reserveProjectStock(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.reserveStock(user, id);
  }

  @Post(':id/items/:itemId/deliver')
  @HttpCode(200)
  @RequirePermission(P.PROJECT_PROGRESS)
  @ApiOk(ProjectDetailDto)
  deliverProjectItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: DeliverItemDto,
  ) {
    return this.projects.deliverItem(user, id, itemId, body);
  }

  @Post(':id/items/:itemId/install')
  @HttpCode(200)
  @RequirePermission(P.PROJECT_PROGRESS)
  @ApiOk(ProjectDetailDto)
  installProjectItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: InstallItemDto,
  ) {
    return this.projects.installItem(user, id, itemId, body);
  }

  @Post(':id/tasks')
  @RequirePermission(P.PROJECT_PROGRESS)
  @ApiOk(TaskDto)
  createProjectTask(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateTaskDto) {
    return this.projects.createTask(user, id, body);
  }

  @Post(':id/tasks/defaults')
  @HttpCode(200)
  @RequirePermission(P.PROJECT_PROGRESS)
  @ApiOk(ProjectDetailDto)
  addDefaultProjectTasks(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.addDefaultTasks(user, id);
  }

  @Patch('tasks/:taskId')
  @RequirePermission(P.PROJECT_PROGRESS)
  @ApiOk(TaskDto)
  updateProjectTask(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() body: UpdateTaskDto) {
    return this.projects.updateTask(user, taskId, body);
  }

  @Patch('milestones/:milestoneId')
  @RequirePermission(P.INVOICE_MANAGE)
  @ApiOk(ProjectDetailDto)
  updatePaymentMilestone(@CurrentUser() user: AuthUser, @Param('milestoneId', ParseUUIDPipe) milestoneId: string, @Body() body: UpdateMilestoneDto) {
    return this.projects.updateMilestone(user, milestoneId, body);
  }
}
