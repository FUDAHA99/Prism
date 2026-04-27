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
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { MenuService, CreateMenuDto, UpdateMenuDto } from './menu.service';

@ApiTags('导航菜单')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
@Controller('menus')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  @ApiOperation({ summary: '获取菜单列表（平铺）' })
  async findAll() {
    return this.menuService.findAll();
  }

  @Get('tree')
  @ApiOperation({ summary: '获取菜单树' })
  async findTree() {
    return this.menuService.findTree();
  }

  @Post()
  @ApiOperation({ summary: '创建菜单项' })
  async create(@Body() dto: CreateMenuDto) {
    return this.menuService.create(dto);
  }

  @Patch('reorder')
  @ApiOperation({ summary: '批量更新排序和父级' })
  async reorder(
    @Body() body: { items: Array<{ id: string; sortOrder: number; parentId?: string }> },
  ) {
    await this.menuService.reorder(body.items);
    return this.menuService.findAll();
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新菜单项' })
  async update(@Param('id') id: string, @Body() dto: UpdateMenuDto) {
    return this.menuService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除菜单项' })
  async remove(@Param('id') id: string) {
    await this.menuService.remove(id);
  }
}
