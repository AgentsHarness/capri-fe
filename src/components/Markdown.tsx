import { memo, useEffect, useMemo, useRef, isValidElement, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import type { Mermaid } from 'mermaid'
import { useThemeStore } from '../store/theme'
import { remarkMathPlugin, normalizeMathDelimiters } from './latexMath'

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
    // 源/主题变了先回到 rendering：否则 status 仍是上一次的 ready，
    // 新图渲染完成前一直显示**上一张图**（且不显示 rendering 提示）。
    setStatus({ kind: 'rendering' })
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
  /** 流式输出中:纯文本渲染(零解析),收口后分块渐进格式化。 */
  streaming?: boolean
}

/** 收口后开始格式化的延迟毫秒数(让"完成"先呈现,解析落在空闲帧)。 */
const MARKDOWN_SETTLE_DELAY_MS = 60
/** 渐进格式化的单块最大字符数(每帧只渲染一块,单帧成本有界)。 */
const SETTLE_CHUNK_MAX_CHARS = 2048
/** requestIdleCallback 单次最长等待(保证忙碌主线程上仍能推进 settle)。 */
const SETTLE_IDLE_TIMEOUT_MS = 200

/**
 * Schedule work on an idle frame when available; fall back to rAF.
 * Returns a cancel function (idle id / raf id).
 */
function scheduleIdle(cb: () => void, timeout = SETTLE_IDLE_TIMEOUT_MS): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(cb, { timeout })
    return () => w.cancelIdleCallback?.(id)
  }
  const raf = requestAnimationFrame(cb)
  return () => cancelAnimationFrame(raf)
}

/**
 * 把 settle 后的全文按结构完整的位置切成 ≤SETTLE_CHUNK_MAX_CHARS 的
 * 片段:代码围栏内部、表格/引用/列表连段内部不切,切点只在结构闭合处
 * 的空行——保证每个片段自身是完整 markdown,渐进渲染时不会出现半截
 * 结构(未闭合的围栏/表格会退回纯文本,视觉跳动)。
 */
