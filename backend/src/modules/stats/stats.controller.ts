import {
  Controller,
  Body,
  Get,
  Post,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { Access } from '../../common/authz/access.decorator';
import { CurrentViewer, isAdmin, Viewer } from '../../common/authz/viewer';
import { Throttle } from '@nestjs/throttler';
import { SearchKeywordsService } from './search-keywords.service';
import { RecordSearchKeywordDto } from './dto/record-search-keyword.dto';

@ApiTags('统计数据')
@Controller('stats')
@ApiBearerAuth()
export class StatsController {
  constructor(
    private readonly statsService: StatsService,
    private readonly searchKeywordsService: SearchKeywordsService,
  ) {}

  @Post('search-keywords')
  @Access('public')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '记录一次影视搜索提交（尽力统计）' })
  async recordSearchKeyword(@Body() dto: RecordSearchKeywordDto): Promise<void> {
    await this.searchKeywordsService.record(dto.keyword);
  }

  @Get('search-keywords')
  @Access('admin')
  @ApiOperation({ summary: '近 7 个北京时间自然日的影视搜索提交次数 Top 20' })
  async getSearchKeywords() {
    return this.searchKeywordsService.getTop();
  }

  @Get('dashboard')
  @Access('staff')
  @ApiOperation({ summary: '获取仪表盘统计数据' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async getDashboard() {
    const stats = await this.statsService.getDashboardStats();
    return stats;
  }

  /** admin 与 editor 都能看；主机名、Node 版本、CPU 型号只返回给 admin */
  @Get('system')
  @Access('staff')
  @ApiOperation({ summary: '获取系统信息（CPU/内存/影音内容数量/7日新增；主机名、Node 版本、CPU 型号仅 admin）' })
  @HttpCode(HttpStatus.OK)
  async getSystem(@CurrentViewer() viewer: Viewer) {
    return this.statsService.getSystemInfo({ includeHostDetails: isAdmin(viewer) });
  }
}
