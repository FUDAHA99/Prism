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
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';

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

@ApiTags('小说管理')
@Controller('novels')
export class NovelController {
  constructor(private readonly novelService: NovelService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建小说' })
  async create(@Body() dto: CreateNovelDto, @CurrentUser() user: AuthUser) {
    return this.novelService.create(dto, user.id);
  }

  @Get()
  @ApiOperation({ summary: '获取小说列表' })
  async findAll(@Query() query: QueryNovelDto) {
    return this.novelService.findAll(query);
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: '【公共】通过 slug 获取小说详情' })
  async findBySlug(@Param('slug') slug: string) {
    const novel = await this.novelService.findBySlug(slug);
    if (novel?.id) await this.novelService.incrementViewCount(novel.id);
    return novel;
  }

  @Get(':id')
  @ApiOperation({ summary: '获取小说详情' })
  async findOne(@Param('id') id: string) {
    const novel = await this.novelService.findOne(id);
    await this.novelService.incrementViewCount(id);
    return novel;
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '发布小说' })
  async publish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.novelService.publish(id, user.id);
  }

  @Post(':id/unpublish')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消发布小说' })
  async unpublish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.novelService.unpublish(id, user.id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除小说（软删除）' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.novelService.remove(id, user.id);
  }

  // ============ Chapters ============

  @Get(':id/chapters')
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
  @ApiOperation({ summary: '获取章节正文' })
  async getChapter(@Param('chapterId') chapterId: string) {
    const ch = await this.novelService.getChapter(chapterId);
    await this.novelService.incrementChapterViewCount(chapterId);
    return ch;
  }

  @Post(':id/chapters')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
