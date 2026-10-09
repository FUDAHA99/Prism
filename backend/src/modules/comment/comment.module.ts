import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Comment } from './entities/comment.entity';
import { Content } from '../content/entities/content.entity';
import { User } from '../user/entities/user.entity';
import { SiteSettingModule } from '../site-setting/site-setting.module';
import { CommentService } from './comment.service';
import { CommentController } from './comment.controller';

@Module({
  // Content 只用来确认被评论的内容已发布；User 只用来确认游客昵称没有冒用注册用户的用户名 / 昵称；
  // SiteSettingService 提供评论开关（enable_comment / comment_audit）
  imports: [TypeOrmModule.forFeature([Comment, Content, User]), SiteSettingModule],
  controllers: [CommentController],
  providers: [CommentService],
  exports: [CommentService],
})
export class CommentModule {}
