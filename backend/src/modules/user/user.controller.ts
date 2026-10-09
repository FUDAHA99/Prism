import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  Req,
  UseInterceptors,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UserRoleIdsDto } from './dto/user-role-ids.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';
import { Access } from '../../common/authz/access.decorator';
import { clientIp } from '../../common/utils/client-ip';
// :id 统一校验并转小写：库是 utf8mb4_unicode_ci，大写 id 能查到同一个用户，
// 而「不能移除自己的管理员角色」等自我保护按字符串比较 currentUser.id，大写即可绕过
import { ParseLowercaseUuidPipe } from '../../common/pipes/parse-lowercase-uuid.pipe';

@ApiTags('用户管理')
@Access('admin')
@Controller('users')
@UseInterceptors(ClassSerializerInterceptor)
@ApiBearerAuth()
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @ApiOperation({ summary: '创建用户' })
  @ApiResponse({ status: 201, description: '用户创建成功' })
  @ApiResponse({ status: 409, description: '邮箱或用户名已存在' })
  @ApiResponse({ status: 403, description: '权限不足' })
  async create(
    @Body() createUserDto: CreateUserDto,
    @CurrentUser() currentUser: AuthUser,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
  ) {
    // 审计记操作的管理员与真实来源（IP 取 nginx 追加的那一跳，见 clientIp）
    const userAgent = req.headers['user-agent'];
    return this.userService.create(createUserDto, {
      actorId: currentUser.id,
      ip: clientIp(req),
      // 没带 UA 的真实请求记 'unknown'（与 PATCH /auth/me 一致），'system' 只留给没有请求上下文的内部调用
      userAgent: typeof userAgent === 'string' ? userAgent : 'unknown',
    });
  }

  @Get()
  @ApiOperation({ summary: '获取用户列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(
    @Query() queryDto: QueryUserDto,
  ) {
    return this.userService.findAll(queryDto);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取用户详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  async findOne(@Param('id', ParseLowercaseUuidPipe) id: string) {
    return this.userService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新用户信息' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  @ApiResponse({ status: 409, description: '邮箱或用户名冲突' })
  async update(
    @Param('id', ParseLowercaseUuidPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.update(id, updateUserDto, currentUser.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除用户' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  @ApiResponse({ status: 400, description: '不能删除自己的账户' })
  async remove(
    @Param('id', ParseLowercaseUuidPipe) id: string,
    @CurrentUser() currentUser: AuthUser,
  ) {
    await this.userService.remove(id, currentUser.id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '激活/禁用用户' })
  @ApiResponse({ status: 200, description: '操作成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  @ApiResponse({ status: 400, description: '不能禁用自己的账户 / isActive 不是布尔' })
  async toggleStatus(
    @Param('id', ParseLowercaseUuidPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.toggleStatus(id, dto.isActive, currentUser.id);
  }

  @Post(':id/assign-roles')
  @ApiOperation({ summary: '分配角色给用户（已有的跳过，立即生效）' })
  @ApiResponse({ status: 201, description: '角色分配成功，返回用户（含最新 roles）' })
  @ApiResponse({ status: 400, description: 'roleIds 校验失败' })
  @ApiResponse({ status: 404, description: '用户或部分角色不存在' })
  async assignRoles(
    @Param('id', ParseLowercaseUuidPipe) id: string,
    @Body() dto: UserRoleIdsDto,
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.assignRoles(id, dto.roleIds, currentUser.id);
  }

  @Post(':id/remove-roles')
  @ApiOperation({ summary: '移除用户的角色（立即生效）' })
  @ApiResponse({ status: 201, description: '角色移除成功，返回用户（含最新 roles）' })
  @ApiResponse({ status: 400, description: 'roleIds 校验失败，或移除自己的管理员角色' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  async removeRoles(
    @Param('id', ParseLowercaseUuidPipe) id: string,
    @Body() dto: UserRoleIdsDto,
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.removeRoles(id, dto.roleIds, currentUser.id);
  }
}
