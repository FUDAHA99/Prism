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
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { NoticeService } from './notice.service';
import { CreateNoticeDto, QueryNoticeDto, UpdateNoticeDto } from './dto/notice.dto';
import { Access } from '../../common/authz/access.decorator';

@ApiTags('公告管理')
@ApiBearerAuth()
@Access('staff')
@Controller('notices')
export class NoticeController {
  constructor(private readonly noticeService: NoticeService) {}

  @Get()
  @ApiOperation({ summary: '获取公告列表' })
  async findAll(@Query() query: QueryNoticeDto) {
    return this.noticeService.findAll(query);
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
