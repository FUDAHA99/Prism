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
import { ApiOperation, ApiQuery, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { NoticeService, CreateNoticeDto, UpdateNoticeDto } from './notice.service';

@ApiTags('公告管理')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
@Controller('notices')
export class NoticeController {
  constructor(private readonly noticeService: NoticeService) {}

  @Get()
  @ApiOperation({ summary: '获取公告列表' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'level', required: false })
  @ApiQuery({ name: 'isPublished', required: false })
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('level') level?: string,
    @Query('isPublished') isPublished?: string,
  ) {
    return this.noticeService.findAll({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      level: level as any,
      isPublished: isPublished !== undefined ? isPublished === 'true' : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '获取公告详情' })
  async findOne(@Param('id') id: string) {
    return this.noticeService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: '创建公告' })
  async create(@Body() dto: CreateNoticeDto) {
    return this.noticeService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新公告' })
  async update(@Param('id') id: string, @Body() dto: UpdateNoticeDto) {
    return this.noticeService.update(id, dto);
  }

  @Post(':id/toggle-publish')
  @ApiOperation({ summary: '切换发布状态' })
  async togglePublish(@Param('id') id: string) {
    return this.noticeService.togglePublish(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除公告' })
  async remove(@Param('id') id: string) {
    await this.noticeService.remove(id);
  }
}
