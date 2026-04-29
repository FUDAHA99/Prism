import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WatchHistoryService, ReportProgressDto } from './watch-history.service';
import { WatchContentType } from './entities/watch-history.entity';

@ApiTags('观看记录')
@Controller('watch-history')
export class WatchHistoryController {
  constructor(private readonly service: WatchHistoryService) {}

  /**
   * 上报播放进度（无需登录，游客也可上报）
   * 登录用户自动读取 JWT；游客通过 body.guestId 标识
   */
  @Post('report')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '上报播放进度' })
  async report(@Body() dto: ReportProgressDto, @Request() req: any) {
    // 尝试从 JWT 提取 userId（可选认证，不强制）
    let userId: string | undefined;
    try {
      const authHeader: string = req.headers?.authorization ?? '';
      if (authHeader.startsWith('Bearer ')) {
        // 直接解 JWT payload（不走 Guard，避免 401）
        const payload = JSON.parse(
          Buffer.from(authHeader.split('.')[1], 'base64url').toString(),
        );
        if (payload?.sub) userId = payload.sub;
      }
    } catch {}

    await this.service.report(dto, userId);
  }

  /**
   * 查询某内容的播放进度
   */
  @Get()
  @ApiOperation({ summary: '查询播放进度' })
  async findProgress(
    @Query('contentType') contentType: WatchContentType,
    @Query('contentId') contentId: string,
    @Query('guestId') guestId: string,
    @Request() req: any,
  ) {
    let userId: string | undefined;
    try {
      const authHeader: string = req.headers?.authorization ?? '';
      if (authHeader.startsWith('Bearer ')) {
        const payload = JSON.parse(
          Buffer.from(authHeader.split('.')[1], 'base64url').toString(),
        );
        if (payload?.sub) userId = payload.sub;
      }
    } catch {}

    const record = await this.service.findProgress(
      contentType,
      contentId,
      userId,
      guestId,
    );

    if (!record) return null;

    return {
      srcIdx: record.srcIdx,
      epIdx: record.epIdx,
      episodeId: record.episodeId,
      progressSec: record.progressSec,
      durationSec: record.durationSec,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * 最近观看列表（备用）
   */
  @Get('recent')
  @ApiOperation({ summary: '最近观看列表' })
  async findRecent(
    @Query('limit') limit = 10,
    @Query('guestId') guestId: string,
    @Request() req: any,
  ) {
    let userId: string | undefined;
    try {
      const authHeader: string = req.headers?.authorization ?? '';
      if (authHeader.startsWith('Bearer ')) {
        const payload = JSON.parse(
          Buffer.from(authHeader.split('.')[1], 'base64url').toString(),
        );
        if (payload?.sub) userId = payload.sub;
      }
    } catch {}

    return this.service.findRecent(userId, guestId, Number(limit));
  }
}
