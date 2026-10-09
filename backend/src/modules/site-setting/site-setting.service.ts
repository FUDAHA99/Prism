import { BadRequestException, Injectable, OnModuleInit, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SiteSetting } from './entities/site-setting.entity';
import { assertPlainObjects } from '../../common/utils/plain-object';

interface DefaultSetting {
  key: string;
  value: string;
  group: string;
  description: string;
}

const DEFAULT_SETTINGS: DefaultSetting[] = [
  { key: 'site_name', value: 'CMS管理系统', group: 'general', description: '站点名称' },
  { key: 'site_description', value: '', group: 'general', description: '站点描述' },
  { key: 'site_keywords', value: '', group: 'seo', description: '站点关键词' },
  { key: 'site_icp', value: '', group: 'general', description: 'ICP备案号' },
  { key: 'site_logo', value: '', group: 'general', description: '站点Logo' },
  { key: 'site_favicon', value: '', group: 'general', description: '站点Favicon' },
  // 默认关闭公开注册（1-F-3，后端在 POST /auth/register 执行，见 auth/registration-policy.ts）。
  // initDefaults 只补库里没有的键，已有安装里这一行的值不受影响（升级须知见 docs/deploy.md）
  { key: 'enable_register', value: 'false', group: 'security', description: '是否开放注册' },
  { key: 'enable_comment', value: 'true', group: 'general', description: '是否开启评论' },
  { key: 'comment_audit', value: 'true', group: 'general', description: '评论是否需要审核' },
  { key: 'posts_per_page', value: '20', group: 'general', description: '每页文章数' },
];

@Injectable()
export class SiteSettingService implements OnModuleInit {
  constructor(
    @InjectRepository(SiteSetting)
    private readonly siteSettingRepository: Repository<SiteSetting>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initDefaults();
  }

  async initDefaults(): Promise<void> {
    for (const setting of DEFAULT_SETTINGS) {
      const existing = await this.siteSettingRepository.findOne({
        where: { key: setting.key },
      });
      if (!existing) {
        await this.siteSettingRepository.save(
          this.siteSettingRepository.create(setting),
        );
      }
    }
  }

  /**
   * 公共接口：返回前台需要的安全配置（仅白名单字段）
   */
  async findPublic(): Promise<Pick<SiteSetting, 'key' | 'value' | 'group'>[]> {
    const PUBLIC_KEYS = [
      'site_name',
      'site_description',
      'site_keywords',
      'site_logo',
      'site_favicon',
      'site_icp',
      'enable_comment',
      'comment_audit',
      'posts_per_page',
    ];
    const all = await this.siteSettingRepository.find();
    return all
      .filter((s) => PUBLIC_KEYS.includes(s.key))
      .map((s) => ({ key: s.key, value: s.value, group: s.group }));
  }

  /**
   * 按 key 取原始值，只查这几行（服务端执行配置时用，例如评论开关）。
   * 库里没有的 key 不出现在结果里；值为 NULL 的 key 映射为 null。调用方自己决定缺省值。
   */
  async findValues(keys: readonly string[]): Promise<Map<string, string | null>> {
    if (keys.length === 0) return new Map();
    const rows = await this.siteSettingRepository.find({
      select: { key: true, value: true },
      where: { key: In([...keys]) },
    });
    return new Map(rows.map((row) => [row.key, row.value ?? null]));
  }

  async findAll(): Promise<SiteSetting[]> {
    return this.siteSettingRepository.find({
      order: { group: 'ASC', key: 'ASC' },
    });
  }

  async findByKey(key: string): Promise<SiteSetting> {
    const setting = await this.siteSettingRepository.findOne({ where: { key } });
    if (!setting) {
      throw new NotFoundException(`配置项不存在: ${key}`);
    }
    return setting;
  }

  /**
   * 按 key 写一项配置（有则改值，无则新建）。key 缺失时 400：TypeORM 会忽略 where 里值为 undefined 的条件，
   * findOne({ where: { key: undefined } }) 命中的是表里第一行 —— 此前 POST /site-settings/batch {settings:[[]]}
   * 返回 200，实际把第一项配置（site_name）的值清空了。
   */
  async upsert(key: string, value: string): Promise<SiteSetting> {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new BadRequestException('配置项的 key 不能为空');
    }
    const existing = await this.siteSettingRepository.findOne({ where: { key } });
    if (existing) {
      await this.siteSettingRepository.update(existing.id, { value });
      return this.findByKey(key);
    }

    const setting = this.siteSettingRepository.create({ key, value });
    return this.siteSettingRepository.save(setting);
  }

  /** 批量保存：先确认每一项都是对象、都有 key，再逐项写 —— 不会出现前几项已写入、后面一项 400 的半截保存 */
  async batchUpsert(settings: Array<{ key: string; value?: string }>): Promise<void> {
    const items = assertPlainObjects(settings, 'settings');
    for (const item of items) {
      if (typeof item.key !== 'string' || item.key.trim() === '') {
        throw new BadRequestException('配置项的 key 不能为空');
      }
    }
    for (const { key, value } of items) {
      await this.upsert(key, value ?? '');
    }
  }
}
