import type { ScrollEntry } from '../../../api/types'
import { toolHeaderExtra } from '../../../scrollback/toolHeaderExtra'
import { toolHooksHaveContent } from '../../../scrollback/hookRuns'
import { toolDisplayMode } from '../../../scrollback/entryState'
import { Accents } from '../../../theme/accents'
import { toolHeader } from '../../../theme/glyphs'
import { ToolDetail } from '../../ToolDetail'
import { Bullet, EntryShell } from '../EntryShell'
import { LiteToolFill } from '../LiteToolFill'
import { toolEntryLitePending } from '../../../store/chat/historyFill'
import { HeaderWithView } from '../ViewButton'
import type { EntryChrome } from '../chrome'
import { ToolHookDetail, ToolHookSuffix } from './HookRuns'

export function ToolEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'tool' }>
  chrome: EntryChrome
}) {
  const {
    shell,
    bullet,
    caret,
    bulletGlyph,
    rowBtn,
    toggleTool,
    openViewer,
    fillToolBodies,
    cwd,
  } = chrome
  // TUI 三态：collapsed = 仅行头；truncated = 行内截断预览（原 expanded
  // 布尔的行内形态）；expanded = 行内全量正文（TUI Expanded）。
  const mode = toolDisplayMode(e)
  const showBody = mode !== 'collapsed'
  // lite 投影裁掉了正文、还没补回来 → 整行只显示占位（不渲染裁过的 body）。
  // 占位必须带补全坐标才显示：没有 [msgSeq, msgSeqEnd]（host 走
  // _x.ai/session/updates 透传回退时整页无 msgSeq）就没有任何可点的拉取
  // 路径，显示出来是个永远拿不回正文的死按钮。
  // 只在展开态显示：折叠卡本来就不画 body，每张都插一行提示纯属占地方；
  // 展开（toggleTool）与「查看」都会按需补全，占位到那时才有意义。
  const litePending = showBody && toolEntryLitePending(e)
  const running = e.status === 'pending' || e.status === 'in_progress'
  const failed = e.status === 'failed' || e.status === 'error'
  const { verb } = toolHeader(e.kindName, running)
  const verbColor = failed
    ? Accents.error
    : showBody
      ? 'var(--color-gn-fg)'
      : Accents.gray
  const targetColor =
    showBody && !failed ? 'var(--color-gn-path)' : Accents.gray
  const detailColor = 'var(--color-gn-muted)'

  // TUI collapsed_line / header_line: the row noun, path paint and suffix all
  // depend on which surface this is — collapsed one-liner vs inline expand.
  const headerExtra = e.raw
    ? toolHeaderExtra(e.raw, e.kindName, failed, e.mergedRaws, {
        surface: showBody ? 'expanded' : 'collapsed',
        cwd,
        status: e.status,
      })
    : null
  const displayVerb = headerExtra?.verb ?? verb
  const bare = headerExtra?.bare
  const target = bare ? '' : (headerExtra?.target ?? e.title)
  const head = bare ? '' : headerExtra?.head
  const suffix = headerExtra?.suffix
  // Folded: the hook counts ride the end of the header line (TUI appends the
  // same spans to the first collapsed line). Expanded: they show as detail
  // under the body instead, so the two forms are mutually exclusive.
  const hooks = e.hooks
  const hookSuffix = !showBody && toolHooksHaveContent(hooks) ? hooks : null

  return (
    <EntryShell {...shell}>
      <HeaderWithView
        className={rowBtn}
        title="click fold · 查看 / enter view"
        onFold={() => toggleTool(e.id)}
        viewVisible={showBody}
        onOpen={() => openViewer(e.id)}
      >
        <Bullet
          color={bullet.color}
          animated={bullet.animated && !caret}
          glyph={bulletGlyph}
        />
        {bare ? (
          // TUI SentMessageToolCallBlock: one bold sentence, no noun/target split.
          <span
            className="min-w-0 truncate font-bold"
            style={{ color: verbColor }}
          >
            {bare}
          </span>
        ) : (
          <>
            <span
              className="shrink-0 font-bold"
              style={{ color: verbColor }}
            >
              {displayVerb}
            </span>
            {headerExtra?.marker ? (
              // TUI 的 (user) 幽灵标记：直连 bash 执行的命令行。
              <span
                className="shrink-0 text-[12px]"
                style={{ color: detailColor }}
              >
                {headerExtra.marker}
              </span>
            ) : null}
            {/* 不要 flex-1：空档会把后面的 (N matches) / (+1/−1) 顶到行尾。
                min-w-0 仍让过长目录在行溢出时先被压缩。 */}
            <span className="flex min-w-0 truncate font-mono text-[12.5px] leading-[1.35]">
              {head ? (
                // 目录前缀先被压缩，末段（文件名）固定——TUI 的
                // fit-to-width 规则在浏览器里的等价实现。
                <span
                  className="min-w-0 shrink truncate"
                  style={{ color: targetColor }}
                >
                  {head}
                </span>
              ) : null}
              <span className="shrink-0" style={{ color: targetColor }}>
                {target}
              </span>
            </span>
            {suffix ? (
              // 失败后缀（如 ` (Tool ... failed: <长错误>)`）与目标列同规则：
              // min-w-0 允许收缩 + truncate 行内省略，绝不把行撑出内容列。
              <span
                className="min-w-0 truncate text-[12px] leading-[1.35]"
                style={{ color: detailColor }}
              >
                {suffix}
              </span>
            ) : null}
          </>
        )}
        {hookSuffix ? <ToolHookSuffix data={hookSuffix} /> : null}
      </HeaderWithView>
      {/* Inline expand = TUI Truncated preview; TUI Expanded = 全量正文
          （full=true，仅视口预算截断）。full body via Enter / 查看。 */}
      {litePending ? (
        // lite 裁掉的正文：占位行报出省略规模 + 按需加载（行内 spinner /
        // 失败就地重试）。补全完成后这条自动让位给下面的正文。
        <LiteToolFill
          bytes={e.liteOmitted!}
          state={e.liteState}
          onFill={fillToolBodies ? () => fillToolBodies(e.id) : undefined}
          className="pl-1"
        />
      ) : showBody && e.raw ? (
        <ToolDetail
          raw={e.raw}
          kindName={e.kindName}
          full={mode === 'expanded'}
          mergedRaws={e.mergedRaws}
          hooks={hooks}
        />
      ) : showBody && !e.raw && hooks ? (
        // A row whose only content is its hook runs still folds (TUI
        // is_foldable counts hook detail), so the expand has to render them
        // even with no tool payload on the row.
        <div className="mt-1 min-w-0 font-ui text-[12.5px] leading-[1.45]">
          <ToolHookDetail data={hooks} />
        </div>
      ) : null}
    </EntryShell>
  )
}
