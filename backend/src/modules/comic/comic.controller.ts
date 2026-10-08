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
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';

import {
  ComicService,
  CreateComicDto,
  UpdateComicDto,
  CreateComicChapterDto,
  UpdateComicChapterDto,
} from './comic.service';
import { QueryComicChaptersDto, QueryComicDto } from './dto/query-comic.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';
import { Access } from '../../common/authz/access.decorator';
import { CurrentViewer, Viewer } from '../../common/authz/viewer';

@ApiTags('漫画管理')
@Controller('comics')
export class ComicController {
  constructor(private readonly comicService: ComicService) {}

  @Post()
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建漫画' })
  async create(@Body() dto: CreateComicDto, @CurrentUser() user: AuthUser) {
    return this.comicService.create(dto, user.id);
  }

  @Get()
  @Access('optional')
  @ApiOperation({
    summary: '获取漫画列表（后台角色看全量；游客只看已发布、公开字段，每页最多 50）',
  })
  async findAll(@Query() query: QueryComicDto, @CurrentViewer() viewer: Viewer) {
    return this.comicService.findAll(query, viewer);
  }

  /**
   * 门户漫画详情页与阅读页（portal 从不带 token，后台不调用这条），所以保持 public、不区分身份：
   * 只返回已发布漫画（公开字段），阅读数也只在这里累加。
   */
  @Get('slug/:slug')
  @Access('public')
  @ApiOperation({ summary: '【公共】通过 slug 获取已发布漫画（前台用）' })
  @ApiResponse({ status: 404, description: '漫画不存在或未发布' })
  async findBySlug(@Param('slug') slug: string) {
    const comic = await this.comicService.findPublishedBySlug(slug);
    await this.comicService.incrementViewCount(comic.id);
    return comic;
  }

  /** 后台编辑页与章节管理页加载用：任意状态、完整字段；不累加阅读数（此前管理员每打开一次编辑页就 +1） */
  @Get(':id')
  @Access('staff')
  @ApiOperation({ summary: '获取漫画详情' })
  async findOne(@Param('id') id: string) {
    return this.comicService.findOne(id);
  }

  @Patch(':id')
  @Access('staff')
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
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '发布漫画' })
  async publish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.comicService.publish(id, user.id);
  }

  @Post(':id/unpublish')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消发布漫画' })
  async unpublish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.comicService.unpublish(id, user.id);
  }

  @Delete(':id')
  @Access('staff')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除漫画（软删除）' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.comicService.remove(id, user.id);
  }

  // ============ Chapters ============

  @Get(':id/chapters')
  @Access('optional')
  @ApiOperation({
    summary: '获取漫画章节列表（后台角色看全部章节；游客只看已发布漫画的已发布章节）',
  })
  async listChapters(
    @Param('id') comicId: string,
    @Query() query: QueryComicChaptersDto,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.comicService.listChapters(comicId, query, viewer);
  }

  /**
   * 门户阅读页（portal 从不带 token；后台编辑弹窗用的是目录里的 pageUrls，不调用这条），所以保持 public、
   * 不区分身份：章节已发布且所属漫画已发布、未删除才返回（公开字段 + 页面图地址），否则 404；阅读数只在这里累加。
   */
  @Get('chapters/:chapterId')
  @Access('public')
  @ApiOperation({ summary: '【公共】获取已发布漫画章节内容（含页面URL，前台用）' })
  @ApiResponse({ status: 404, description: '章节不存在，或章节 / 漫画未发布' })
  async getChapter(@Param('chapterId') chapterId: string) {
    const ch = await this.comicService.findPublishedChapter(chapterId);
    await this.comicService.incrementChapterViewCount(chapterId);
    return ch;
  }

  @Post(':id/chapters')
  @Access('staff')
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
  @Access('staff')
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
  @Access('staff')
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
