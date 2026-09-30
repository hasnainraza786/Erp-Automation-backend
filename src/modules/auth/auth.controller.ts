import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiOk } from '../../common/api-ok';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser, Public } from '../../common/auth.decorators';
import { OkDto } from '../../common/schemas';
import { ChangePasswordDto, LoginDto, MeDto, RefreshDto, TokensDto } from './auth.schemas';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOk(TokensDto)
  login(@Body() body: LoginDto, @Headers('user-agent') ua?: string) {
    return this.auth.login(body.email, body.password, ua);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOk(TokensDto)
  refreshToken(@Body() body: RefreshDto, @Headers('user-agent') ua?: string) {
    return this.auth.refresh(body.refreshToken, ua);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOk(OkDto)
  async logout(@Body() body: RefreshDto) {
    await this.auth.logout(body.refreshToken);
    return { ok: true };
  }

  @Get('me')
  @ApiOk(MeDto)
  getMe(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiOk(OkDto)
  async changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto) {
    await this.auth.changePassword(user, body.currentPassword, body.newPassword);
    return { ok: true };
  }
}
