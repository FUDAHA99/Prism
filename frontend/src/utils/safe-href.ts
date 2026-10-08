/**
 * 后台列表把菜单、友链的地址渲染成可点击链接（<a href>）。只有 http(s) 绝对地址与站内路径（/about；
 * 不含 //host、/\host 这类会被浏览器当成别的站点的写法）才给 href，其余一律返回 undefined、只显示文本。
 *
 * 后端写入时已经按同样的规则拒绝（menu.dto.ts / create-friend-link.dto.ts），这里防的是规则上线前已经入库的数据：
 * 菜单 url 此前不限协议，javascript: 链接在后台点一下就会执行脚本、读走 localStorage 里的 token；
 * React 18 对 javascript: 的 href 只在控制台告警，不会拦截。
 */
const SAFE_HREF_PATTERN = /^(?:https?:\/\/[^\s]+|\/(?![/\\])[^\s\\]*)$/i

export function safeHref(url: string | null | undefined): string | undefined {
  return typeof url === 'string' && SAFE_HREF_PATTERN.test(url) ? url : undefined
}
