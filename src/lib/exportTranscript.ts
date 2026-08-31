/**
 * 导出当前会话 transcript 为 Markdown（/export）。
 *
 * TUI 对齐目标：xai-grok-pager `scrollback/export.rs`
 * `render_blocks_to_markdown` — 输出 `## User` / `## Assistant` /
 * `## Tools` 三段结构，工具调用渲染为一行摘要，Thinking / System /
 * SessionEvent / BgTask / Subagent / Btw / CreditLimit 等非对话 chrome
 * 一律跳过，连续 assistant 消息合并到同一个 `## Assistant` 标题下。
 *
 * 与 TUI 的有意差异（Web 端取舍，见任务简报）：
 * - 无时间戳（TUI 导出本身不带时间戳，尽管 FE 屏幕有 ts 字段）；
 * - 会话元信息（title/sessionId/cwd/model）渲染为 HTML 注释头，raw
 *   文本可溯源、Markdown 渲染不可见；
 * - 未加载历史提示行：FE 历史是分页加载的，未上翻的旧轮次不在
 *   entries 里，导出只覆盖已加载部分并如实标注。
 */
import type { ScrollEntry } from '../api/types'
import { mergeLiveText } from '../scrollback/liveText'
import { extractToolDetail } from '../scrollback/toolDetail'
import { toolHeaderExtra } from '../scrollback/toolHeaderExtra'
import { toolHeader } from '../theme/glyphs'

/** 会话元信息（从 chat store 取；全部可选）。 */
export type ExportMeta = {
  sessionId?: string
  /** Active session workspace dir. */
  cwd?: string
  /** Session title (top prompt border caption). */
  title?: string
  /** Current model label for prompt info line. */
  modelName?: string
  /**
   * 已加载区最老绝对行号（store historyLoadedStart）。undefined = 从未
   * 回放历史（纯 live 会话，entries 即全量）。
   */
  historyLoadedStart?: number
  /** 宿主确认还有更早历史可加载（store historyHasMore）。 */
  historyHasMore?: boolean
}

/** 流式缓冲（store liveStream）：与条目同 id 时文本并入该条。 */
export type ExportLiveStream = { entryId: string; text: string } | null

/**
 * 是否可能还有未加载的更早历史：FE 历史分页加载（loadHistory 首页只拉
 * 最后 1 轮，更早的轮次要上滑 loadMoreHistory 才会进 entries）。
 */
export function likelyOlderHistory(meta: ExportMeta | undefined): boolean {
  if (!meta) return false
  if (meta.historyHasMore === true) return true
  return typeof meta.historyLoadedStart === 'number' && meta.historyLoadedStart > 0
}

/** 未加载历史提示（放文档末尾，不静默给出看起来完整其实被截断的文件）。 */
const OLDER_HISTORY_NOTE =
  '\n\n---\n\n*注：本次导出仅包含已加载的对话内容；会话中更早的历史尚未加载（在滚动区向上滚动加载后可再次导出补全）。*\n'

/**
 * 组装 Markdown transcript。纯函数、不碰 DOM。
 * 空内容（无 user/assistant/tool 行）返回 ''。
 */
export function renderTranscript(
  entries: ScrollEntry[],
  meta?: ExportMeta,
  liveStream?: ExportLiveStream,
): string {
  const body = renderBlocks(entries, liveStream).trimEnd()
  if (!body) return ''
  const head = metaHead(meta)
  const note = likelyOlderHistory(meta) ? OLDER_HISTORY_NOTE : ''
  return head + body + note
}

/** 会话元信息注释头（raw 可见、渲染不可见）。 */
function metaHead(meta: ExportMeta | undefined): string {
  if (!meta) return ''
  const parts: string[] = []
  if (meta.title?.trim()) parts.push(meta.title.trim())
  if (meta.modelName?.trim()) parts.push(`model: ${meta.modelName.trim()}`)
  if (meta.sessionId?.trim()) parts.push(meta.sessionId.trim())
  if (meta.cwd?.trim()) parts.push(`cwd: ${meta.cwd.trim()}`)
  if (!parts.length) return ''
  return `<!-- transcript ${parts.join(' · ')} -->\n\n`
}

