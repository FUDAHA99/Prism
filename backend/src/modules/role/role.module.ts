import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { RoleService } from './role.service';
import { RoleController } from './role.controller';
import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';

import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Role, Permission]),
    ConfigModule,
    AuditModule,
  ],
  controllers: [RoleController],
  providers: [RoleService],
  exports: [RoleService, TypeOrmModule],
})
export class RoleModule {}
