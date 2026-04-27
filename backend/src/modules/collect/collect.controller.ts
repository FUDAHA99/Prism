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
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';

import {
  CollectSourceService,
  CreateCollectSourceDto,
  UpdateCollectSourceDto,
  QueryCollectSourceDto,
  UpsertCategoryMappingDto,
} from './collect-source.service';
import {
  CollectExecutorService,
  RunCollectDto,
} from './collect-executor.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';

@ApiTags('采集管理')
@Controller('collect')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class CollectController {
  constructor(
    private readonly sourceService: CollectSourceService,
    private readonly executor: CollectExecutorService,
  ) {}

  // ============ Source CRUD ============

  @Post('sources')
  @ApiOperation({ summary: '创建采集源' })
  createSource(
    @Body() dto: CreateCollectSourceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sourceService.create(dto, user.id);
  }

  @Get('sources')
  @ApiOperation({ summary: '采集源列表' })
  findAllSources(@Query() query: QueryCollectSourceDto) {
    return this.sourceService.findAll(query);
  }

  @Get('sources/:id')
  @ApiOperation({ summary: '采集源详情（含分类映射）' })
  findOneSource(@Param('id') id: string) {
    return this.sourceService.findOne(id);
  }

  @Patch('sources/:id')
  @ApiOperation({ summary: '更新采集源' })
  updateSource(
    @Param('id') id: string,
    @Body() dto: UpdateCollectSourceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sourceService.update(id, dto, user.id);
  }

  @Delete('sources/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除采集源' })
  async removeSource(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.sourceService.remove(id, user.id);
  }

  // ============ 测试 + 探查分类 ============

  @Post('sources/:id/test')
  @ApiOperation({ summary: '测试采集源连接' })
  test(@Param('id') id: string) {
    return this.sourceService.testConnection(id);
  }

  @Get('sources/:id/discover-categories')
  @ApiOperation({ summary: '从采集源探查分类列表（用于映射）' })
  discoverCategories(@Param('id') id: string) {
    return this.sourceService.discoverSourceCategories(id);
  }

  // ============ 分类映射 ============

  @Get('sources/:id/mappings')
  @ApiOperation({ summary: '采集源已有的分类映射' })
  listMappings(@Param('id') id: string) {
    return this.sourceService.listMappings(id);
  }

  @Post('sources/:id/mappings')
  @ApiOperation({ summary: '新增/更新分类映射' })
  upsertMapping(
    @Param('id') id: string,
    @Body() dto: UpsertCategoryMappingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sourceService.upsertMapping(id, dto, user.id);
  }

  @Post('sources/:id/mappings/batch')
  @ApiOperation({ summary: '批量分类映射' })
  batchMapping(
    @Param('id') id: string,
    @Body() body: { items: UpsertCategoryMappingDto[] },
    @CurrentUser() user: AuthUser,
  ) {
    return this.sourceService.batchUpsertMappings(id, body.items, user.id);
  }

  @Delete('mappings/:mappingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除分类映射' })
  async removeMapping(
    @Param('mappingId') mappingId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.sourceService.removeMapping(mappingId, user.id);
  }

  // ============ 执行采集 ============

  @Post('sources/:id/run')
  @ApiOperation({ summary: '触发采集（异步，立即返回 logId）' })
  run(
    @Param('id') id: string,
    @Body() dto: RunCollectDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.executor.startRun(id, dto, user.id);
  }

  // ============ 日志 ============

  @Get('logs')
  @ApiOperation({ summary: '采集日志列表' })
  listLogs(
    @Query('sourceId') sourceId?: string,
    @Query('page') page?: number,
    @Query('pageSize') pageSize?: number,
  ) {
    return this.executor.listLogs({ sourceId, page, pageSize });
  }

  @Get('logs/:id')
  @ApiOperation({ summary: '采集日志详情' })
  getLog(@Param('id') id: string) {
    return this.executor.getLog(id);
  }
}
