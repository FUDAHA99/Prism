/**
 * 公开注册开关（批次 1-F-3）：站点配置 enable_register，后台「系统配置 → 功能设置 → 允许注册」读写同一个键。
 *
 * 此前这个开关只存在于配置表里，后端从未读取：POST /auth/register 对所有人开放，注册即得 JWT。
 * 产品上没有注册的消费方（门户没有登录 / 注册界面，后台账号由管理员在「用户管理」里新建），所以默认关闭：
 * 只有值恰好是 'true' 才开放（后台保存的值只会是 'true' / 'false'）；没有这一行、值为 NULL、空串或任何其他写法
 * （'TRUE'、'1'、'yes'……）一律按关闭处理 —— 拿不准就关。新装的默认值见 SiteSettingService 的 DEFAULT_SETTINGS。
 *
 * 关闭注册不是后台接口的安全前提：所有后台接口照样按角色鉴权（纵深防御），开着注册也拿不到任何后台权限。
 */
export const REGISTER_SETTING_KEY = 'enable_register';

/** 注册关闭时 POST /auth/register 的 403 文案 */
export const REGISTRATION_CLOSED_MESSAGE = '暂未开放注册';

export function registrationOpenFrom(values: ReadonlyMap<string, string | null>): boolean {
  return values.get(REGISTER_SETTING_KEY) === 'true';
}
