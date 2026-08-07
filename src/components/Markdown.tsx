import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-3 mb-1.5 text-[1.15em] font-bold text-gn-teal first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-1.5 text-[1.08em] font-bold text-gn-blue first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2.5 mb-1 text-[1.02em] font-bold text-gn-purple first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 font-bold text-gn-gray first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-2 mb-1 font-bold text-gn-muted first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-2 mb-1 text-gn-gray-dim first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-gn-link underline decoration-gn-link/40 underline-offset-2 hover:decoration-gn-link"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-bold text-gn-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 marker:text-gn-muted">{children}</ul>,
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal pl-5 marker:text-gn-muted">{children}</ol>
  ),
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-gn-muted/50 pl-3 text-gn-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-gn-prompt-border" />,
  code: ({ className, children }) => {
    const isBlock = typeof className === 'string' && className.includes('language-')
    if (isBlock) {
      return <code className={`${className ?? ''} text-gn-fg2`}>{children}</code>
    }
    return (
      <code className="rounded bg-gn-bg-code px-1 py-0.5 font-ui text-[12.5px] text-gn-teal">
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded bg-gn-bg-code px-2.5 py-2 font-ui text-[12.5px] leading-snug text-gn-fg2">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-gn-prompt-border bg-gn-bg-highlight px-2 py-1 text-left font-bold text-gn-blue">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-gn-prompt-border px-2 py-1 text-gn-fg2">{children}</td>
  ),
}

type Props = {
  source: string
  className?: string
}

/**
 * Memoized: during streaming only the active entry's `source` changes, so
 * unchanged assistant messages skip the (expensive) markdown re-parse on
 * every chunk.
 */
export const Markdown = memo(function Markdown({ source, className = '' }: Props) {
  return (
    <div className={`gn-md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
})
