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
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';

import {
  NovelService,
  CreateNovelDto,
  UpdateNovelDto,
  QueryNovelDto,
  CreateNovelChapterDto,
  UpdateNovelChapterDto,
} from './novel.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';
import { Access } from '../../common/authz/access.decorator';

@ApiTags('小说管理')
@Controller('novels')
export class NovelController {
  constructor(private readonly novelService: NovelService) {}

  @Post()
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建小说' })
  async create(@Body() dto: CreateNovelDto, @CurrentUser() user: AuthUser) {
    return this.novelService.create(dto, user.id);
  }

  @Get()
  @Access('optional')
  @ApiOperation({ summary: '获取小说列表' })
  async findAll(@Query() query: QueryNovelDto) {
    return this.novelService.findAll(query);
  }

  @Get('slug/:slug')
  @Access('public')
  @ApiOperation({ summary: '【公共】通过 slug 获取小说详情' })
  async findBySlug(@Param('slug') slug: string) {
    const novel = await this.novelService.findBySlug(slug);
    if (novel?.id) await this.novelService.incrementViewCount(novel.id);
    return novel;
  }

  @Get(':id')
  @Access('staff')
  @ApiOperation({ summary: '获取小说详情' })
  async findOne(@Param('id') id: string) {
    const novel = await this.novelService.findOne(id);
    await this.novelService.incrementViewCount(id);
    return novel;
  }

  @Patch(':id')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新小说' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateNovelDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.novelService.update(id, dto, user.id);
  }

  @Post(':id/publish')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '发布小说' })
  async publish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.novelService.publish(id, user.id);
  }

  @Post(':id/unpublish')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消发布小说' })
  async unpublish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.novelService.unpublish(id, user.id);
  }

  @Delete(':id')
  @Access('staff')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除小说（软删除）' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.novelService.remove(id, user.id);
  }

  // ============ Chapters ============

  @Get(':id/chapters')
  @Access('optional')
  @ApiOperation({ summary: '获取小说章节列表' })
  async listChapters(
    @Param('id') novelId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('published') published?: string,
  ) {
    return this.novelService.listChapters(novelId, {
      page,
      limit,
      published:
        published === undefined
          ? undefined
          : published === 'true' || published === '1',
    });
  }

  @Get('chapters/:chapterId')
  @Access('optional')
  @ApiOperation({ summary: '获取章节正文' })
  async getChapter(@Param('chapterId') chapterId: string) {
    const ch = await this.novelService.getChapter(chapterId);
    await this.novelService.incrementChapterViewCount(chapterId);
    return ch;
  }

  @Post(':id/chapters')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '为小说添加章节' })
  async addChapter(
    @Param('id') novelId: string,
    @Body() dto: CreateNovelChapterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.novelService.addChapter(novelId, dto, user.id);
  }

  @Patch('chapters/:chapterId')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新章节' })
  async updateChapter(
    @Param('chapterId') chapterId: string,
    @Body() dto: UpdateNovelChapterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.novelService.updateChapter(chapterId, dto, user.id);
  }

  @Delete('chapters/:chapterId')
  @Access('staff')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除章节' })
  async removeChapter(
    @Param('chapterId') chapterId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.novelService.removeChapter(chapterId, user.id);
  }
}
