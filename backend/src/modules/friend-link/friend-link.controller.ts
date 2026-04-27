import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
import { FriendLinkService } from './friend-link.service';
import { CreateFriendLinkDto } from './dto/create-friend-link.dto';
import { UpdateFriendLinkDto } from './dto/update-friend-link.dto';

@ApiTags('友情链接')
@Controller('friend-links')
export class FriendLinkController {
  constructor(private readonly friendLinkService: FriendLinkService) {}

  @Get()
  @ApiOperation({ summary: '获取友情链接列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async findAll() {
    const links = await this.friendLinkService.findAll();
    return links;
  }

  @Get(':id')
  @ApiOperation({ summary: '获取友情链接详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '友情链接不存在' })
  @HttpCode(HttpStatus.OK)
  async findOne(@Param('id') id: string) {
    const link = await this.friendLinkService.findOne(id);
    return link;
  }

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建友情链接' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@Body() dto: CreateFriendLinkDto) {
    const link = await this.friendLinkService.create(dto);
    return link;
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
