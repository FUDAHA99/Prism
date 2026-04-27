import {
  Controller,
  Get,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { StatsService } from './stats.service';

@ApiTags('统计数据')
@Controller('stats')
@UseGuards(AuthGuard('jwt'))
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

  @Get('system')
  @ApiOperation({ summary: '获取系统信息（CPU/内存/影音内容数量/7日新增）' })
  @HttpCode(HttpStatus.OK)
  async getSystem() {
    return this.statsService.getSystemInfo();
  }
}
