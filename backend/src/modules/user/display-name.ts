import { TransformFnParams } from 'class-transformer';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';

/**
 * 显示名（批次 1-F-3）：门户评论里能看到的名字 —— 注册用户的昵称（没有则用户名）与游客自填的昵称。
 *
 * 规则只有一条：一个名字最多属于一个账号。游客昵称（1-F-2）、注册 / 后台新建 / 后台编辑 / 本人修改资料的昵称，
 * 以及新建 / 改名时的用户名，都不能与「其他」未删除账号的用户名或昵称相同；比较按库的排序规则
 * （生产 utf8mb4_unicode_ci：不区分大小写与重音，忽略尾随空格），在规范化之后进行。
 * 此前只有游客受这条约束，自助注册把昵称写成管理员的名字，就能顶着「注册用户」的标识在门户发评论。
 */

/**
 * NFKC（全角、兼容字符折叠成常规写法）、去掉不可见的格式 / 可忽略字符，再 trim。
 * utf8mb4_unicode_ci 并不忽略零宽字符、双向控制符、韩文填充符、盲文空格等，夹带它们的名字
 * 显示起来与已有账号一模一样，却能通过重名检查（1-F-2 复审 low）。存库的也是规范化后的值。
 */
const INVISIBLE_IN_NAMES = /[\p{Cf}\p{Default_Ignorable_Code_Point}ᅟᅠㅤﾠ⠀]/gu;

export function normalizeDisplayName(raw: string): string {
  return raw.normalize('NFKC').replace(INVISIBLE_IN_NAMES, '').trim();
}

/**
 * 库里的昵称按显示名看是什么：规范化之后的写法；null、空串、纯空白、只有不可见字符都算「没有昵称」（null）。
 * 存量数据早于规范化（1-F-3 之前），可能是全角、夹带零宽字符等非规范写法。
 */
export function storedNicknameAsDisplayName(stored: string | null | undefined): string | null {
  if (typeof stored !== 'string') return null;
  const normalized = normalizeDisplayName(stored);
  return normalized === '' ? null : normalized;
}

/**
 * 编辑提交的昵称（经 nicknameUpdateInput：已规范化的字符串，或 null 表示清空）相对库里的当前值是否真的变了。
 * 两边都按规范化后的写法比：后台编辑弹窗、旧客户端原样回传存量的非规范昵称时不算改 —— 不查重、也不写库。
 * 否则一个全角仿冒管理员昵称的存量账号，管理员连停用 / 降权都做不了（规范化后与管理员昵称相同，409），
 * 写库还会把它改成与管理员一模一样的规范写法。
 */
export function isNicknameChange(stored: string | null | undefined, submitted: string | null): boolean {
  return storedNicknameAsDisplayName(stored) !== submitted;
}

/**
 * name 是否已被某个未删除账号用作用户名或昵称（exceptUserId 指定的账号本身除外：改自己的昵称、
 * 把昵称改成自己的用户名都不算冲突）。
 *
 * 比较在 SQL 里做、用列的排序规则，不在 JS 里用 ===（那样大小写、重音一变就绕过去了）。
 * 软删除的账号由 TypeORM 自动排除（@DeleteDateColumn），它的名字可以再被使用。
 * 没有唯一索引兜底（不改表结构）：两个请求同时抢同一个新名字时都可能通过，但抢不到已经存在的名字。
 */
export async function isDisplayNameTaken(
  users: Repository<User>,
  name: string,
  exceptUserId?: string,
): Promise<boolean> {
  const query = users
    .createQueryBuilder('user')
    .select('user.id')
    .where('(user.username = :name OR user.nickname = :name)', { name });
  if (exceptUserId) {
    query.andWhere('user.id <> :exceptUserId', { exceptUserId });
  }
  return query.getExists();
}

/** 注册 / 后台新建 / 编辑 / 修改本人资料时，昵称与其他账号的用户名或昵称相同 */
export const NICKNAME_TAKEN_MESSAGE = '该昵称已被其他用户使用';

/** 新建 / 改名时，用户名与其他账号的昵称相同（用户名之间的重复另有「该用户名已被使用」） */
export const USERNAME_TAKEN_AS_NICKNAME_MESSAGE = '该用户名已被其他用户用作昵称';

/**
 * DTO 里的昵称取请求体里的原始值：全局 ValidationPipe 开了 enableImplicitConversion，不这样做的话
 * 数字、对象会先被 String() 转成 '123'、'[object Object]' 再通过 IsString（与 rawValue 处理布尔同理）。
 */
const rawNickname = ({ obj, key }: TransformFnParams): unknown => (obj as Record<string, unknown>)[key];

/**
 * DTO 用的昵称输入转换（新建：注册、POST /users）：字符串先规范化，其余原样交给校验（非字符串 400）。
 * 规范化后为空串时照常由 MinLength 拒绝（与此前一样，新建时不能提交空昵称）。
 */
export const nicknameCreateInput = (params: TransformFnParams): unknown => {
  const value = rawNickname(params);
  return typeof value === 'string' ? normalizeDisplayName(value) : value;
};

/**
 * DTO 用的昵称输入转换（编辑：PATCH /users/:id、PATCH /auth/me）：字符串先规范化，
 * 规范化后为空（含纯空白、只有不可见字符）按「清空」处理，得到 null；非字符串原样交给校验（400）。
 */
export const nicknameUpdateInput = (params: TransformFnParams): unknown => {
  const value = rawNickname(params);
  if (typeof value !== 'string') return value;
  const normalized = normalizeDisplayName(value);
  return normalized === '' ? null : normalized;
};
