import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { FriendLinkService } from './friend-link.service';
import { CreateFriendLinkDto } from './dto/create-friend-link.dto';
import { UpdateFriendLinkDto } from './dto/update-friend-link.dto';
import { Access } from '../../common/authz/access.decorator';
import { CurrentViewer, Viewer } from '../../common/authz/viewer';

@ApiTags('友情链接')
@Controller('friend-links')
export class FriendLinkController {
  constructor(private readonly friendLinkService: FriendLinkService) {}

  /** 后台友链页与公开读共用：后台角色看全部（只读；写接口仍只有 admin），其他人只看「显示」的友链与公开字段（见 FriendLinkService.findAll） */
  @Get()
  @Access('optional')
  @ApiOperation({ summary: '获取友情链接列表（后台角色看全部；其他人只看显示中的友链）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async findAll(@CurrentViewer() viewer: Viewer) {
    return this.friendLinkService.findAll(viewer);
  }

  @Post()
  @Access('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建友情链接' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@Body() dto: CreateFriendLinkDto) {
    const link = await this.friendLinkService.create(dto);
    return link;
  }

  @Patch(':id')
  @Access('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新友情链接' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '友情链接不存在' })
  @HttpCode(HttpStatus.OK)
  async update(@Param('id') id: string, @Body() dto: UpdateFriendLinkDto) {
    const link = await this.friendLinkService.update(id, dto);
    return link;
  }

  @Delete(':id')
  @Access('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除友情链接' })
  @ApiResponse({ status: 200, description: '删除成功' })
  @ApiResponse({ status: 404, description: '友情链接不存在' })
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string) {
    await this.friendLinkService.remove(id);
    return { message: '友情链接删除成功' };
  }
}
