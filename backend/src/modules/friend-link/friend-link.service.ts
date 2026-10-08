import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FriendLink } from './entities/friend-link.entity';
import { CreateFriendLinkDto, FRIEND_LINK_URL_PATTERN } from './dto/create-friend-link.dto';
import { UpdateFriendLinkDto } from './dto/update-friend-link.dto';
import { isAdmin, Viewer } from '../../common/authz/viewer';

/** 非管理员看到的友链：只有展示需要的字段，不含显示开关、排序值与时间戳 */
export interface PublicFriendLink {
  id: string;
  name: string;
  url: string;
  logo: string | null;
  description: string | null;
}

type FriendLinkPatch = Partial<Pick<FriendLink, 'name' | 'url' | 'logo' | 'description' | 'sortOrder' | 'isVisible'>>;

/** 列表排序：排序值升序、新建的在前，id 兜底保证同值时顺序稳定 */
const LIST_ORDER = { sortOrder: 'ASC', createdAt: 'DESC', id: 'ASC' } as const;

@Injectable()
export class FriendLinkService {
  constructor(
    @InjectRepository(FriendLink)
    private readonly friendLinkRepository: Repository<FriendLink>,
  ) {}

  /**
   * GET /friend-links（可选登录）由后台友链页与公开读共用：
   * - 管理员（友链由 admin 管理）：全部友链、完整字段，与此前一致；
   * - 其他人（游客、无角色用户、editor）：只有「显示」的友链，按 PublicFriendLink 白名单出参；
   *   地址不是 http(s) 的历史数据（接口此前不限协议）一并略过，不交给任何前台去渲染成链接。
   */
  async findAll(viewer?: Viewer): Promise<FriendLink[] | PublicFriendLink[]> {
    if (isAdmin(viewer)) {
      return this.friendLinkRepository.find({ order: LIST_ORDER });
    }
    const rows = await this.friendLinkRepository.find({
      select: { id: true, name: true, url: true, logo: true, description: true },
      where: { isVisible: true },
      order: LIST_ORDER,
    });
    return rows
      .filter((row) => FRIEND_LINK_URL_PATTERN.test(row.url))
      .map((row) => ({
        id: row.id,
        name: row.name,
        url: row.url,
        logo: row.logo ?? null,
        description: row.description ?? null,
      }));
  }

  async findOne(id: string): Promise<FriendLink> {
    const link = await this.friendLinkRepository.findOne({ where: { id } });
    if (!link) {
      throw new NotFoundException(`友情链接不存在: ${id}`);
    }
    return link;
  }

  /** 逐字段写库（不展开请求体）：id / createdAt 等由库生成 */
  async create(dto: CreateFriendLinkDto): Promise<FriendLink> {
    const link = this.friendLinkRepository.create({
      name: dto.name,
      url: dto.url,
      logo: dto.logo ?? null,
      description: dto.description ?? null,
      sortOrder: dto.sortOrder ?? 0,
      isVisible: dto.isVisible ?? true,
    });
    return this.friendLinkRepository.save(link);
  }

  async update(id: string, dto: UpdateFriendLinkDto): Promise<FriendLink> {
    await this.findOne(id);
    const patch: FriendLinkPatch = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.url !== undefined) patch.url = dto.url;
    if (dto.logo !== undefined) patch.logo = dto.logo;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder ?? 0;
    if (dto.isVisible !== undefined) patch.isVisible = dto.isVisible;
    if (Object.keys(patch).length > 0) {
      await this.friendLinkRepository.update(id, patch);
    }
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.friendLinkRepository.delete(id);
  }
}
