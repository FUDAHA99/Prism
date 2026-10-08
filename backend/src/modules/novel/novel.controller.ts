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

import { NovelService } from './novel.service';
import { CreateNovelChapterDto, CreateNovelDto } from './dto/create-novel.dto';
import { UpdateNovelChapterDto, UpdateNovelDto } from './dto/update-novel.dto';
import { QueryNovelChaptersDto, QueryNovelDto } from './dto/query-novel.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';
import { Access } from '../../common/authz/access.decorator';
import { CurrentViewer, isStaff, Viewer } from '../../common/authz/viewer';

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
  @ApiOperation({
    summary: '获取小说列表（后台角色看全量；游客只看已发布、公开字段，每页最多 50）',
  })
  async findAll(@Query() query: QueryNovelDto, @CurrentViewer() viewer: Viewer) {
    return this.novelService.findAll(query, viewer);
  }

  /**
   * 门户小说详情页与阅读页（portal 从不带 token，后台不调用这条），所以保持 public、不区分身份：
   * 只返回已发布小说（公开字段），阅读数也只在这里累加。
   */
  @Get('slug/:slug')
  @Access('public')
  @ApiOperation({ summary: '【公共】通过 slug 获取已发布小说（前台用）' })
  @ApiResponse({ status: 404, description: '小说不存在或未发布' })
  async findBySlug(@Param('slug') slug: string) {
    const novel = await this.novelService.findPublishedBySlug(slug);
    await this.novelService.incrementViewCount(novel.id);
    return novel;
  }

  /** 后台编辑页与章节管理页加载用：任意状态、完整字段；不累加阅读数（此前管理员每打开一次编辑页就 +1） */
  @Get(':id')
  @Access('staff')
  @ApiOperation({ summary: '获取小说详情' })
  async findOne(@Param('id') id: string) {
    return this.novelService.findOne(id);
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
  @ApiOperation({
    summary: '获取小说章节列表（后台角色看全部章节；游客只看已发布小说的已发布章节）',
  })
  async listChapters(
    @Param('id') novelId: string,
    @Query() query: QueryNovelChaptersDto,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.novelService.listChapters(novelId, query, viewer);
  }

  /**
   * 后台章节编辑弹窗（带 token，要读未发布章节的全文）与门户阅读页（游客）共用：
   * - 后台角色：任意章节、完整字段，不累加阅读数（打开编辑弹窗不算阅读）；
   * - 其他人：章节已发布且所属小说已发布、未删除才返回（公开字段 + 正文），否则 404；阅读数 +1。
   */
  @Get('chapters/:chapterId')
  @Access('optional')
  @ApiOperation({ summary: '获取章节正文（后台角色可读未发布章节；游客只能读已发布小说的已发布章节）' })
  @ApiResponse({ status: 404, description: '章节不存在，或（游客）章节 / 小说未发布' })
  async getChapter(@Param('chapterId') chapterId: string, @CurrentViewer() viewer: Viewer) {
    if (isStaff(viewer)) return this.novelService.getChapter(chapterId);
    const ch = await this.novelService.findPublishedChapter(chapterId);
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
