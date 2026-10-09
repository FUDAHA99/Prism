/**
 * 「现在」的来源。公开视图判断定时发布是否已到点、服务端替内容填发布时间时都从这里取当前时间；
 * 测试注入假时钟（`{ provide: Clock, useValue: ... }`），不用 jest 假定时器去拨全局时间。
 *
 * 服务以 `@Optional()` 注入、缺省用 SYSTEM_CLOCK：生产环境不需要在任何模块里注册它，
 * 手工 new 出来的服务（单测）也照常可用。
 */
export abstract class Clock {
  abstract now(): Date;
}

class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export const SYSTEM_CLOCK: Clock = new SystemClock();

/**
 * 截到整秒（向下取整）。服务端替内容填「发布时间 = 现在」时用它：生产库的 DATETIME 列没有小数秒，
 * MySQL 写入时对毫秒四舍五入 —— 12:00:00.600 会存成 12:00:01，刚发布的内容在这半秒里会被
 * 「publishedAt <= now」判成还没到点。向下取整后存进去的时间永远不晚于真实时间。
 */
export function wholeSecond(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}
