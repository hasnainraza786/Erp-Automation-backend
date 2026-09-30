import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ApiFile, ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { Idempotent } from '../../common/idempotency.interceptor';
import { PERMISSIONS as P } from '../../common/permissions';
import { OkDto } from '../../common/schemas';
import { QuotationPdfService } from './quotation-pdf.service';
import {
  ApproveQuotationDto,
  ApproveResultDto,
  CalculateQuotationDto,
  CalculationDto,
  ChangeQuotationStatusDto,
  CompareRevisionsDto,
  CreateQuotationDto,
  CreateTemplateDto,
  DuplicateQuotationDto,
  QuotationDetailDto,
  QuotationPageDto,
  QuotationQueryDto,
  ReviseQuotationDto,
  TemplateDto,
  TemplateFromQuotationDto,
  TemplateListDto,
  UpdateQuotationDto,
} from './quotations.schemas';
import { QuotationsService } from './quotations.service';

@ApiTags('quotations')
@Controller()
export class QuotationsController {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly pdf: QuotationPdfService,
  ) {}

  @Post('quotations/calculate')
  @HttpCode(200)
  @RequirePermission(P.QUOTATION_VIEW)
  @ApiOk(CalculationDto)
  calculateQuotation(@CurrentUser() user: AuthUser, @Body() body: CalculateQuotationDto) {
    return this.quotations.preview(user, body);
  }

  @Get('quotations')
  @RequirePermission(P.QUOTATION_VIEW)
  @ApiOk(QuotationPageDto)
  listQuotations(@Query() q: QuotationQueryDto) {
    return this.quotations.list(q);
  }

  @Get('quotations/:id')
  @RequirePermission(P.QUOTATION_VIEW)
  @ApiQuery({ name: 'revision', required: false, type: Number })
  @ApiOk(QuotationDetailDto)
  getQuotation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('revision') revision?: string) {
    return this.quotations.get(user, id, revision ? Number(revision) : undefined);
  }

  @Get('quotations/:id/compare/:from/:to')
  @RequirePermission(P.QUOTATION_VIEW)
  @ApiOk(CompareRevisionsDto)
  compareQuotationRevisions(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('from', ParseIntPipe) from: number,
    @Param('to', ParseIntPipe) to: number,
  ) {
    return this.quotations.compare(id, from, to);
  }

  @Get('quotations/:id/pdf')
  @RequirePermission(P.QUOTATION_VIEW)
  @ApiQuery({ name: 'revision', required: false, type: Number })
  @ApiFile('application/pdf')
  async downloadQuotationPdf(@Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply, @Query('revision') revision?: string) {
    const { buffer, fileName } = await this.pdf.render(id, revision ? Number(revision) : undefined);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${fileName}"`).send(buffer);
  }

  @Post('quotations')
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(QuotationDetailDto)
  createQuotation(@CurrentUser() user: AuthUser, @Body() body: CreateQuotationDto) {
    return this.quotations.create(user, body);
  }

  @Put('quotations/:id')
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(QuotationDetailDto)
  updateQuotation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateQuotationDto) {
    return this.quotations.update(user, id, body);
  }

  @Post('quotations/:id/send')
  @HttpCode(200)
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(QuotationDetailDto)
  sendQuotation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.send(user, id);
  }

  @Post('quotations/:id/status')
  @HttpCode(200)
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(QuotationDetailDto)
  changeQuotationStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: ChangeQuotationStatusDto) {
    return this.quotations.changeStatus(user, id, body);
  }

  @Post('quotations/:id/revise')
  @HttpCode(200)
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(QuotationDetailDto)
  reviseQuotation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviseQuotationDto) {
    return this.quotations.revise(user, id, body);
  }

  @Post('quotations/:id/approve')
  @HttpCode(200)
  @RequirePermission(P.QUOTATION_APPROVE)
  @Idempotent()
  @ApiOk(ApproveResultDto)
  approveQuotation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveQuotationDto) {
    return this.quotations.approve(user, id, body);
  }

  @Post('quotations/:id/duplicate')
  @HttpCode(200)
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(QuotationDetailDto)
  duplicateQuotation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: DuplicateQuotationDto) {
    return this.quotations.duplicate(user, id, body);
  }

  @Get('quotation-templates')
  @RequirePermission(P.QUOTATION_VIEW)
  @ApiOk(TemplateListDto)
  listQuotationTemplates() {
    return this.quotations.listTemplates();
  }

  @Post('quotation-templates')
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(TemplateDto)
  createQuotationTemplate(@CurrentUser() user: AuthUser, @Body() body: CreateTemplateDto) {
    return this.quotations.createTemplate(user, body);
  }

  @Post('quotations/:id/save-as-template')
  @HttpCode(200)
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(TemplateDto)
  saveQuotationAsTemplate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: TemplateFromQuotationDto) {
    return this.quotations.templateFromQuotation(user, id, body);
  }

  @Delete('quotation-templates/:id')
  @RequirePermission(P.QUOTATION_MANAGE)
  @ApiOk(OkDto)
  archiveQuotationTemplate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.archiveTemplate(user, id);
  }
}
