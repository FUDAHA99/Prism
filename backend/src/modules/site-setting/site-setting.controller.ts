import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { SiteSettingService } from './site-setting.service';
import {
  BatchUpsertSettingDto,
  UpdateSettingValueDto,
} from './dto/upsert-setting.dto';

@ApiTags('系统配置')
@Controller('site-settings')
export class SiteSettingController {
  constructor(private readonly siteSettingService: SiteSettingService) {}

  @Get('public')
  @ApiOperation({ summary: '【公共】获取前台可见的站点配置' })
  @HttpCode(HttpStatus.OK)
  async findPublic() {
    return this.siteSettingService.findPublic();
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取所有配置（按分组）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async findAll() {
    const settings = await this.siteSettingService.findAll();
    return settings;
  }

  @Post('batch')
  @ApiOperation({ summary: '批量保存配置' })
  @ApiResponse({ status: 200, description: '保存成功' })
  @HttpCode(HttpStatus.OK)
  async batchUpsert(@Body() dto: BatchUpsertSettingDto) {
    await this.siteSettingService.batchUpsert(dto.settings);
    return { message: '批量保存配置成功' };
  }

  @Get(':key')
  @ApiOperation({ summary: '获取单个配置' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '配置不存在' })
  @HttpCode(HttpStatus.OK)
  async findOne(@Param('key') key: string) {
    const setting = await this.siteSettingService.findByKey(key);
    return setting;
  }

  @Put(':key')
  @ApiOperation({ summary: '更新单个配置' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @HttpCode(HttpStatus.OK)
  async update(@Param('key') key: string, @Body() dto: UpdateSettingValueDto) {
    const setting = await this.siteSettingService.upsert(key, dto.value ?? '');
    return setting;
  }
}
