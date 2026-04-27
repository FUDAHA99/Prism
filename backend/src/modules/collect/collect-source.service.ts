import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CollectSource, CollectSourceStatus, CollectSourceType, CollectContentType } from './entities/collect-source.entity';
import { CollectCategoryMapping } from './entities/collect-category-mapping.entity';
import { fetchMacCmsList } from './maccms-client';
import { AuditService } from '../audit/audit.service';

export interface CreateCollectSourceDto {
  name: string;
  sourceType?: CollectSourceType;
  apiUrl: string;
  contentType?: CollectContentType;
  status?: CollectSourceStatus;
  sortOrder?: number;
  timeoutSec?: number;
  userAgent?: string;
  extraHeaders?: Record<string, string>;
  defaultPlayFrom?: string;
  remark?: string;
}

export interface UpdateCollectSourceDto extends Partial<CreateCollectSourceDto> {}

export interface QueryCollectSourceDto {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: CollectSourceStatus;
  contentType?: CollectContentType;
}

export interface UpsertCategoryMappingDto {
  sourceCategoryId: string;
  sourceCategoryName: string;
  localCategoryId?: string | null;
  enabled?: boolean;
}

@Injectable()
export class CollectSourceService {
  constructor(
    @InjectRepository(CollectSource)
    private readonly sourceRepo: Repository<CollectSource>,
    @InjectRepository(CollectCategoryMapping)
    private readonly mappingRepo: Repository<CollectCategoryMapping>,
    private readonly auditService: AuditService,
  ) {}

  // ============ CRUD ============

  async create(dto: CreateCollectSourceDto, userId: string) {
    const entity = this.sourceRepo.create({
      ...dto,
      sourceType: dto.sourceType ?? CollectSourceType.MACCMS_JSON,
      contentType: dto.contentType ?? CollectContentType.MOVIE,
      status: dto.status ?? CollectSourceStatus.ACTIVE,
    });
    const saved = await this.sourceRepo.save(entity);
    await this.auditService.log({
      userId,
      action: 'CREATE',
      resourceType: 'collect_source',
      resourceId: saved.id,
      newValues: { name: saved.name, apiUrl: saved.apiUrl },
    });
    return saved;
  }

  async findAll(query: QueryCollectSourceDto = {}) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.sourceRepo
      .createQueryBuilder('s')
      .orderBy('s.sortOrder', 'DESC')
      .addOrderBy('s.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.keyword) {
      qb.andWhere('(s.name LIKE :k OR s.apiUrl LIKE :k)', {
        k: `%${query.keyword}%`,
      });
    }
    if (query.status) qb.andWhere('s.status = :st', { st: query.status });
    if (query.contentType)
      qb.andWhere('s.contentType = :ct', { ct: query.contentType });

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async findOne(id: string) {
    const item = await this.sourceRepo.findOne({
      where: { id },
      relations: { categoryMappings: true },
    });
    if (!item) throw new NotFoundException('采集源不存在');
    return item;
  }

  async update(id: string, dto: UpdateCollectSourceDto, userId: string) {
    const item = await this.findOne(id);
    Object.assign(item, dto);
    const saved = await this.sourceRepo.save(item);
    await this.auditService.log({
      userId,
      action: 'UPDATE',
      resourceType: 'collect_source',
      resourceId: id,
      newValues: dto,
    });
    return saved;
  }

  async remove(id: string, userId: string) {
    const item = await this.findOne(id);
    await this.sourceRepo.remove(item); // mappings 通过 CASCADE 自动清掉
    await this.auditService.log({
      userId,
      action: 'DELETE',
      resourceType: 'collect_source',
      resourceId: id,
      newValues: { name: item.name },
    });
  }

  // ============ 测试连接 ============

