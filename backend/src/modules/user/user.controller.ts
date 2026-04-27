import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../role/guards/roles.guard';
import { Roles } from '../role/decorators/roles.decorator';

import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';

@ApiTags('用户管理')
@Controller('users')
@UseInterceptors(ClassSerializerInterceptor)
@UseGuards(AuthGuard('jwt'), RolesGuard)
@ApiBearerAuth()
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: '创建用户' })
  @ApiResponse({ status: 201, description: '用户创建成功' })
  @ApiResponse({ status: 409, description: '邮箱或用户名已存在' })
  @ApiResponse({ status: 403, description: '权限不足' })
  async create(
    @Body() createUserDto: CreateUserDto,
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.create(createUserDto);
  }

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: '获取用户列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(
    @Query() queryDto: QueryUserDto,
  ) {
    return this.userService.findAll(queryDto);
  }

  @Get(':id')
  @Roles('admin')
  @ApiOperation({ summary: '获取用户详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  async findOne(@Param('id') id: string) {
    return this.userService.findOne(id);
  }

  @Patch(':id')
  @Roles('admin')
  @ApiOperation({ summary: '更新用户信息' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  @ApiResponse({ status: 409, description: '邮箱或用户名冲突' })
  async update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.update(id, updateUserDto, currentUser.id);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除用户' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  @ApiResponse({ status: 400, description: '不能删除自己的账户' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthUser,
  ) {
    await this.userService.remove(id, currentUser.id);
  }

  @Patch(':id/status')
  @Roles('admin')
  @ApiOperation({ summary: '激活/禁用用户' })
  @ApiResponse({ status: 200, description: '操作成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  @ApiResponse({ status: 400, description: '不能禁用自己的账户' })
  async toggleStatus(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.toggleStatus(id, isActive, currentUser.id);
  }

  @Post(':id/assign-roles')
  @Roles('admin')
  @ApiOperation({ summary: '分配角色给用户' })
  @ApiResponse({ status: 200, description: '角色分配成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  async assignRoles(
    @Param('id') id: string,
    @Body('roleIds') roleIds: string[],
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.assignRoles(id, roleIds, currentUser.id);
  }

  @Post(':id/remove-roles')
  @Roles('admin')
  @ApiOperation({ summary: '移除用户的角色' })
  @ApiResponse({ status: 200, description: '角色移除成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  async removeRoles(
    @Param('id') id: string,
    @Body('roleIds') roleIds: string[],
    @CurrentUser() currentUser: AuthUser,
  ) {
    return this.userService.removeRoles(id, roleIds, currentUser.id);
  }
}
