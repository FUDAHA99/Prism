import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { CategoryService } from './category.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { Access } from '../../common/authz/access.decorator';
import { ParseLowercaseUuidPipe } from '../../common/pipes/parse-lowercase-uuid.pipe';

@ApiTags('分类管理')
@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Get()
  @Access('public')
  @ApiOperation({ summary: '获取所有分类' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll() {
    return this.categoryService.findAll();
  }

  @Get(':id')
  @Access('public')
  @ApiOperation({ summary: '获取分类详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '分类不存在' })
  async findOne(@Param('id', ParseLowercaseUuidPipe) id: string) {
    return this.categoryService.findOne(id);
  }

  @Post()
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建分类' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '参数不合法 / 父分类不存在' })
  @ApiResponse({ status: 409, description: 'slug 已存在' })
  async create(@Body() dto: CreateCategoryDto) {
    return this.categoryService.create(dto);
  }

  @Patch(':id')
  @Access('staff')
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新分类' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 400, description: '参数不合法 / 父分类不存在或会形成环' })
  @ApiResponse({ status: 404, description: '分类不存在' })
  @ApiResponse({ status: 409, description: 'slug 已存在' })
  async update(@Param('id', ParseLowercaseUuidPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoryService.update(id, dto);
  }

  @Delete(':id')
  @Access('staff')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除分类' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 409, description: '存在子分类，无法删除' })
  async remove(@Param('id', ParseLowercaseUuidPipe) id: string) {
    await this.categoryService.remove(id);
  }
}
