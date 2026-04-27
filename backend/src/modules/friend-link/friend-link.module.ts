import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FriendLink } from './entities/friend-link.entity';
import { FriendLinkService } from './friend-link.service';
import { FriendLinkController } from './friend-link.controller';

@Module({
  imports: [TypeOrmModule.forFeature([FriendLink])],
  controllers: [FriendLinkController],
  providers: [FriendLinkService],
  exports: [FriendLinkService],
})
export class FriendLinkModule {}
