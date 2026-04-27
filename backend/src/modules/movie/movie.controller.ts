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
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';

import {
  MovieService,
  CreateMovieDto,
  UpdateMovieDto,
  QueryMovieDto,
  CreateMovieSourceDto,
  CreateMovieEpisodeDto,
} from './movie.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';

@ApiTags('影视管理')
@Controller('movies')
export class MovieController {
  constructor(private readonly movieService: MovieService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建影视' })
  async create(@Body() dto: CreateMovieDto, @CurrentUser() user: AuthUser) {
    return this.movieService.create(dto, user.id);
  }

  @Get()
  @ApiOperation({ summary: '获取影视列表' })
  async findAll(@Query() query: QueryMovieDto) {
    return this.movieService.findAll(query);
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: '【公共】通过 slug 获取影视详情（前台用）' })
  async findBySlug(@Param('slug') slug: string) {
    const movie = await this.movieService.findBySlug(slug);
    if (movie?.id) await this.movieService.incrementViewCount(movie.id);
    return movie;
  }

  @Get(':id')
  @ApiOperation({ summary: '获取影视详情' })
  async findOne(@Param('id') id: string) {
    const movie = await this.movieService.findOne(id);
    await this.movieService.incrementViewCount(id);
    return movie;
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新影视' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateMovieDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.movieService.update(id, dto, user.id);
  }

  @Post(':id/publish')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '发布影视' })
  async publish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.movieService.publish(id, user.id);
  }

  @Post(':id/unpublish')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消发布影视' })
  async unpublish(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.movieService.unpublish(id, user.id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除影视（软删除）' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.movieService.remove(id, user.id);
  }

  // ============ Sources ============

  @Post(':id/sources')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '为影视添加播放线路' })
  async addSource(
    @Param('id') movieId: string,
    @Body() dto: CreateMovieSourceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.movieService.addSource(movieId, dto, user.id);
  }

  @Delete('sources/:sourceId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除线路' })
  async removeSource(
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.movieService.removeSource(sourceId, user.id);
  }

  // ============ Episodes ============

  @Post('sources/:sourceId/episodes')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '为线路添加剧集' })
  async addEpisode(
    @Param('sourceId') sourceId: string,
    @Body() dto: CreateMovieEpisodeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.movieService.addEpisode(sourceId, dto, user.id);
  }

  @Patch('episodes/:episodeId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新剧集' })
  async updateEpisode(
    @Param('episodeId') episodeId: string,
    @Body() dto: Partial<CreateMovieEpisodeDto>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.movieService.updateEpisode(episodeId, dto, user.id);
  }

  @Delete('episodes/:episodeId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除剧集' })
  async removeEpisode(
    @Param('episodeId') episodeId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.movieService.removeEpisode(episodeId, user.id);
  }
}
