import { useChatStore, planTodos } from '../../store/chat'
import type { ScrollEntry } from '../../api/types'
import { fmtBytes } from '../../format'
import { Accents } from '../../theme/accents'
import { TodoMark } from '../scrollback/todoMark'
import { LiteToolFill } from '../scrollback/LiteToolFill'
import { toolEntryLitePending, toolEntryNeedsFill } from '../../store/chat/historyFill'
import { ToolDetail } from '../scrollback/ToolDetail'
import { Markdown } from '../ui/Markdown'
import { ZoomableImage } from '../ui/ImageLightbox'
import { SmoothStreamText } from '../ui/SmoothStreamText'
import { Ansi } from '../ui/Ansi'
import { useFePrefs } from '../../store/historyPins'
import { preambleDescLines } from '../../scrollback/bgTaskView'
import { SubagentView } from './SubagentView'

export function ViewerBody({
  entry,
  now,
}: {
  entry: ScrollEntry
  now?: number
}) {
  const smoothStream = useFePrefs((s) => s.fePrefs.streamTextSmooth)
  if (entry.kind === 'tool' && entry.raw) {
    if (toolEntryLitePending(entry)) {
      // 正文被 lite 裁掉：全文视图同样只给占位行（打开查看器已触发按需
      // 补全，这里是补回来之前的过渡态）。占位行带手动 [加载] / [重试]。
      return (
        <LiteToolFill
          bytes={entry.liteOmitted}
          state={entry.liteState}
          onFill={() => void useChatStore.getState().fillToolEntryDetail(entry.id)}
          className="mt-0"
        />
      )
    }
    return (
      <ToolDetail
        raw={entry.raw}
        kindName={entry.kindName}
        full
        mergedRaws={entry.mergedRaws}
        className="mt-0"
        onLoad={
          toolEntryNeedsFill(entry)
            ? () => void useChatStore.getState().fillToolEntryDetail(entry.id)
            : undefined
        }
        loadState={entry.liteState}
      />
    )
  }
  if (entry.kind === 'tool') {
    return (
      <pre className="whitespace-pre-wrap break-all font-mono text-[12px] text-gn-muted">
        {JSON.stringify(entry, null, 2)}
      </pre>
    )
  }
  if (entry.kind === 'user') {
    return (
      <div className="space-y-3">
        <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-gn-fg font-ui">
          {entry.text || <span className="text-gn-muted">(empty)</span>}
        </div>
        {entry.images?.length ? <ViewerImages images={entry.images} /> : null}
      </div>
    )
  }
  if (entry.kind === 'thought') {
    return (
      <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-gn-fg font-ui">
        {entry.text ? (
          <SmoothStreamText
            text={entry.text}
            enabled={smoothStream && !!entry.streaming}
            revealInitial={false}
            className="whitespace-pre-wrap break-words"
          />
        ) : (
          <span className="text-gn-muted">(empty)</span>
        )}
      </div>
    )
  }
  if (entry.kind === 'error') {
    return (
      <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-gn-fg font-ui">
        {entry.text || <span className="text-gn-muted">(empty)</span>}
      </div>
    )
  }
  if (entry.kind === 'assistant') {
    return (
      <div className="space-y-3">
        <Markdown
          source={entry.text}
          streaming={!!entry.streaming}
          smoothStream={smoothStream}
        />
        {entry.images?.length ? <ViewerImages images={entry.images} /> : null}
      </div>
    )
  }
  if (entry.kind === 'image') {
    return <ViewerImages images={[{ data: entry.data, mimeType: entry.mimeType }]} />
  }
  if (entry.kind === 'btw') {
    // same content as the scrollback block's expanded form: golden header +
    // error / markdown answer / waiting hint.
    return (
      <div className="space-y-2">
        <div
          className="text-[13.5px] font-bold leading-[1.35] break-words"
          style={{ color: Accents.plan }}
        >
          /btw {entry.question}
        </div>
        {entry.error ? (
          <div
            className="whitespace-pre-wrap break-words text-[13px] leading-[1.45]"
            style={{ color: Accents.error }}
          >
            {entry.error}
          </div>
        ) : entry.answer ? (
          // 同滚动区 BtwEntry：key 不能跟随答案文本，否则每个流式更新都
          // 重挂载外层并把整段答案重新淡入一次。
          <div className={smoothStream ? 'gn-stream-fade' : undefined}>
            <Markdown
              source={entry.answer}
              streaming={!!entry.streaming}
              smoothStream={smoothStream}
            />
          </div>
        ) : entry.streaming ? (
          <div className="text-[12.5px] text-gn-muted">等待回答…</div>
        ) : null}
      </div>
    )
  }
  if (entry.kind === 'session_event') {
    return (
      <div className="space-y-2">
        <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-gn-fg font-ui">
          {entry.text}
        </div>
      </div>
    )
  }
  if (entry.kind === 'plan') {
    // Same structured todo list as the scrollback block (TUI todo pane).
    const items = planTodos(entry.entries).items
    return (
      <div className="space-y-[3px]">
        {items.length === 0 ? (
          <div className="text-[11px] text-gn-muted">（空计划）</div>
        ) : (
          items.map((t, i) => (
            <div key={t.id ?? i} className="flex items-start gap-2 text-[13px] leading-snug">
              <span className="mt-[1px] shrink-0 font-mono text-[11px]" aria-hidden>
                <TodoMark status={t.status} />
              </span>
              <span
                className={`min-w-0 flex-1 break-words ${
 t.status === 'completed' || t.status === 'cancelled'
                    ? 'text-gn-muted'
                    : 'text-gn-fg'
                }`}
              >
                {t.content}
              </span>
              {t.priority && (
                <span className="shrink-0 text-[10px] text-gn-gutter">{t.priority}</span>
              )}
            </div>
          ))
        )}
      </div>
    )
  }
  if (entry.kind === 'bg_task') {
    // TUI BgTaskBlock::preamble：description（primary 色逐行，行尾空白裁掉、
    // 连续空行折叠）+ 空行 + `$ command`（bash 高亮 FE 暂无，保持纯色）。
    const stdout = entry.output ?? ''
    const descLines = preambleDescLines(entry.title)
    return (
      <div className="space-y-3">
        {(entry.title || entry.command) && (
          <div className="rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-2 font-mono text-[12px] leading-relaxed text-gn-fg">
            {descLines.length > 0 && (
              <div>
                {descLines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words">
                    {line || '\u00a0'}
                  </div>
                ))}
              </div>
            )}
            {entry.command ? (
              <div className={descLines.length > 0 ? 'mt-2' : ''}>
                <span className="whitespace-pre text-gn-gray-dim">$ </span>
                <span className="whitespace-pre-wrap break-all">
                  {entry.command}
                </span>
              </div>
            ) : null}
            {entry.outputFile && (
              <div className="mt-1.5 truncate text-[10px] text-gn-muted" title={entry.outputFile}>
                log · {entry.outputFile}
              </div>
            )}
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-gn-gutter">
            <span>stdout</span>
            {entry.running && (
              <span className="normal-case tracking-normal text-gn-accent-running">
                live
              </span>
            )}
          </div>
          {stdout ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.45] text-gn-fg">
              <Ansi text={stdout} />
            </pre>
          ) : (
            <div className="text-[12px] text-gn-muted">
              {entry.running
                ? 'Waiting for output…'
                : '(no output)'}
            </div>
          )}
        </div>
      </div>
    )
  }
  if (entry.kind === 'subagent') {
    return <SubagentView entry={entry} now={now ?? Date.now()} />
  }
  return (
    <pre className="whitespace-pre-wrap font-mono text-[12px] text-gn-muted">
      {JSON.stringify(entry, null, 2)}
    </pre>
  )
}


/** Estimated decoded byte size of a data URI / base64 payload. */
function imageBytes(data: string): number {
  const comma = data.indexOf(',')
  const body = comma >= 0 ? data.slice(comma + 1) : data
  let padding = 0
  if (body.endsWith('==')) padding = 2
  else if (body.endsWith('=')) padding = 1
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding)
}

/** "mimeType · 12.3 KB" caption for a viewer image. */
function imageMeta(img: { data: string; mimeType?: string }): string {
  const parts: string[] = []
  if (img.mimeType) parts.push(img.mimeType)
  parts.push(fmtBytes(imageBytes(img.data)))
  return parts.join(' · ')
}

/** Full-size images for assistant / user / standalone image entries. */
function ViewerImages({
  images,
}: {
  images: Array<{ data: string; mimeType?: string }>
}) {
  return (
    <div className="space-y-4">
      {images.map((img, i) => (
        <figure key={i} className="space-y-1">
          <ZoomableImage
            src={img.data}
            mimeType={img.mimeType}
            loading="eager"
            className="max-h-[75vh] w-auto max-w-full rounded border border-gn-prompt-border object-contain"
          />
          <figcaption className="font-mono text-[11px] text-gn-muted">
            {imageMeta(img)}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
