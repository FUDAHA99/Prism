import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PortalCacheConfig } from '../../config/portal-cache';

export type PortalCacheTag = 'portal:contents' | 'portal:movies' | 'portal:novels' | 'portal:comics';

@Injectable()
export class PortalCacheService {
  private readonly logger = new Logger(PortalCacheService.name);
  private readonly config: PortalCacheConfig | undefined;

  constructor(configService: ConfigService) {
    this.config = configService.get<PortalCacheConfig>('app.portalCache');
  }

  /** 只在业务写入提交后调用；门户不可用时保留已成功的写入，由既有 TTL 兜底。 */
  async invalidate(tags: readonly PortalCacheTag[]): Promise<void> {
    if (!this.config || tags.length === 0) return;
    const signal = AbortSignal.timeout(1000);
    try {
      const response = await fetch(`${this.config.url}/api/revalidate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: [...new Set(tags)] }),
        redirect: 'error',
        signal,
      });
      await response.body?.cancel();
      if (!response.ok) this.logger.warn(`门户缓存失效通知失败 category=http status=${response.status}`);
    } catch {
      const category = signal.aborted ? 'timeout' : 'network';
      // 不记录原始异常、URL、请求头或响应体，避免凭据出现在日志中。
      this.logger.warn(`门户缓存失效通知失败 category=${category}`);
    }
  }
}
