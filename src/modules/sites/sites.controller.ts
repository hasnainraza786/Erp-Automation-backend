import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { CreateSiteDto, SiteDto, SitePageDto, SiteQueryDto, UpdateSiteDto } from './sites.schemas';
import { SitesService } from './sites.service';

@ApiTags('sites')
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  @RequirePermission(P.SITE_VIEW)
  @ApiOk(SitePageDto)
  listSites(@Query() q: SiteQueryDto) {
    return this.sites.list(q);
  }

  @Get(':id')
  @RequirePermission(P.SITE_VIEW)
  @ApiOk(SiteDto)
  getSite(@Param('id', ParseUUIDPipe) id: string) {
    return this.sites.get(id);
  }

  @Post()
  @RequirePermission(P.SITE_MANAGE)
  @ApiOk(SiteDto)
  createSite(@CurrentUser() user: AuthUser, @Body() body: CreateSiteDto) {
    return this.sites.create(user, body);
  }

  @Patch(':id')
  @RequirePermission(P.SITE_MANAGE)
  @ApiOk(SiteDto)
  updateSite(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSiteDto) {
    return this.sites.update(user, id, body);
  }
}
