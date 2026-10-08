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
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { CommentService, COMMENT_PAGE_SIZE_DEFAULT, COMMENT_PAGE_SIZE_MAX } from './comment.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { Access } from '../../common/authz/access.decorator';

/**
 * 评论管理端（读全字段含 guestEmail / 审核 / 删除）只对后台角色开放：Access('staff')。
 * 前台只用 GET /public（public）与 POST /（optional：严格可选登录，带了无效 token 得 401；
 * 门户发评论从不带 token。评论身份改由服务端按 req.user 填写在 1-F-2 的后续提交）。
 */
@ApiTags('评论管理')
@Controller('comments')
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Get()
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取评论列表' })
  @ApiQuery({ name: 'contentId', required: false, description: '内容ID' })
  @ApiQuery({ name: 'status', required: false, description: '状态: pending/approved/spam' })
  @ApiQuery({ name: 'page', required: false, description: '页码（默认 1）' })
  @ApiQuery({ name: 'limit', required: false, description: `每页数量（默认 ${COMMENT_PAGE_SIZE_DEFAULT}，最大 ${COMMENT_PAGE_SIZE_MAX}）` })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async findAll(
    @Query('contentId') contentId: string | undefined,
    @Query('status') status: string | undefined,
    // 缺省时全局 ValidationPipe 会把 undefined 转成 NaN（+undefined），DefaultValuePipe 把 NaN 也当缺省；
    // 越界值（0、负数、超大 limit）由 CommentService.findAll 夹紧
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(COMMENT_PAGE_SIZE_DEFAULT), ParseIntPipe) limit: number,
  ) {
    const result = await this.commentService.findAll({ contentId, status, page, limit });
    return result;
  }

  @Get('public')
  @Access('public')
  @ApiOperation({ summary: '【公共】获取某文章已审核评论（前台用）' })
  @ApiQuery({ name: 'contentId', required: true })
  @HttpCode(HttpStatus.OK)
  async findPublicByContent(@Query('contentId') contentId: string) {
    if (!contentId) return [];
    return this.commentService.findApprovedByContent(contentId);
  }

  @Get(':id')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取评论详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '评论不存在' })
  @HttpCode(HttpStatus.OK)
  async findOne(@Param('id') id: string) {
    const comment = await this.commentService.findOne(id);
    return comment;
  }

  @Post()
  @Access('optional')
  @ApiOperation({ summary: '创建评论' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@Body() dto: CreateCommentDto) {
    const comment = await this.commentService.create(dto);
    return comment;
  }

  @Patch(':id/approve')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '审核通过评论' })
  @ApiResponse({ status: 200, description: '操作成功' })
  @ApiResponse({ status: 404, description: '评论不存在' })
  @HttpCode(HttpStatus.OK)
  async approve(@Param('id') id: string) {
    const comment = await this.commentService.approve(id);
    return comment;
  }

  @Patch(':id/spam')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '标记为垃圾评论' })
  @ApiResponse({ status: 200, description: '操作成功' })
  @ApiResponse({ status: 404, description: '评论不存在' })
  @HttpCode(HttpStatus.OK)
  async spam(@Param('id') id: string) {
    const comment = await this.commentService.spam(id);
    return comment;
  }

  @Delete(':id')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除评论' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    await this.commentService.remove(id);
  }

  @Post('batch/approve')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量审核通过' })
  async batchApprove(@Body('ids') ids: string[]) {
    await this.commentService.batchApprove(ids);
    return { affected: ids.length };
  }

  @Post('batch/spam')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量标记 Spam' })
  async batchSpam(@Body('ids') ids: string[]) {
    await this.commentService.batchSpam(ids);
    return { affected: ids.length };
  }

  @Post('batch/delete')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量删除' })
  async batchDelete(@Body('ids') ids: string[]) {
    await this.commentService.batchDelete(ids);
    return { affected: ids.length };
  }
}
