import { createDto } from '../../common/dto';
import { z } from 'zod';

export const zLogin = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});
export class LoginDto extends createDto(zLogin) {}

export const zRefresh = z.object({ refreshToken: z.string().min(20) });
export class RefreshDto extends createDto(zRefresh) {}

export const zChangePassword = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});
export class ChangePasswordDto extends createDto(zChangePassword) {}

export const zMe = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  permissions: z.array(z.string()),
});
export class MeDto extends createDto(zMe) {}

export const zTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().describe('Access token lifetime in seconds'),
  user: zMe,
});
export class TokensDto extends createDto(zTokens) {}
