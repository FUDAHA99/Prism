import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SiteSettingService } from './site-setting.service';
import { BatchUpsertSettingDto } from './dto/upsert-setting.dto';
import { Access } from '../../common/authz/access.decorator';

/**
 * 系统配置。只有 GET /public 对外（9 个白名单键，portal SSR 用），其余仅管理员。
 *
 * 此前还有 GET /:key 与 PUT /:key 两个完全无鉴权的接口：前者能读到 enable_register 等
 * 私有键，后者匿名即可改站名 / logo / 任意新键。前后台均无调用方，已删除；
 * 后台「系统配置」页只用 GET / 与 POST /batch。
 */
@ApiTags('系统配置')
@Controller('site-settings')
export class SiteSettingController {
  constructor(private readonly siteSettingService: SiteSettingService) {}

  @Get('public')
  @Access('public')
  @ApiOperation({ summary: '【公共】获取前台可见的站点配置' })
  @HttpCode(HttpStatus.OK)
  async findPublic() {
    return this.siteSettingService.findPublic();
  }

  @Get()
  @Access('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取所有配置（按分组）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async findAll() {
    const settings = await this.siteSettingService.findAll();
    return settings;
  }

  @Post('batch')
  @Access('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: '批量保存配置' })
  @ApiResponse({ status: 200, description: '保存成功' })
  @HttpCode(HttpStatus.OK)
  async batchUpsert(@Body() dto: BatchUpsertSettingDto) {
    await this.siteSettingService.batchUpsert(dto.settings);
    return { message: '批量保存配置成功' };
  }
}
