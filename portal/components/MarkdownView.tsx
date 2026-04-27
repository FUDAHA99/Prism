import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export default function MarkdownView({ source }: { source: string }) {
  return (
    <div className="prose prose-slate max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
