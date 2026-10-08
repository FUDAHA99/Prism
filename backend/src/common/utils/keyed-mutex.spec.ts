import { KeyedMutex } from './keyed-mutex';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('KeyedMutex', () => {
  it('同一个 key 的临界区串行执行：读-改-写不丢更新', async () => {
    const mutex = new KeyedMutex();
    let counter = 0;
    const incrementSlowly = () =>
      mutex.run('k', async () => {
        const seen = counter;
        await tick();
        counter = seen + 1;
      });
    await Promise.all(Array.from({ length: 20 }, incrementSlowly));
    expect(counter).toBe(20);
  });

  it('不加锁时同样的写法会丢更新（证明上一条测试有效）', async () => {
    let counter = 0;
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const seen = counter;
        await tick();
        counter = seen + 1;
      }),
    );
    expect(counter).toBeLessThan(20);
  });

  it('不同 key 互不阻塞', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let releaseA!: () => void;
    const a = mutex.run('a', () => new Promise<void>((resolve) => (releaseA = resolve)).then(() => order.push('a') as any));
    const b = mutex.run('b', async () => {
      order.push('b');
    });
    await b;
    expect(order).toEqual(['b']);
    releaseA();
    await a;
    expect(order).toEqual(['b', 'a']);
  });

  it('任务抛错时释放锁并把错误抛给调用方，后续任务照常执行', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(mutex.run('k', async () => 42)).resolves.toBe(42);
  });

  it('没有等待者的 key 立即清理，不随 key 数量增长', async () => {
    const mutex = new KeyedMutex();
    await Promise.all(Array.from({ length: 50 }, (_, i) => mutex.run(`k${i % 5}`, async () => tick())));
    expect(mutex.pendingKeys).toBe(0);
  });
});
