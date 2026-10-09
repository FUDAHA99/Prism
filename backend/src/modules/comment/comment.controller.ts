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
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CommentService } from './comment.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CommentBatchDto } from './dto/comment-batch.dto';
import { QueryCommentDto } from './dto/query-comment.dto';
import { QueryPublicCommentDto } from './dto/query-public-comment.dto';
import { Access } from '../../common/authz/access.decorator';
import { CurrentViewer, Viewer } from '../../common/authz/viewer';
import { clientIp } from '../../common/utils/client-ip';

/**
 * 评论管理端（读全字段含 guestEmail / 审核 / 删除）只对后台角色开放：Access('staff')。
 * 前台只用 GET /public（public）与 POST /（optional：严格可选登录，带了无效 token 得 401；
 * 门户发评论从不带 token）。发评论的身份（userId）、来源 IP 与审核状态由服务端填写，见 CommentService.create。
 */
@ApiTags('评论管理')
@Controller('comments')
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Get()
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取评论列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async findAll(@Query() query: QueryCommentDto) {
    return this.commentService.findAll(query);
  }

  @Get('public')
  @Access('public')
  @ApiOperation({ summary: '【公共】获取某文章已审核评论（前台用）' })
  @HttpCode(HttpStatus.OK)
  async findPublicByContent(@Query() query: QueryPublicCommentDto) {
    if (!query.contentId) return [];
    return this.commentService.findApprovedByContent(query.contentId);
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
  @ApiOperation({ summary: '发表评论（身份取登录态，IP 取请求来源，是否审核取站点配置）' })
  @ApiResponse({ status: 201, description: '创建成功，返回公开视图（status 为 pending 时须审核后公开）' })
  @ApiResponse({ status: 403, description: '评论功能已关闭' })
  @ApiResponse({ status: 404, description: '评论的内容不存在或未发布' })
  async create(@Body() dto: CreateCommentDto, @CurrentViewer() viewer: Viewer, @Req() req: Request) {
    const ip = clientIp(req);
    return this.commentService.create(dto, { viewer, ip: ip === 'unknown' ? null : ip });
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
  async batchApprove(@Body() dto: CommentBatchDto) {
    await this.commentService.batchApprove(dto.ids);
    return { affected: dto.ids.length };
  }

  @Post('batch/spam')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量标记 Spam' })
  async batchSpam(@Body() dto: CommentBatchDto) {
    await this.commentService.batchSpam(dto.ids);
    return { affected: dto.ids.length };
  }

  @Post('batch/delete')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量删除' })
  async batchDelete(@Body() dto: CommentBatchDto) {
    await this.commentService.batchDelete(dto.ids);
    return { affected: dto.ids.length };
  }
}
