import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CollectSource, CollectSourceStatus, CollectSourceType, CollectContentType } from './entities/collect-source.entity';
import { CollectCategoryMapping } from './entities/collect-category-mapping.entity';
import { collectErrorLogDetail, collectErrorMessage, fetchMacCmsList } from './maccms-client';
import { AuditService } from '../audit/audit.service';
import { auditKeysOnly, auditUrlHost, changedAuditFields } from '../audit/audit-summary';
import {
  CreateCollectSourceDto,
  QueryCollectSourceDto,
  UpdateCollectSourceDto,
} from './dto/collect-source.dto';
import { UpsertCategoryMappingDto } from './dto/category-mapping.dto';
import { assertPlainObjects, isPlainObject } from '../../common/utils/plain-object';

/** 「测试连接」回显给后台的上游字符串（msg、样本标题等）截到这么长 */
const TEST_ECHO_MAX_CHARS = 200;

function clip(value: unknown): string | number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value);
  return text.length > TEST_ECHO_MAX_CHARS ? `${text.slice(0, TEST_ECHO_MAX_CHARS)}…` : text;
}

/** 采集源可写的列（与 CreateCollectSourceDto 一致）；按白名单逐个挑，undefined 视为没提交 */
const SOURCE_EDITABLE_FIELDS = [
  'name',
  'sourceType',
  'apiUrl',
  'contentType',
  'status',
  'sortOrder',
  'timeoutSec',
  'userAgent',
  'extraHeaders',
  'defaultPlayFrom',
  'remark',
] as const;

function pickSourceFields(dto: UpdateCollectSourceDto): Partial<CollectSource> {
  const source = dto as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SOURCE_EDITABLE_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as Partial<CollectSource>;
}

/** 映射项：必须是对象，查找键 sourceCategoryId 与 NOT NULL 的 sourceCategoryName 必须是非空字符串 */
function assertMappingItem(dto: UpsertCategoryMappingDto): void {
  if (!isPlainObject(dto)) {
    throw new BadRequestException('分类映射必须是对象');
  }
  if (typeof dto.sourceCategoryId !== 'string' || dto.sourceCategoryId.trim() === '') {
    throw new BadRequestException('sourceCategoryId（源站分类 ID）不能为空');
  }
  if (typeof dto.sourceCategoryName !== 'string' || dto.sourceCategoryName.trim() === '') {
    throw new BadRequestException('sourceCategoryName（源站分类名）不能为空');
  }
}

/** 与 collect_category_mappings 的列长一致：超长的源分类 ID 存不进去，名称截断 */
const SOURCE_CATEGORY_ID_MAX = 50;
const SOURCE_CATEGORY_NAME_MAX = 200;

@Injectable()
export class CollectSourceService {
  private readonly logger = new Logger(CollectSourceService.name);

  constructor(
    @InjectRepository(CollectSource)
    private readonly sourceRepo: Repository<CollectSource>,
    @InjectRepository(CollectCategoryMapping)
    private readonly mappingRepo: Repository<CollectCategoryMapping>,
    private readonly auditService: AuditService,
  ) {}

  // ============ CRUD ============

