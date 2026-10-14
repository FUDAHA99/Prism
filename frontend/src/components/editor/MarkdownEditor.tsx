import React from 'react'
import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'

interface MarkdownEditorProps {
  value?: string
  onChange?: (value: string) => void
  height?: number
  preview?: 'live' | 'edit' | 'preview'
}

export default function MarkdownEditor({
  value,
  onChange,
  height = 400,
  preview = 'live',
}: MarkdownEditorProps) {
  const handleChange = (val: string | undefined) => {
    if (onChange) {
      onChange(val ?? '')
    }
  }

  return (
    <div data-color-mode="light">
      <MDEditor
        value={value}
        onChange={handleChange}
        height={height}
        preview={preview}
        // 原始 HTML 和属性注释先由编辑器解析，再用默认白名单净化预览。
        previewOptions={{ rehypePlugins: [rehypeSanitize] }}
      />
    </div>
  )
}
