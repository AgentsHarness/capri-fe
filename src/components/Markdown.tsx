import { memo, useEffect, isValidElement, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import type { Mermaid } from 'mermaid'
import { useThemeStore } from '../store/theme'

/* ------------------------------------------------------------------------
 * Mermaid diagrams — TUI parity (`◇ mermaid` + `[Open Image] [Copy Source]`,
 * `rendering diagram…` status, source fallback on failure / open fence).
 * ---------------------------------------------------------------------- */

/** Lazy mermaid module handle: only loaded when a closed ```mermaid fence
 *  actually renders, so the ~1MB library never lands in the main bundle. */
let mermaidModule: Promise<Mermaid> | null = null
function loadMermaid(): Promise<Mermaid> {
  mermaidModule ??= import('mermaid').then((m) => m.default)
  return mermaidModule
}

/** Unique per-instance render ids (mermaid rejects duplicate diagram ids). */
let diagramSeq = 0

type MermaidStatus =
  | { kind: 'rendering' }
  | { kind: 'ready'; svg: string }
  | { kind: 'error' }

/** Normalize a mermaid source for comparison (CRLF→LF, drop trailing NLs). */
function normalizeSource(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

/**
 * Bodies of *closed* ```mermaid fences in `source`, in document order.
 *
 * An unterminated fence (mid-stream tail) is never included, so streaming
 * blocks keep showing boxed source until the fence closes — the same rule as
 * the TUI's `MermaidContent` detection. Blockquote-nested fences
 * (`> ```mermaid`) are matched and de-prefixed, like the TUI's clean source.
 */
function closedMermaidBodies(source: string): Set<string> {
  const set = new Set<string>()
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const isOpen = (line: string) =>
    /^[ \t]*(?:>[ \t]*)?```[ \t]*mermaid(?:[ \t].*)?$/i.test(line)
  const isClose = (line: string) => /^[ \t]*(?:>[ \t]*)?```[ \t]*$/.test(line)
  let i = 0
  while (i < lines.length) {
    if (!isOpen(lines[i])) {
      i++
      continue
    }
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && !isClose(lines[j])) {
      body.push(lines[j].replace(/^[ \t]*>[ \t]?/, ''))
      j++
    }
    if (j < lines.length) set.add(normalizeSource(body.join('\n')))
    i = j + 1
  }
  return set
}

/** Whether a code-block className marks a mermaid fence (first info token). */
function mermaidClass(className: string): boolean {
  const info = className.split(/\s+/).find((tok) => tok.startsWith('language-'))
  if (!info) return false
  return info.slice('language-'.length).split(/\s+/)[0].toLowerCase() === 'mermaid'
}

/** Plain text of a code node's children (strings only — highlighted blocks
 *  never reach here since rehype-highlight ignores mermaid fences). */
function nodeText(children: ReactNode): string {
  if (Array.isArray(children)) {
    return children.map((c) => (typeof c === 'string' ? c : '')).join('')
  }
  return typeof children === 'string' ? children : ''
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

function canvasToPngUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('png encode failed'))
        return
      }
      resolve(URL.createObjectURL(blob))
    }, 'image/png')
  })
}

function downloadUrl(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
}

