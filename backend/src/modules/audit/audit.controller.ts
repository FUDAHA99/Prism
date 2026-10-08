import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { Access } from '../../common/authz/access.decorator';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

@ApiTags('审计日志')
@ApiBearerAuth()
@Access('admin')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /** 列表只返回 id/时间/用户/动作/资源/IP，不含 oldValues、newValues、userAgent */
  @Get()
  @ApiOperation({ summary: '获取审计日志列表' })
  async findAll(@Query() query: QueryAuditLogDto) {
    return this.auditService.findAll(query.page ?? 1, query.limit ?? 20, query.action || undefined);
  }
}
