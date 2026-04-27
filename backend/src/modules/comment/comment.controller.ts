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
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CommentService } from './comment.service';
import { CreateCommentDto } from './dto/create-comment.dto';

@ApiTags('评论管理')
@Controller('comments')
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Get()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取评论列表' })
  @ApiQuery({ name: 'contentId', required: false, description: '内容ID' })
  @ApiQuery({ name: 'status', required: false, description: '状态: pending/approved/spam' })
  @ApiQuery({ name: 'page', required: false, description: '页码' })
  @ApiQuery({ name: 'limit', required: false, description: '每页数量' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async findAll(
    @Query('contentId') contentId?: string,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result = await this.commentService.findAll({ contentId, status, page, limit });
    return result;
  }

  @Get('public')
  @ApiOperation({ summary: '【公共】获取某文章已审核评论（前台用）' })
  @ApiQuery({ name: 'contentId', required: true })
  @HttpCode(HttpStatus.OK)
  async findPublicByContent(@Query('contentId') contentId: string) {
    if (!contentId) return [];
    return this.commentService.findApprovedByContent(contentId);
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
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
  @ApiOperation({ summary: '创建评论' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@Body() dto: CreateCommentDto) {
    const comment = await this.commentService.create(dto);
    return comment;
  }

  @Patch(':id/approve')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除评论' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    await this.commentService.remove(id);
  }

  @Post('batch/approve')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量审核通过' })
  async batchApprove(@Body('ids') ids: string[]) {
    await this.commentService.batchApprove(ids);
    return { affected: ids.length };
  }

  @Post('batch/spam')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量标记 Spam' })
  async batchSpam(@Body('ids') ids: string[]) {
    await this.commentService.batchSpam(ids);
    return { affected: ids.length };
  }

  @Post('batch/delete')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量删除' })
  async batchDelete(@Body('ids') ids: string[]) {
    await this.commentService.batchDelete(ids);
    return { affected: ids.length };
  }
}
