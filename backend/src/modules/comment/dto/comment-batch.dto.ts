import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** 批量审核 / 标记垃圾 / 删除的上限：后台评论页每页 20 条，勾选不会跨页保留 */
export const COMMENT_BATCH_MAX = 100;

/**
 * POST /comments/batch/{approve,spam,delete} 的请求体（后台 Comment 页提交 { ids }）。
 * 此前是 @Body('ids') 取原始值：缺失时 ids.length 抛 TypeError（500），数量不限、元素类型不限。
 */
export class CommentBatchDto {
  @ApiProperty({ description: '评论 ID 列表', type: [String], maxItems: COMMENT_BATCH_MAX })
  @IsArray({ message: 'ids 必须是数组' })
  @ArrayNotEmpty({ message: 'ids 不能为空' })
  @ArrayMaxSize(COMMENT_BATCH_MAX, { message: `ids 一次最多 ${COMMENT_BATCH_MAX} 个` })
  @IsUUID('all', { each: true, message: 'ids 的每一项都必须是评论 ID' })
  ids: string[];
}
