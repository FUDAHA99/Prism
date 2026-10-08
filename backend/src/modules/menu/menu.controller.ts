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
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MenuService } from './menu.service';
import { CreateMenuDto, UpdateMenuDto } from './dto/menu.dto';
import { Access } from '../../common/authz/access.decorator';

@ApiTags('导航菜单')
@ApiBearerAuth()
@Access('admin')
@Controller('menus')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  @ApiOperation({ summary: '获取菜单列表（平铺）' })
  async findAll() {
    return this.menuService.findAll();
  }

  @Post()
  @ApiOperation({ summary: '创建菜单项' })
  async create(@Body() dto: CreateMenuDto) {
    return this.menuService.create(dto);
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
