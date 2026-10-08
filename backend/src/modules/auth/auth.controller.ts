import {
  Controller,
  Post,
  Body,
  Request,
  HttpCode,
  HttpStatus,
  Get,
  UseInterceptors,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { LogoutDto, RefreshTokenDto } from './dto/refresh-token.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginResponse, AuthUser } from './interfaces/auth.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Access } from '../../common/authz/access.decorator';
import { clientIp } from '../../common/utils/client-ip';

/**
 * 认证接口的限流额度，由 AppModule 的全局 ThrottlerBehindProxyGuard 执行（按 req.ip 计、每个接口各自一个桶）。
 * throttler v5 的 ttl 单位是毫秒：此前写的 60 / 300 是「秒」的写法，实际窗口只有 60ms / 300ms，
 * 反而把全局 100 次/分钟放宽了。
 */
export const AUTH_THROTTLE = {
  login: { limit: 5, ttl: 60_000 },
  register: { limit: 3, ttl: 300_000 },
  refresh: { limit: 10, ttl: 60_000 },
  changePassword: { limit: 5, ttl: 60_000 },
} as const;

@ApiTags('认证管理')
@Controller('auth')
@UseInterceptors(ClassSerializerInterceptor)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Access('public')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: AUTH_THROTTLE.login })
  @ApiOperation({ summary: '用户登录' })
  @ApiResponse({
    status: 200,
    description: '登录成功',
    schema: {
      example: {
        user: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          username: 'admin',
          email: 'admin@example.com',
          nickname: '管理员',
          avatarUrl: null,
          roles: ['admin'],
          isActive: true,
        },
        tokens: {
          accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          expiresIn: 7200,
          tokenType: 'Bearer',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: '邮箱或密码错误' })
  @ApiResponse({ status: 429, description: '登录尝试次数过多' })
  async login(
    @Body() loginDto: LoginDto,
    @Request() req: any,
  ): Promise<LoginResponse> {
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'];
    
    return this.authService.login(loginDto, {
      ip,
      userAgent,
    });
  }

  @Post('register')
  @Access('public')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: AUTH_THROTTLE.register })
  @ApiOperation({ summary: '用户注册' })
  @ApiResponse({
    status: 201,
    description: '注册成功',
    schema: {
      example: {
        user: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          username: 'newuser',
          email: 'newuser@example.com',
          nickname: '新用户',
          avatarUrl: null,
          roles: ['user'],
          isActive: true,
        },
        tokens: {
          accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          expiresIn: 7200,
          tokenType: 'Bearer',
        },
      },
    },
  })
  @ApiResponse({ status: 409, description: '邮箱或用户名已存在' })
  @ApiResponse({ status: 429, description: '注册尝试次数过多' })
  async register(
    @Body() registerDto: RegisterDto,
    @Request() req: any,
  ): Promise<LoginResponse> {
    // 注册开关（enable_register）由 1-F-3 收口；这里只把真实 IP / UA 记进审计（此前写死 'unknown'）
    return this.authService.register(registerDto, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('refresh')
  @Access('public')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: AUTH_THROTTLE.refresh })
  @ApiOperation({ summary: '刷新Token' })
  @ApiResponse({
    status: 200,
    description: '刷新成功',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        expiresIn: 7200,
        tokenType: 'Bearer',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'refresh token无效、已过期或已用过' })
  async refreshToken(
    @Body() dto: RefreshTokenDto,
    @Request() req: any,
  ) {
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'];

    return this.authService.refreshToken(dto.refreshToken, ip, userAgent);
  }

  @Post('logout')
  @Access('authenticated')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '用户登出（请求体可带 refreshToken 一并吊销）' })
  @ApiResponse({ status: 200, description: '登出成功' })
  @ApiResponse({ status: 401, description: '未授权' })
  async logout(
    @CurrentUser() user: AuthUser,
    @Body() dto: LogoutDto,
    @Request() req: any,
  ): Promise<{ message: string }> {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'];

    await this.authService.logout(
      user.id,
      accessToken,
      dto?.refreshToken,
      ip,
      userAgent,
    );
    
    return { message: '登出成功' };
  }

  @Get('me')
  @Access('authenticated')
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前用户信息' })
  @ApiResponse({
    status: 200,
    description: '获取成功',
    schema: {
      example: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        username: 'admin',
        email: 'admin@example.com',
        nickname: '管理员',
        avatarUrl: null,
        roles: ['admin'],
        permissions: ['user:read', 'user:create', 'content:read', 'content:create'],
        isActive: true,
      },
    },
  })
  @ApiResponse({ status: 401, description: '未授权' })
  async getProfile(
    @CurrentUser() user: AuthUser,
  ): Promise<AuthUser> {
    return user;
  }

  @Post('change-password')
  @Access('authenticated')
  @Throttle({ default: AUTH_THROTTLE.changePassword })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '修改密码（成功后本人已签发的全部 token 作废，需重新登录）' })
  @ApiResponse({ status: 200, description: '密码修改成功' })
  @ApiResponse({ status: 400, description: '当前密码错误，或新密码不符合要求' })
  @ApiResponse({ status: 401, description: '未授权' })
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() changePasswordDto: ChangePasswordDto,
    @Request() req: any,
  ): Promise<{ message: string }> {
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'];

    await this.authService.changePassword(
      user.id,
      changePasswordDto.currentPassword,
      changePasswordDto.newPassword,
      ip,
      userAgent,
    );

    return { message: '密码修改成功' };
  }
}