/**
 * TUI render_blocks_to_markdown 移植：三段结构，非对话 chrome 跳过，
 * 连续 assistant 合并。tools section 在遇到下一条 user/assistant 时以
 * 空行收尾。
 */
function renderBlocks(entries: ScrollEntry[], liveStream: ExportLiveStream | undefined): string {
  let out = ''
  let lastWasAgent = false
  let inTools = false
  for (const e of entries) {
    switch (e.kind) {
      case 'user': {
        if (inTools) {
          out += '\n'
          inTools = false
        }
        out += '## User\n\n' + e.text + '\n\n'
        lastWasAgent = false
        break
      }
      case 'assistant': {
        if (!lastWasAgent) {
          if (inTools) {
            out += '\n'
            inTools = false
          }
          out += '## Assistant\n\n'
        }
        const live = liveStream?.entryId === e.id ? liveStream.text : null
        out += mergeLiveText(e.text, live) + '\n\n'
        lastWasAgent = true
        break
      }
      case 'tool': {
        if (!inTools) {
          out += '## Tools\n\n'
          inTools = true
        }
        out += toolSummaryLine(e) + '\n'
        lastWasAgent = false
        break
      }
      default:
        // TUI: Thinking / System / SessionEvent / BgTask / Subagent / Btw /
        // CreditLimit / … 全部跳过 — 非对话 chrome 不进导出。
        break
    }
  }
  return out
}

/**
 * 工具调用一行摘要（TUI tool_summary 同款，数据源与屏幕折叠行一致：
 * toolHeader + toolHeaderExtra）。被折叠/未展开的工具详情一律不导出
 * body——TUI export 本来就是 collapsed 视图，与 display mode 无关。
 * Execute 特例对齐 TUI `Execute: {command} ({description})`：command
 * 优先于 description（FE 折叠行显示 description || command，导出取
 * TUI 的字段结构）。
 */
function toolSummaryLine(e: Extract<ScrollEntry, { kind: 'tool' }>): string {
  const failed = e.status === 'failed' || e.status === 'error'
  const { verb } = toolHeader(e.kindName, false)
  const extra = e.raw
    ? toolHeaderExtra(e.raw, e.kindName, failed, e.mergedRaws, { status: e.status })
    : null
  // TUI export for a subagent message row is the bare sentence itself
  // (`SentMessagePresentation::title()`), with no `Verb: ` prefix.
  if (extra?.bare) return `- ${extra.bare}`
  let target = extra?.target ?? e.title ?? ''
  let suffix = extra?.suffix
  const detail = e.raw ? extractToolDetail(e.raw, e.kindName) : null
  if (detail?.kind === 'execute') {
    if (detail.command && detail.command !== target) {
      target = detail.command
      suffix =
        detail.description && detail.description !== detail.command
          ? ` (${detail.description})${suffix ?? ''}`
          : suffix
    }
  }
  return `- ${verb}: ${target}${suffix ?? ''}`
}

/**
 * 浏览器下载文件名安全化（Web 端替代 TUI 的服务端路径写入）：
 * - 剥掉前导 `~/`（TUI 的 shellexpand::tilde 在浏览器没有文件系统可展开）；
 * - 路径分隔符（/ \）与 ASCII 控制字符在文件名里非法 → `_`（下载只有
 *   文件名，没有目录层级，路径语义全部拍平）；
 * - 目录穿越段 `..` 拍平；
 * - 空名 / `.` / `..` 兜底为 `transcript`；
 * - 缺 `.md` 后缀补上（不替换已有扩展名）。
 */
export function safeExportFilename(raw: string): string {
  let name = raw.trim()
  name = name.replace(/^~[\\/]*/, '')
  name = name.replace(/[\\/]/g, '_')
  // 控制字符按码点过滤（oxlint no-control-regex 不允许控制字符字符类）。
  name = [...name].map(sanitizeChar).join('')
  name = name.replace(/\.\./g, '_')
  if (!name || name === '.' || name === '_') name = 'transcript'
  if (!/\.md$/i.test(name)) name += '.md'
  return name
}

function sanitizeChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0
  return cp < 0x20 || cp === 0x7f ? '_' : ch
}