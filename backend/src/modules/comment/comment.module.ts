import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Comment } from './entities/comment.entity';
import { Content } from '../content/entities/content.entity';
import { SiteSettingModule } from '../site-setting/site-setting.module';
import { CommentService } from './comment.service';
import { CommentController } from './comment.controller';

@Module({
  // Content 只用来确认被评论的内容已发布；SiteSettingService 提供评论开关（enable_comment / comment_audit）
  imports: [TypeOrmModule.forFeature([Comment, Content]), SiteSettingModule],
  controllers: [CommentController],
  providers: [CommentService],
  exports: [CommentService],
})
export class CommentModule {}