  async create(dto: CreateCollectSourceDto, userId: string) {
    // 逐字段写库（不展开请求体）：id / totalCollected / lastRunAt 等由服务端维护
    const entity = this.sourceRepo.create({
      ...pickSourceFields(dto),
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
      // apiUrl 只记 host（资源站常把 key 放在 query 里），请求头只记名称
      newValues: {
        name: saved.name,
        apiHost: auditUrlHost(saved.apiUrl),
        extraHeaders: auditKeysOnly(saved.extraHeaders),
      },
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
    const patch = pickSourceFields(dto);
    // 必须在 Object.assign 之前算：之后 item 已是新值
    const changedFields = changedAuditFields(item, patch);
    Object.assign(item, patch);
    const saved = await this.sourceRepo.save(item);
    // 不记请求体原文：只记变更字段名，
    // apiUrl 只记 host、请求头只记名称
    const newValues: Record<string, unknown> = { changedFields };
    if (changedFields.includes('apiUrl')) newValues.apiHost = auditUrlHost(saved.apiUrl);
    if (changedFields.includes('extraHeaders')) newValues.extraHeaders = auditKeysOnly(saved.extraHeaders);
    await this.auditService.log({
      userId,
      action: 'UPDATE',
      resourceType: 'collect_source',
      resourceId: id,
      newValues,
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
   * 测试一次接口连通性 + 返回首页前几条。
   * 出站请求走 safe-fetch（拦截内网/元数据地址）；失败时只回固定文案，不回显上游响应内容。
   */
  async testConnection(id: string) {
    const source = await this.findOne(id);
    try {
      const res = await fetchMacCmsList(source, { page: 1 });
      return {
        ok: true,
        code: res.code,
        msg: clip(res.msg),
        page: res.page,
        pagecount: res.pagecount,
        limit: clip(res.limit),
        total: res.total,
        sample: (res.list || []).slice(0, 3).map((x: any) => ({
          vod_id: clip(x?.vod_id),
          vod_name: clip(x?.vod_name),
          type_id: clip(x?.type_id),
          type_name: clip(x?.type_name),
          vod_time: clip(x?.vod_time),
        })),
      };
    } catch (e) {
      this.logger.warn(`测试采集源 ${id} 失败：${collectErrorLogDetail(e)}`);
      return { ok: false, error: collectErrorMessage(e) };
    }
  }

  // ============ 拉取源分类 ============

  /**
   * 探查源站全部分类（通过列表接口的分页/分类聚合）
   * MacCMS 列表接口本身不直接返回 type 列表 —— 我们扫一两页 + 分类去重，
   * 同时支持后续手动 upsert 映射。
   * 第一页就失败时返回 400 + 固定文案（此前静默返回空数组，后台只会显示「发现 0 个分类」）；
   * 后续页失败则保留已发现的分类。
   */
  async discoverSourceCategories(id: string) {
    const source = await this.findOne(id);
    const seen = new Map<string, { id: string; name: string }>();

    // 拉前 3 页用于发现分类（多了浪费请求，少了可能漏）
    for (let p = 1; p <= 3; p++) {
      try {
        const res = await fetchMacCmsList(source, { page: p });
        for (const item of res.list || []) {
          const tid = String(item?.type_id ?? '');
          if (!tid || tid.length > SOURCE_CATEGORY_ID_MAX) continue;
          if (!seen.has(tid)) {
            const name = String(item.type_name || `分类${tid}`).slice(0, SOURCE_CATEGORY_NAME_MAX);
            seen.set(tid, { id: tid, name });
          }
        }
        if (p >= (res.pagecount || 1)) break;
      } catch (e) {
        this.logger.warn(`探查采集源 ${id} 第 ${p} 页失败：${collectErrorLogDetail(e)}`);
        if (p === 1) throw new BadRequestException(collectErrorMessage(e));
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

  /**
   * 按（采集源, 源分类 ID）新增或更新一条映射。sourceCategoryId 缺失时 400：TypeORM 会忽略 where 里值为 undefined 的
   * 条件，findOne({ where: { sourceId, sourceCategoryId: undefined } }) 命中的是该源的第一条映射 —— 此前
   * POST /collect/sources/:id/mappings/batch {items:[[]]} 返回 201，实际把那条映射的本地分类清成了 null。
   */
  async upsertMapping(
    sourceId: string,
    dto: UpsertCategoryMappingDto,
    userId: string,
  ) {
    assertMappingItem(dto);
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
      // 记落库后的值，而不是请求体原文（interface DTO 不挡多余字段）
      newValues: {
        sourceId,
        sourceCategoryId: saved.sourceCategoryId,
        sourceCategoryName: saved.sourceCategoryName,
        localCategoryId: saved.localCategoryId,
        enabled: saved.enabled,
      },
    });
    return saved;
  }

  async batchUpsertMappings(
    sourceId: string,
    items: UpsertCategoryMappingDto[],
    userId: string,
  ) {
    // 先整体检查，再逐条写：不会出现前几条已写入、后面一条 400 的半截保存
    const list = assertPlainObjects(items, 'items');
    list.forEach(assertMappingItem);
    const results = [];
    for (const it of list) {
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
