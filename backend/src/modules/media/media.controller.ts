import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UseFilters,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { v4 as uuidv4 } from 'uuid';

import { MediaService, QueryMediaDto } from './media.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/interfaces/auth.interface';
import { MulterExceptionFilter } from './multer-exception.filter';

// 扩展名只由（已过白名单的）mimetype 决定，不信任客户端文件名：express.static 按扩展名回推
// Content-Type，originalname 写成 .html/.svg 时，一旦补上落盘逻辑就是同源存储型 XSS。不要加 image/svg+xml。
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'application/pdf': '.pdf', 'video/mp4': '.mp4',
};
const ALLOWED_MIME_TYPES = Object.keys(MIME_EXTENSIONS);
// 大小上限由 multer limits.fileSize 在解析阶段强制（media.module.ts / upload-limits.ts），此处不再检查

@ApiTags('媒体管理')
@Controller('media')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get()
  @ApiOperation({ summary: '获取媒体文件列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@Query() query: QueryMediaDto) {
    const result = await this.mediaService.findAll(query);
    return { message: '获取媒体列表成功', data: result.data, meta: result.meta };
  }

  @Get(':id')
  @ApiOperation({ summary: '获取媒体文件详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '文件不存在' })
  async findOne(@Param('id') id: string) {
    const file = await this.mediaService.findOne(id);
    return { message: '获取媒体文件成功', data: file };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  @UseFilters(MulterExceptionFilter)
  @ApiOperation({ summary: '上传文件' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: '上传成功' })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('不支持的文件类型');
    }

    const ext = MIME_EXTENSIONS[file.mimetype];
    const filename = `${uuidv4()}${ext}`;
    const url = `/uploads/${filename}`;

    const media = await this.mediaService.saveFileRecord({
      filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      url,
      uploaderId: user.id,
    });

    return { message: '文件上传成功', data: media };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除媒体文件' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 403, description: '权限不足' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.mediaService.remove(id, user.id, user.roles);
  }
}
