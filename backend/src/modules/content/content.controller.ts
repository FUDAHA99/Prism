import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';

import {
  ContentService,
  CreateContentDto,
  UpdateContentDto,
  QueryContentDto,
} from './content.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';
import { ContentStatus, ContentType } from './entities/content.entity';

@ApiTags('内容管理')
@Controller('contents')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
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
  @ApiOperation({ summary: '获取内容列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@Query() query: QueryContentDto) {
    return this.contentService.findAll(query);
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: '【公共】通过 slug 获取已发布内容（前台用）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '内容不存在' })
  async findBySlug(@Param('slug') slug: string) {
    const content = await this.contentService.findBySlug(slug);
    if (content?.id) {
      await this.contentService.incrementViewCount(content.id);
    }
    return content;
  }

  @Get(':id')
  @ApiOperation({ summary: '获取内容详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '内容不存在' })
  async findOne(@Param('id') id: string) {
    const content = await this.contentService.findOne(id);
    await this.contentService.incrementViewCount(id);
    return content;
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
