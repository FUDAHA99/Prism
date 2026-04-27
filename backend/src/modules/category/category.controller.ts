import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';

import { CategoryService, CreateCategoryDto, UpdateCategoryDto } from './category.service';

@ApiTags('分类管理')
@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Get()
  @ApiOperation({ summary: '获取所有分类' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll() {
    return this.categoryService.findAll();
  }

  @Get('tree')
  @ApiOperation({ summary: '获取分类树形结构' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findTree() {
    return this.categoryService.findTree();
  }

  @Get(':id')
  @ApiOperation({ summary: '获取分类详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '分类不存在' })
  async findOne(@Param('id') id: string) {
    return this.categoryService.findOne(id);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建分类' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@Body() dto: CreateCategoryDto) {
    return this.categoryService.create(dto);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新分类' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '分类不存在' })
  async update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoryService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除分类' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 409, description: '存在子分类，无法删除' })
  async remove(@Param('id') id: string) {
    await this.categoryService.remove(id);
  }
}
