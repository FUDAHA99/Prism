import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import {
  ContentService,
  CreateContentDto,
  UpdateContentDto,
} from './content.service';
import { QueryContentDto } from './dto/query-content.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';
import { Access } from '../../common/authz/access.decorator';
import { CurrentViewer, Viewer } from '../../common/authz/viewer';

@ApiTags('内容管理')
@Controller('contents')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Post()
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建内容' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(
    @Body() dto: CreateContentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.contentService.create(dto, user.id);
  }

  @Get()
  @Access('optional')
  @ApiOperation({
    summary: '获取内容列表（后台角色看全量；游客只看已发布、公开字段，每页最多 50）',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@Query() query: QueryContentDto, @CurrentViewer() viewer: Viewer) {
    return this.contentService.findAll(query, viewer);
  }

  /**
   * 门户文章详情页（portal 从不带 token，后台不调用这条），所以保持 public、不区分身份：
   * 只返回已发布内容，阅读数也只在这里累加。
   */
  @Get('slug/:slug')
  @Access('public')
  @ApiOperation({ summary: '【公共】通过 slug 获取已发布内容（前台用）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '内容不存在或未发布' })
  async findBySlug(@Param('slug') slug: string) {
    const content = await this.contentService.findPublishedBySlug(slug);
    await this.contentService.incrementViewCount(content.id);
    return content;
  }

  /** 后台编辑页加载用：任意状态、完整字段；不累加阅读数（此前管理员每打开一次编辑页就 +1） */
  @Get(':id')
  @Access('staff')
  @ApiOperation({ summary: '获取内容详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '内容不存在' })
  async findOne(@Param('id') id: string) {
    return this.contentService.findOne(id);
  }

  @Patch(':id')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新内容' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 403, description: '权限不足' })
  @ApiResponse({ status: 404, description: '内容不存在' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateContentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.contentService.update(id, dto, user.id, user.roles);
  }

  @Post(':id/publish')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '发布内容' })
  @ApiResponse({ status: 200, description: '发布成功' })
  @ApiResponse({ status: 403, description: '权限不足' })
  async publish(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.contentService.publish(id, user.id, user.roles);
  }

  @Post(':id/unpublish')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消发布内容' })
  @ApiResponse({ status: 200, description: '操作成功' })
  @ApiResponse({ status: 403, description: '权限不足' })
  async unpublish(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.contentService.unpublish(id, user.id, user.roles);
  }

  @Delete(':id')
  @Access('staff')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除内容' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 403, description: '权限不足' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.contentService.remove(id, user.id, user.roles);
  }
}