function splitSettleChunks(source: string): string[] {
  const lines = source.split('\n')
  const chunks: string[] = []
  let cur: string[] = []
  let curLen = 0
  let inFence = false
  let prevSig = '' // 上一非空行(判断空行是否为结构边界)
  const flush = () => {
    if (cur.length === 0) return
    chunks.push(cur.join('\n'))
    cur = []
    curLen = 0
  }
  const structureLine = (line: string) =>
    /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/.test(line) || // 列表项
    /^[ \t]*\|/.test(line) || // 表格行
    /^[ \t]*>/.test(line) // 引用行
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^[ \t]*(?:```|~~~)/.test(line)) inFence = !inFence
    cur.push(line)
    curLen += line.length + 1
    if (trimmed === '') {
      // 空行:块够大且前后都不是跨空行结构时作为切分点
      if (
        curLen >= SETTLE_CHUNK_MAX_CHARS * 0.8 &&
        !inFence &&
        prevSig !== '' &&
        !structureLine(prevSig)
      ) {
        flush()
      }
      prevSig = ''
      continue
    }
    prevSig = trimmed
    // 超长且当前行不是表格/引用/列表行:就地切(下一行起新块)
    if (
      curLen >= SETTLE_CHUNK_MAX_CHARS &&
      !inFence &&
      !structureLine(line)
    ) {
      flush()
    }
  }
  flush()
  return chunks
}

/**
 * 单块 markdown 渲染(mermaid 检测/数学归一化/代码高亮全管线)。
 * memo:source 不变即不重渲染——渐进渲染时已渲染的块原样复用。
 */
const MarkdownBody = memo(function MarkdownBody({
  source,
  className = '',
}: {
  source: string
  className?: string
}) {
  // Delimiter normalization runs on the RAW source (before markdown
  // parsing) so `\(…\)` / `\[…\]` / `$$…$$` reach the parser in canonical
  // `$` form and their interior backslashes survive CommonMark escapes.
  // Mermaid detection keeps using the raw source — the normalizer copies
  // fenced/inline code verbatim, so both views agree.
  const normalized = normalizeMathDelimiters(source)
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
        remarkPlugins={[remarkGfm, remarkMathPlugin]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
})

/**
 * 渐进格式化:settle 后按块逐帧渲染(settleBatch 每帧 +1),把"一次性
 * 全量解析 9000 字符 + 代码高亮 + DOM 构建"的长时间阻塞摊平成每帧
 * 一块的小更新(手机上总耗时不变,但单帧成本有界、主线程持续可响应)。
 *
 * 钉底纪律:本组件在格式化期间/完成后**绝不**滚动——读 scrollHeight 会
 * 让浏览器同步布局整个滚动容器(500 行历史在低端机上 200-500ms/次)。
 * 滚动到底由 Scrollback 的自动跟随在**收口事件**时完成:streaming 变
 * false 触发 store 更新 → 自动跟随 effect 执行 box.scrollTop = 
 * scrollHeight——此刻内容仍是纯文本、DOM 未变、布局干净,读是 O(1),
 * 滚动零成本。格式化(渐进)期间与完成后都不再滚动。
 */
function SettleBody({
  source,
  className = '',
}: {
  source: string
  className?: string
}) {
  const chunks = useMemo(() => splitSettleChunks(source), [source])
  const [batch, setBatch] = useState(1)
  useEffect(() => {
    if (batch >= chunks.length) return
    // Prefer idle slots so settle formatting yields to input/scroll;
    // rAF fallback keeps per-chunk ~2KB progression on browsers without ric.
    return scheduleIdle(() => {
      setBatch((b) => Math.min(b + 1, chunks.length))
    })
  }, [batch, chunks.length])

  return (
    <div className={`gn-md ${className}`}>
      {chunks.slice(0, batch).map((c, i) => (
        <MarkdownBody key={i} source={c} />
      ))}
    </div>
  )
}

/**
 * Memoized: during streaming only the active entry's `source` changes, so
 * unchanged assistant messages skip the (expensive) markdown re-parse on
 * every chunk. `code`/`pre` are built per render because mermaid detection
 * needs the current raw source; rehype-highlight runs offline (highlight.js
 * core) with `ignoreMissing` so ```mermaid and unknown languages pass
 * through untouched during streaming.
 *
 * Math: remarkMathPlugin converts `$…$` / `$$…$$` / `\(…\)` / `\[…\]` spans
 * in text nodes (never inside code) to Unicode approximations — TUI
 * latex_to_unicode parity. Unclosed delimiters stay literal until closed
 * (same "closed-only" rule as mermaid), so streaming tails render as plain
 * text until the closing delimiter arrives.
 *
 * Cost model: while `streaming` the body is plain pre-wrap text — the full
 * markdown pipeline (parse + highlight.js per code block + React tree
 * rebuild + layout) is simply not run per frame, which is what makes long
 * replies stutter on mobile even with a tail window. After the stream
 * settles, the formatted render happens in chunks (one ~2KB block per
 * frame via SettleBody), so the one-time full-format cost is spread over
 * several frames instead of one multi-second main-thread stall.
 */
export const Markdown = memo(function Markdown({ source, className = '', streaming = false }: Props) {
  // 收口延迟一拍再开始格式化:流式期间零解析;流结束后 60ms + idle 起分块
  // 渐进格式化。静态实例(查看器/弹窗,从未 streaming)不经过 settle——
  // 直接全文格式化。不在 settle 期间滚动(由 Scrollback 收口时 pin)。
  const wasStreaming = useRef(false)
  const [settledSource, setSettledSource] = useState<string | null>(null)
  useEffect(() => {
    if (streaming) {
      wasStreaming.current = true
      return
    }
    if (!wasStreaming.current) return
    let cancelIdle: (() => void) | undefined
    const t = window.setTimeout(() => {
      // Kick settle on an idle frame after the short delay so "complete"
      // paints first; cancel both timeout and idle on unmount / re-stream.
      cancelIdle = scheduleIdle(() => setSettledSource(source))
    }, MARKDOWN_SETTLE_DELAY_MS)
    return () => {
      window.clearTimeout(t)
      cancelIdle?.()
    }
  }, [streaming, source])

  // 流式期间(以及收口后的 settle 等待期):纯文本直出——每帧只有一个
  // 文本节点更新,没有 markdown 解析/代码高亮/DOM 重建/布局级联。
  if (streaming || (wasStreaming.current && settledSource == null)) {
    return (
      <div className={`gn-md ${className}`}>
        <div className="whitespace-pre-wrap break-words">{source}</div>
      </div>
    )
  }
  if (wasStreaming.current) {
    // 经历过流式:分块渐进格式化(每帧一块,单帧成本有界)。
    return <SettleBody source={settledSource ?? source} className={className} />
  }
  // 静态实例(查看器/弹窗/历史回放):直接全量格式化。
  return <MarkdownBody source={source} className={className} />
})
