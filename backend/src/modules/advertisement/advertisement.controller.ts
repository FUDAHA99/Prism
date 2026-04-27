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
import { AdvertisementService, CreateAdDto, UpdateAdDto } from './advertisement.service';

@ApiTags('广告管理')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
@Controller('advertisements')
export class AdvertisementController {
  constructor(private readonly adService: AdvertisementService) {}

  @Get()
  @ApiOperation({ summary: '获取广告列表' })
  @ApiQuery({ name: 'search', required: false })
  async findAll(@Query('search') search?: string) {
    return this.adService.findAll(search);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取广告详情' })
  async findOne(@Param('id') id: string) {
    return this.adService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: '创建广告' })
  async create(@Body() dto: CreateAdDto) {
    return this.adService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新广告' })
  async update(@Param('id') id: string, @Body() dto: UpdateAdDto) {
    return this.adService.update(id, dto);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: '切换广告启用状态' })
  async toggle(@Param('id') id: string) {
    return this.adService.toggleActive(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除广告' })
  async remove(@Param('id') id: string) {
    await this.adService.remove(id);
  }
}
