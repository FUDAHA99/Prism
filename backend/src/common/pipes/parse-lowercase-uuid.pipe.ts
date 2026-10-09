import { ArgumentMetadata, BadRequestException, Injectable, ParseUUIDPipe } from '@nestjs/common';

/**
 * 路径参数里的 ID：必须是 8-4-4-4-12 的十六进制 UUID（与 DTO 的 IsUUID('loose') 同一规则，不挑版本），并转成小写。
 *
 * 为什么要转小写：生产库是 utf8mb4_unicode_ci，`WHERE id = 'ABC…'` 与小写的行判为相等；而服务里在 JS 层比较 ID 用的是
 * `===`，区分大小写。父级成环检查就因此被绕过：用大写的自身 ID 当父级、或在路径里用大写 ID 把节点挂到自己的子节点下，
 * 数据库都认，JS 比较却认为「不是同一个」。这里统一成库里的写法（TypeORM 生成的 UUID 都是小写）。
 */
@Injectable()
export class ParseLowercaseUuidPipe extends ParseUUIDPipe {
  constructor() {
    super({ exceptionFactory: () => new BadRequestException('路径里的 id 必须是 UUID') });
  }

  async transform(value: string, metadata: ArgumentMetadata): Promise<string> {
    return (await super.transform(value, metadata)).toLowerCase();
  }
}