function MermaidDiagram({ source }: { source: string }) {
  const resolvedTheme = useThemeStore((s) => s.resolved)
  const mermaidTheme = resolvedTheme === 'grokday' ? 'default' : 'dark'
  const [status, setStatus] = useState<MermaidStatus>({ kind: 'rendering' })

  useEffect(() => {
    let cancelled = false
    const id = `gn-mermaid-${++diagramSeq}`
    void (async () => {
      try {
        const mermaid = await loadMermaid()
        mermaid.initialize({ startOnLoad: false, theme: mermaidTheme })
        const { svg } = await mermaid.render(id, source)
        if (!cancelled) setStatus({ kind: 'ready', svg })
      } catch {
        if (!cancelled) setStatus({ kind: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, mermaidTheme])

  // Render failure → boxed source fallback (TUI semantics for unsupported
  // diagrams): no diagram, no affordance row.
  if (status.kind === 'error') {
    return (
      <pre className="my-2 overflow-x-auto rounded bg-gn-bg-code px-2.5 py-2 font-ui text-[12.5px] leading-snug text-gn-fg2">
        <code className="language-mermaid text-gn-fg2">{source}</code>
      </pre>
    )
  }

  /** [Open Image]: rasterize the rendered SVG to a HiDPI PNG (canvas) and
   *  open it in a new tab; fall back to the raw SVG or a download. */
  const openImage = async () => {
    if (status.kind !== 'ready') return
    const svgUrl = URL.createObjectURL(
      new Blob([status.svg], { type: 'image/svg+xml;charset=utf-8' }),
    )
    try {
      const img = await loadImage(svgUrl)
      const scale = 2
      const width = Math.max(1, Math.round(img.naturalWidth * scale))
      const height = Math.max(1, Math.round(img.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d context unavailable')
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#141414'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      const pngUrl = await canvasToPngUrl(canvas)
      if (!window.open(pngUrl, '_blank')) downloadUrl(pngUrl, 'diagram.png')
      setTimeout(() => URL.revokeObjectURL(pngUrl), 60_000)
    } catch {
      // PNG pipeline failed — open the raw SVG instead.
      if (!window.open(svgUrl, '_blank')) downloadUrl(svgUrl, 'diagram.svg')
    } finally {
      setTimeout(() => URL.revokeObjectURL(svgUrl), 60_000)
    }
  }

  /** [Copy Source]: copy the diagram's mermaid source to the clipboard. */
  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source)
    } catch {
      // Legacy fallback for non-secure contexts.
      const ta = document.createElement('textarea')
      ta.value = source
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta)
    }
  }

  return (
    <div className="gn-mermaid my-2">
      {status.kind === 'ready' ? (
        <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: status.svg }} />
      ) : (
        <div className="min-h-[3.25rem] rounded border border-dashed border-gn-prompt-border bg-gn-bg-code/40" />
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-ui text-[12px]">
        <span className="text-gn-cyan">◇ mermaid</span>
        <button
          type="button"
          disabled={status.kind !== 'ready'}
          onClick={() => {
            void openImage()
          }}
          className="text-gn-blue hover:underline disabled:cursor-default disabled:opacity-40"
        >
          [Open Image]
        </button>
        <button
          type="button"
          onClick={() => {
            void copySource()
          }}
          className="text-gn-blue hover:underline"
        >
          [Copy Source]
        </button>
        {status.kind === 'rendering' && (
          <span className="text-gn-muted">rendering diagram…</span>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------
 * Markdown body
 * ---------------------------------------------------------------------- */

const baseComponents: Components = {
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
  // react-markdown renders images by default; this only adds the
  // rounded/bordered chrome so inline markdown images match the
  // conversation's image entries.
  img: ({ src, alt }) => (
    <img
      src={src}
      alt={alt || ''}
      className="my-1.5 max-w-full rounded border border-gn-prompt-border"
    />
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
 * every chunk. `code`/`pre` are built per render because mermaid detection
 * needs the current raw source; rehype-highlight runs offline (highlight.js
 * core) with `ignoreMissing` so ```mermaid and unknown languages pass
 * through untouched during streaming.
 */
export const Markdown = memo(function Markdown({ source, className = '' }: Props) {
  const closedMermaid = closedMermaidBodies(source)
  const components: Components = {
    ...baseComponents,
    code: ({ className, children }) => {
      const isBlock = typeof className === 'string' && className.includes('language-')
      if (isBlock) {
        const text = nodeText(children)
        if (mermaidClass(className) && closedMermaid.has(normalizeSource(text))) {
          return <MermaidDiagram source={text} />
        }
        return <code className={`${className} text-gn-fg2`}>{children}</code>
      }
      return (
        <code className="rounded bg-gn-bg-code px-1 py-0.5 font-ui text-[12.5px] text-gn-teal">
          {children}
        </code>
      )
    },
    pre: ({ children }) => {
      // MermaidDiagram replaces the whole code box — don't wrap it in <pre>.
      if (isValidElement(children) && children.type === MermaidDiagram) {
        return children
      }
      return (
        <pre className="my-2 overflow-x-auto rounded bg-gn-bg-code px-2.5 py-2 font-ui text-[12.5px] leading-snug text-gn-fg2">
          {children}
        </pre>
      )
    },
  }

  return (
    <div className={`gn-md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})
