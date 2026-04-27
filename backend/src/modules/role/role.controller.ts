import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';

import { RoleService } from './role.service';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';

@ApiTags('角色管理')
@Controller('roles')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@ApiBearerAuth()
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @ApiOperation({ summary: '获取所有角色' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll() {
    return this.roleService.findAll();
  }

  @Get('permissions')
  @ApiOperation({ summary: '获取所有权限' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAllPermissions() {
    return this.roleService.findAllPermissions();
  }

  @Get(':id')
  @ApiOperation({ summary: '获取角色详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '角色不存在' })
  async findOne(@Param('id') id: string) {
    return this.roleService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: '创建角色' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 409, description: '角色名已存在' })
  async create(@Body() body: { name: string; description?: string }) {
    return this.roleService.create(body.name, body.description);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新角色' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '角色不存在' })
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string },
  ) {
    return this.roleService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除角色' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: '角色不存在' })
  @ApiResponse({ status: 409, description: '不能删除系统角色' })
  async remove(@Param('id') id: string) {
    await this.roleService.remove(id);
  }

  @Post(':id/permissions')
  @ApiOperation({ summary: '为角色分配权限' })
  @ApiResponse({ status: 200, description: '分配成功' })
  @ApiResponse({ status: 404, description: '角色或权限不存在' })
  async assignPermissions(
    @Param('id') id: string,
    @Body('permissionIds') permissionIds: string[],
  ) {
    return this.roleService.assignPermissionsToRole(id, permissionIds);
  }
}
