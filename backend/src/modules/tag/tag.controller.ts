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
import { TagService } from './tag.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@ApiTags('标签管理')
@Controller('tags')
export class TagController {
  constructor(private readonly tagService: TagService) {}

  @Get()
  @ApiOperation({ summary: '获取标签列表' })
  @ApiQuery({ name: 'search', required: false, description: '搜索关键词' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async findAll(@Query('search') search?: string) {
    const tags = await this.tagService.findAll(search);
    return tags;
  }

  @Get(':id')
  @ApiOperation({ summary: '获取标签详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '标签不存在' })
  @HttpCode(HttpStatus.OK)
  async findOne(@Param('id') id: string) {
    const tag = await this.tagService.findOne(id);
    return tag;
  }

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建标签' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 409, description: '标签已存在' })
  async create(@Body() dto: CreateTagDto) {
    const tag = await this.tagService.create(dto);
    return tag;
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新标签' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '标签不存在' })
  @HttpCode(HttpStatus.OK)
  async update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    const tag = await this.tagService.update(id, dto);
    return tag;
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除标签' })
  @ApiResponse({ status: 200, description: '删除成功' })
  @ApiResponse({ status: 404, description: '标签不存在' })
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string) {
    await this.tagService.remove(id);
    return { message: '标签删除成功' };
  }
}
