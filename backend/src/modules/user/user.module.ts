import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { UserService } from './user.service';
import { UserController } from './user.controller';
import { User } from './entities/user.entity';

import { RoleModule } from '../role/role.module';
import { AuditModule } from '../audit/audit.module';
import { RedisModule } from '../../shared/redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    ConfigModule,
    RoleModule,
    AuditModule,
    RedisModule,
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService, TypeOrmModule],
})
export class UserModule {}
