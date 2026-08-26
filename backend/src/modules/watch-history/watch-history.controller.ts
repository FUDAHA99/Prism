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
  BadRequestException,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtOptionalGuard } from '../../common/guards/jwt-optional.guard';
import { WatchHistoryService } from './watch-history.service';
import { ReportProgressDto } from './dto/report-progress.dto';
import { WatchContentType } from './entities/watch-history.entity';

const CONTENT_TYPES: WatchContentType[] = ['movie', 'novel', 'comic'];

/**
 * 观看记录。三条接口都是「登录可用、游客也可用」。
 *
 * 此前它们各自手工 base64 解 Authorization 头取 payload.sub 当 userId，
 * 不验签、不校验 exp、不查黑名单 —— 构造 `Bearer x.<自制payload>.y`
 * 即可读写任意用户的观看记录。现改用 JwtOptionalGuard 走 Passport，
 * 由 JwtStrategy 统一完成验签、过期、禁用状态与黑名单检查；
 * 未登录时 req.user 为 undefined，按游客处理，不会 401。
 */
@ApiTags('观看记录')
@ApiBearerAuth()
@UseGuards(JwtOptionalGuard)
@Controller('watch-history')
export class WatchHistoryController {
  constructor(private readonly service: WatchHistoryService) {}

  /** JwtStrategy.validate 返回对象的主键字段名是 id */
  private userIdOf(req: any): string | undefined {
    return req.user?.id;
  }

  private assertContentType(value: string): WatchContentType {
    if (!CONTENT_TYPES.includes(value as WatchContentType)) {
      throw new BadRequestException('contentType 必须是 movie / novel / comic');
    }
    return value as WatchContentType;
  }

  @Post('report')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '上报播放进度（登录用户与游客均可）' })
  async report(@Body() dto: ReportProgressDto, @Request() req: any) {
    await this.service.report(dto, this.userIdOf(req));
  }

  @Get()
  @ApiOperation({ summary: '查询播放进度' })
  async findProgress(
    @Query('contentType') contentType: string,
    @Query('contentId') contentId: string,
    @Query('guestId') guestId: string,
    @Request() req: any,
  ) {
    const record = await this.service.findProgress(
      this.assertContentType(contentType),
      contentId,
      this.userIdOf(req),
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

  @Get('recent')
  @ApiOperation({ summary: '最近观看列表' })
  async findRecent(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('guestId') guestId: string,
    @Request() req: any,
  ) {
    // 夹紧上限，避免 ?limit=100000 拖库
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    return this.service.findRecent(this.userIdOf(req), guestId, safeLimit);
  }
}
