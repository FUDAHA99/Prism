import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { Access } from '../../common/authz/access.decorator';
import { CurrentViewer, isAdmin, Viewer } from '../../common/authz/viewer';

@ApiTags('统计数据')
@Access('staff')
@Controller('stats')
@ApiBearerAuth()
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: '获取仪表盘统计数据' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async getDashboard() {
    const stats = await this.statsService.getDashboardStats();
    return stats;
  }

  /** admin 与 editor 都能看；主机名、Node 版本、CPU 型号只返回给 admin */
  @Get('system')
  @ApiOperation({ summary: '获取系统信息（CPU/内存/影音内容数量/7日新增；主机名、Node 版本、CPU 型号仅 admin）' })
  @HttpCode(HttpStatus.OK)
  async getSystem(@CurrentViewer() viewer: Viewer) {
    return this.statsService.getSystemInfo({ includeHostDetails: isAdmin(viewer) });
  }
}
