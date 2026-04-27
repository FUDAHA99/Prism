import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FriendLink } from './entities/friend-link.entity';
import { CreateFriendLinkDto } from './dto/create-friend-link.dto';
import { UpdateFriendLinkDto } from './dto/update-friend-link.dto';

@Injectable()
export class FriendLinkService {
  constructor(
    @InjectRepository(FriendLink)
    private readonly friendLinkRepository: Repository<FriendLink>,
  ) {}

  async findAll(): Promise<FriendLink[]> {
    return this.friendLinkRepository.find({
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<FriendLink> {
    const link = await this.friendLinkRepository.findOne({ where: { id } });
    if (!link) {
      throw new NotFoundException(`友情链接不存在: ${id}`);
    }
    return link;
  }

  async create(dto: CreateFriendLinkDto): Promise<FriendLink> {
    const link = this.friendLinkRepository.create(dto);
    return this.friendLinkRepository.save(link);
  }

  async update(id: string, dto: UpdateFriendLinkDto): Promise<FriendLink> {
    await this.findOne(id);
    await this.friendLinkRepository.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.friendLinkRepository.delete(id);
  }
}
