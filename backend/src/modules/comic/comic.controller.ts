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
  ComicService,
  CreateComicDto,
  UpdateComicDto,
  QueryComicDto,
  CreateComicChapterDto,
  UpdateComicChapterDto,
} from './comic.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';

@ApiTags('漫画管理')
@Controller('comics')
export class ComicController {
  constructor(private readonly comicService: ComicService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建漫画' })
  async create(@Body() dto: CreateComicDto, @CurrentUser() user: AuthUser) {
    return this.comicService.create(dto, user.id);
  }

  @Get()
  @ApiOperation({ summary: '获取漫画列表' })
  async findAll(@Query() query: QueryComicDto) {
    return this.comicService.findAll(query);
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: '【公共】通过 slug 获取漫画详情' })
  async findBySlug(@Param('slug') slug: string) {
    const comic = await this.comicService.findBySlug(slug);
    if (comic?.id) await this.comicService.incrementViewCount(comic.id);
    return comic;
  }

  @Get(':id')
  @ApiOperation({ summary: '获取漫画详情' })
  async findOne(@Param('id') id: string) {
    const comic = await this.comicService.findOne(id);
    await this.comicService.incrementViewCount(id);
    return comic;
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新漫画' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateComicDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.comicService.update(id, dto, user.id);
  }

  @Post(':id/publish')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '发布漫画' })
  async publish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.comicService.publish(id, user.id);
  }

  @Post(':id/unpublish')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消发布漫画' })
  async unpublish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.comicService.unpublish(id, user.id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除漫画（软删除）' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.comicService.remove(id, user.id);
  }

  // ============ Chapters ============

  @Get(':id/chapters')
  @ApiOperation({ summary: '获取漫画章节列表' })
  async listChapters(
    @Param('id') comicId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('published') published?: string,
  ) {
    return this.comicService.listChapters(comicId, {
      page,
      limit,
      published:
        published === undefined
          ? undefined
          : published === 'true' || published === '1',
    });
  }

  @Get('chapters/:chapterId')
  @ApiOperation({ summary: '获取漫画章节内容（含页面URL）' })
  async getChapter(@Param('chapterId') chapterId: string) {
    const ch = await this.comicService.getChapter(chapterId);
    await this.comicService.incrementChapterViewCount(chapterId);
    return ch;
  }

  @Post(':id/chapters')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '为漫画添加章节' })
  async addChapter(
    @Param('id') comicId: string,
    @Body() dto: CreateComicChapterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.comicService.addChapter(comicId, dto, user.id);
  }

  @Patch('chapters/:chapterId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新章节' })
  async updateChapter(
    @Param('chapterId') chapterId: string,
    @Body() dto: UpdateComicChapterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.comicService.updateChapter(chapterId, dto, user.id);
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
    await this.comicService.removeChapter(chapterId, user.id);
  }
}
