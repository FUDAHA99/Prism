import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { RoleService } from './role.service';
import { AssignPermissionsDto, CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { Access } from '../../common/authz/access.decorator';

@ApiTags('角色管理')
@Access('admin')
@Controller('roles')
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
  @ApiResponse({ status: 400, description: '角色名不合规则 / 是保留名 / 带了 isSystem 等其他字段' })
  @ApiResponse({ status: 409, description: '角色名已存在' })
  async create(@Body() dto: CreateRoleDto) {
    return this.roleService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新角色（只接受 name / description；系统角色不能改名）' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 400, description: '系统角色不能改名 / 新名字不合规则或是保留名 / 带了其他字段' })
  @ApiResponse({ status: 404, description: '角色不存在' })
  @ApiResponse({ status: 409, description: '角色名已存在' })
  async update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roleService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除角色' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 400, description: '系统角色不能删除' })
  @ApiResponse({ status: 404, description: '角色不存在' })
  async remove(@Param('id') id: string) {
    await this.roleService.remove(id);
  }

  @Post(':id/permissions')
  @ApiOperation({ summary: '为角色分配权限' })
  @ApiResponse({ status: 200, description: '分配成功' })
  @ApiResponse({ status: 404, description: '角色或权限不存在' })
  async assignPermissions(@Param('id') id: string, @Body() dto: AssignPermissionsDto) {
    return this.roleService.assignPermissionsToRole(id, dto.permissionIds);
  }
}
