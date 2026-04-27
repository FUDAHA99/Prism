import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-20 text-center">
      <h1 className="text-7xl font-bold text-brand-600 mb-4">404</h1>
      <p className="text-xl text-gray-700 mb-2">页面没有找到</p>
      <p className="text-sm text-gray-500 mb-8">
        你访问的内容可能已被删除、未发布或链接错误。
      </p>
      <Link
        href="/"
        className="inline-block px-5 py-2.5 bg-brand-600 text-white text-sm rounded hover:bg-brand-700"
      >
        ← 返回首页
      </Link>
    </div>
  )
}
