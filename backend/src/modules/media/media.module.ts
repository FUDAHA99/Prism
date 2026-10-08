import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { MediaFile } from './entities/media-file.entity';
import { AuditModule } from '../audit/audit.module';
import { resolveUploadMaxSize } from './upload-limits';

@Module({
  imports: [
    TypeOrmModule.forFeature([MediaFile]),
    // limits 必须在 multer 解析阶段生效：memoryStorage 会把整个文件缓冲进内存，
    // controller 里的 file.size 检查发生在缓冲完成之后，约束不了内存占用。
    MulterModule.registerAsync({
      inject: [ConfigService], // ConfigModule 为 isGlobal，无需 imports
      useFactory: (config: ConfigService) => ({
        storage: memoryStorage(),
        // 浏览器按 UTF-8 发送 filename，busboy 默认 latin1 会让中文文件名乱码（multer>=2.3 支持）
        defParamCharset: 'utf8',
        limits: {
          fileSize: resolveUploadMaxSize(config),
          files: 1,
          fields: 5,
          parts: 6,
          fieldNameSize: 100,
          fieldSize: 64 * 1024,
          headerPairs: 20,
          fieldNestingDepth: 2,      // multer>=2.2
          fieldArrayIndexLimit: 100, // multer>=2.3
        },
      }),
    }),
    AuditModule,
  ],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
