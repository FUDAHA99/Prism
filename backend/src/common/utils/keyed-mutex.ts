/**
 * 按 key 串行执行的进程内互斥锁。
 *
 * 缓存层（cache-manager v7）没有原子 incr / compare-and-set，「读 → 判断 → 写」在并发下会丢更新：
 * 同一个 refresh token 并发刷新两次都能通过黑名单检查、拿到两套新 token；同一账号并发猜密码，
 * 失败计数会被互相覆盖而少记。同 key 的临界区在这里排队执行，单实例部署下即是原子的
 * （生产 compose 只有一个 backend 容器；多实例时退化为「每实例各自串行」，仍比裸读写严格）。
 *
 * 不同 key 互不阻塞；某个 key 上没有等待者时立即从 Map 移除，不随 key 数量增长。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    // current 永不 reject，排在后面的等待者只会等到前一个释放
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    try {
      await previous;
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** 当前持有或等待锁的 key 数（测试用） */
  get pendingKeys(): number {
    return this.tails.size;
  }
}