  /**
   * 测试一次接口连通性 + 返回首页前几条
   */
  async testConnection(id: string) {
    const source = await this.findOne(id);
    try {
      const res = await fetchMacCmsList(source, { page: 1 });
      return {
        ok: true,
        code: res.code,
        msg: res.msg,
        page: res.page,
        pagecount: res.pagecount,
        limit: res.limit,
        total: res.total,
        sample: (res.list || []).slice(0, 3).map((x: any) => ({
          vod_id: x.vod_id,
          vod_name: x.vod_name,
          type_id: x.type_id,
          type_name: x.type_name,
          vod_time: x.vod_time,
        })),
      };
    } catch (e: any) {
      return { ok: false, error: e.message ?? String(e) };
    }
  }

  // ============ 拉取源分类 ============

  /**
   * 探查源站全部分类（通过列表接口的分页/分类聚合）
   * MacCMS 列表接口本身不直接返回 type 列表 —— 我们扫一两页 + 分类去重，
   * 同时支持后续手动 upsert 映射。
   */
  async discoverSourceCategories(id: string) {
    const source = await this.findOne(id);
    const seen = new Map<string, { id: string; name: string }>();

    // 拉前 3 页用于发现分类（多了浪费请求，少了可能漏）
    for (let p = 1; p <= 3; p++) {
      try {
        const res = await fetchMacCmsList(source, { page: p });
        for (const item of res.list || []) {
          const tid = String(item.type_id);
          if (!seen.has(tid)) {
            seen.set(tid, { id: tid, name: item.type_name || `分类${tid}` });
          }
        }
        if (p >= (res.pagecount || 1)) break;
      } catch {
        break;
      }
    }
    return Array.from(seen.values());
  }

  // ============ 分类映射 ============

  async listMappings(sourceId: string) {
    return this.mappingRepo.find({
      where: { sourceId },
      order: { sourceCategoryName: 'ASC' },
    });
  }

  async upsertMapping(
    sourceId: string,
    dto: UpsertCategoryMappingDto,
    userId: string,
  ) {
    await this.findOne(sourceId); // 确保源存在

    let m = await this.mappingRepo.findOne({
      where: { sourceId, sourceCategoryId: dto.sourceCategoryId },
    });
    if (m) {
      m.sourceCategoryName = dto.sourceCategoryName;
      m.localCategoryId = dto.localCategoryId ?? null;
      m.enabled = dto.enabled ?? m.enabled;
    } else {
      m = this.mappingRepo.create({
        sourceId,
        sourceCategoryId: dto.sourceCategoryId,
        sourceCategoryName: dto.sourceCategoryName,
        localCategoryId: dto.localCategoryId ?? null,
        enabled: dto.enabled ?? true,
      });
    }
    const saved = await this.mappingRepo.save(m);
    await this.auditService.log({
      userId,
      action: 'UPSERT',
      resourceType: 'collect_category_mapping',
      resourceId: saved.id,
      newValues: dto,
    });
    return saved;
  }

  async batchUpsertMappings(
    sourceId: string,
    items: UpsertCategoryMappingDto[],
    userId: string,
  ) {
    const results = [];
    for (const it of items) {
      results.push(await this.upsertMapping(sourceId, it, userId));
    }
    return results;
  }

  async removeMapping(mappingId: string, userId: string) {
    const m = await this.mappingRepo.findOne({ where: { id: mappingId } });
    if (!m) throw new NotFoundException('映射不存在');
    await this.mappingRepo.remove(m);
    await this.auditService.log({
      userId,
      action: 'DELETE',
      resourceType: 'collect_category_mapping',
      resourceId: mappingId,
    });
  }

  // ============ 内部工具：取启用映射 ============

  async getEnabledMappingMap(
    sourceId: string,
  ): Promise<Map<string, string | null>> {
    const list = await this.mappingRepo.find({
      where: { sourceId, enabled: true },
    });
    const map = new Map<string, string | null>();
    for (const m of list) map.set(m.sourceCategoryId, m.localCategoryId);
    return map;
  }
}
