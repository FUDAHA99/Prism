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

/**
 * 启动时读到注册开着时打的一行 WARN（SiteSettingService.onModuleInit）。旧版本写入的默认值是 'true'，
 * initDefaults 只补缺失的键：从旧版本升级上来的安装，公开注册在升级后仍然开着，直到管理员手工关掉。
 * 只提醒、从不自动改值（零 migration；开着注册也可能是站点有意为之）。scripts/deploy.sh 例行部署时另有同样的提示。
 */
export const REGISTRATION_OPEN_STARTUP_WARNING =
  "公开注册已开启（site_settings.enable_register = 'true'），任何人都能自助注册账号；" +
  '不需要时在管理后台「系统配置 → 功能设置」关闭「允许注册」并保存，立即生效，无需重启（见 docs/deploy.md 5.3 ⑥）';

export function registrationOpenFrom(values: ReadonlyMap<string, string | null>): boolean {
  return values.get(REGISTER_SETTING_KEY) === 'true';
}
