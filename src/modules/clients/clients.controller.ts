import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { ClientDetailDto, ClientDto, ClientPageDto, ClientQueryDto, CreateClientDto, UpdateClientDto } from './clients.schemas';
import { ClientsService } from './clients.service';

@ApiTags('clients')
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @RequirePermission(P.CLIENT_VIEW)
  @ApiOk(ClientPageDto)
  listClients(@Query() q: ClientQueryDto) {
    return this.clients.list(q);
  }

  @Get(':id')
  @RequirePermission(P.CLIENT_VIEW)
  @ApiOk(ClientDetailDto)
  getClient(@Param('id', ParseUUIDPipe) id: string) {
    return this.clients.get(id);
  }

  @Post()
  @RequirePermission(P.CLIENT_MANAGE)
  @ApiOk(ClientDto)
  createClient(@CurrentUser() user: AuthUser, @Body() body: CreateClientDto) {
    return this.clients.create(user, body);
  }

  @Patch(':id')
  @RequirePermission(P.CLIENT_MANAGE)
  @ApiOk(ClientDto)
  updateClient(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateClientDto) {
    return this.clients.update(user, id, body);
  }
}
