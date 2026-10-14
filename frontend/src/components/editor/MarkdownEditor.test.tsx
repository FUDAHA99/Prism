import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MarkdownEditor from './MarkdownEditor'

// 渲染真实编辑器及其插件链，避免只测试净化库却漏掉组件未接入的回归。
function preview(value: string) {
  return renderToStaticMarkup(<MarkdownEditor preview="preview" value={value} />)
}

describe('MarkdownEditor preview', () => {
  it.each([
    ['iframe srcdoc', '<iframe srcdoc="<script>parent.__markdownXss = true</script>"></iframe>', /<iframe\b/i],
    ['iframe URL', '<iframe src="javascript:alert(1)"></iframe>', /<iframe\b/i],
    ['script', '<script>alert(1)</script>', /<script\b/i],
    ['object', '<object data="data:text/html,<script>alert(1)</script>"></object>', /<object\b/i],
    ['SVG', '<svg onload="alert(1)"><a href="javascript:alert(1)">bad</a></svg>', /<svg\b[^>]*onload|<a\b[^>]*href="javascript:/i],
    ['image handler', '<img src="/missing.png" onerror="alert(1)">', /<img\b[^>]*onerror/i],
    ['Markdown URL', '[bad](javascript:alert%281%29)', /<a\b[^>]*href="javascript:/i],
    ['HTML URL', '<a href="jav&#x61;script:alert(1)">bad</a>', /<a\b[^>]*href="javascript:/i],
    ['data URL', '<a href="data:text/html,test">bad</a>', /<a\b[^>]*href="data:/i],
    ['attribute comment', '[bad](https://example.com)<!--rehype:href=javascript:alert(1)-->', /<a\b[^>]*href="javascript:/i],
    ['inline style', '<div style="position:fixed;inset:0">overlay</div>', /<div\b[^>]*style="[^"]*position:\s*fixed/i],
  ])('removes unsafe %s', (_name, markdown, forbidden) => {
    expect(preview(markdown as string)).not.toMatch(forbidden as RegExp)
  })

  it('prefixes user-controlled IDs to prevent DOM clobbering', () => {
    const html = preview('<h2 id="location">标题</h2>')
    expect(html).toContain('id="user-content-location"')
    expect(html).not.toMatch(/<h2\b[^>]*id="location"/)
  })

  it('preserves normal Markdown, safe HTML and syntax highlighting', () => {
    const html = preview([
      '# 标题',
      '**强调** 与 *斜体*',
      '- 列表项',
      '| 列名 |\n| --- |\n| 表格内容 |',
      '[安全链接](https://example.com/docs)',
      '![封面](https://example.com/cover.png)',
      '<strong>安全 HTML</strong>',
      '```js\nconst answer = 42\n```',
    ].join('\n\n'))
    expect(html).toMatch(/<h1\b[^>]*>.*标题<\/h1>/)
    expect(html).toContain('<strong>强调</strong>')
    expect(html).toContain('<em>斜体</em>')
    expect(html).toContain('<li>列表项</li>')
    expect(html).toContain('<td>表格内容</td>')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('src="https://example.com/cover.png"')
    expect(html).toContain('<strong>安全 HTML</strong>')
    expect(html).toContain('class="token keyword">const</span>')
  })
})
