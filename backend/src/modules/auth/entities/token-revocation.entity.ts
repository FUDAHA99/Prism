import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 认证安全状态独立持久化，不进入可淘汰的缓存。 */
@Entity('token_revocations')
export class TokenRevocation {
  @PrimaryColumn({ type: 'varchar', length: 191 })
  key: string;

  @Column({ type: 'bigint' })
  value: string;

  @Index('IDX_token_revocations_expiresAt')
  @Column({ type: 'bigint', nullable: true })
  expiresAt: string | null;
}
