import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditLog } from './entities/audit-log.entity';
import { User } from '../user/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, User]),
    ConfigModule,
  ],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
