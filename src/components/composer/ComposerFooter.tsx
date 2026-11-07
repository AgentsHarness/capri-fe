import { useMemo, useRef } from 'react'
import { useChatStore } from '../../store/chat'
import { isMultilineEnabled } from '../../commands/registry'
import { Glyphs } from '../../theme/glyphs'
import { useFittedModeLabel } from './useFittedModeLabel'
import { ModelMenu } from './ModelMenu'
import { ModeMenu } from './ModeMenu'
import type { AnchoredMenuPos } from '../../hooks/useAnchoredMenu'

type ComposerFooterProps = {
  guest: boolean
  promptFocused: boolean
  modelMenu: ReturnType<typeof import('./useModelMenu').useModelMenu>
  modelOpen: boolean
  setModelOpen: (updater: boolean | ((open: boolean) => boolean)) => void
  modelMenuPos: AnchoredMenuPos | null
  modelRef: React.RefObject<HTMLSpanElement | null>
  modelBtnRef: React.RefObject<HTMLButtonElement | null>
  modeMenu: ReturnType<typeof import('./useModeMenu').useModeMenu>
  modeOpen: boolean
  setModeOpen: (updater: boolean | ((open: boolean) => boolean)) => void
  modeMenuPos: AnchoredMenuPos | null
  modeRef: React.RefObject<HTMLSpanElement | null>
  modeBtnRef: React.RefObject<HTMLButtonElement | null>
  currentModeLabel: string
  currentModeShortLabel: string
  inPlan: boolean
}

/** Composer 底栏（模型 · 模式 · flags），浮在 prompt 边框下沿。 */
export function ComposerFooter({
  guest,
  promptFocused,
  modelMenu,
  modelOpen,
  setModelOpen,
  modelMenuPos,
  modelRef,
  modelBtnRef,
  modeMenu,
  modeOpen,
  setModeOpen,
  modeMenuPos,
  modeRef,
  modeBtnRef,
  currentModeLabel,
  currentModeShortLabel,
  inPlan,
}: ComposerFooterProps) {
  const conn = useChatStore((s) => s.conn)
  const modelName = useChatStore((s) => s.modelName)
  const reasoningEffort = useChatStore((s) => s.reasoningEffort)
  const models = useChatStore((s) => s.models)
  const statusText = useChatStore((s) => s.idleStatusLine())

  // Caption opacity: focused 0.6 / unfocused 0.4 of text_secondary (chrome_caption_style)
  const captionColor = promptFocused
    ? 'color-mix(in srgb, var(--color-gn-fg2) 60%, var(--color-gn-bg-base))'
    : 'color-mix(in srgb, var(--color-gn-fg2) 40%, var(--color-gn-bg-base))'
  const sepColor = promptFocused
    ? 'var(--color-gn-gray-dim)'
    : 'color-mix(in srgb, var(--color-gn-gray-dim) 60%, var(--color-gn-bg-base))'
  const flagColor = promptFocused
    ? 'var(--color-gn-gray)'
    : 'color-mix(in srgb, var(--color-gn-gray) 50%, var(--color-gn-bg-base))'

  // Mode button color: orange for plan, cyan for active auto/always, captionColor for normal
  const modeColor = inPlan
    ? 'var(--color-gn-orange)'
    : currentModeLabel !== 'normal'
      ? 'var(--color-gn-cyan)'
      : captionColor

  /**
   * 模型槽拆成「名字」与「思考强度」两段渲染：槽宽有上限时只截断名字，
   * 强度后缀 shrink-0 原样保留，避免 `grok-4.5 (xhigh)` 被整体截成
   * `grok-4.5 (x…`。
   */
  const modelCaption = useMemo(() => {
    // Offline / error: surface connection state in the model slot
    if (conn === 'offline' || conn === 'error')
      return { base: 'disconnected', effort: '' }
    if (conn === 'connecting') return { base: 'connecting…', effort: '' }
    const base = (modelName && modelName.trim()) || 'grok'
    return { base, effort: reasoningEffort || '' }
  }, [conn, modelName, reasoningEffort])
  const modelLabel = modelCaption.effort
    ? `${modelCaption.base} (${modelCaption.effort})`
    : modelCaption.base

  const otherFlags = useMemo(() => {
    const out: { text: string; color?: string }[] = []
    if (isMultilineEnabled()) {
      out.push({ text: 'multiline', color: 'var(--color-gn-cyan)' })
    }
    return out
    // statusText 是 /multiline 命令的变更信号（命令只写 localStorage +
    // statusText，多行 chip 靠这个 dep 重算）——非多余依赖。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [statusText])

  // 底栏（模型名 · token 数 · 模式 · 其它 flag）是 max-w-[75%] 的绝对
  // 定位 flex：模型名一长、再叠上完整模式名 always-approve 就会顶出
  // prompt 边框，所以按实测宽度在完整名与短名之间选（composer/
  // useFittedModeLabel.ts）。探针只在行内量文本宽度，不参与布局。
  const footerRowRef = useRef<HTMLDivElement | null>(null)
  const modeFullProbeRef = useRef<HTMLSpanElement | null>(null)
  const modeShortProbeRef = useRef<HTMLSpanElement | null>(null)
  const footerContentKey = [modelLabel, ...otherFlags.map((f) => f.text)].join(
    '\u0001',
  )
  const modeLabel = useFittedModeLabel({
    rowRef: footerRowRef,
    fullProbeRef: modeFullProbeRef,
    shortProbeRef: modeShortProbeRef,
    full: currentModeLabel,
    short: currentModeShortLabel,
    contentKey: footerContentKey,
  })

  return (
          <div
            ref={footerRowRef}
            className="pointer-events-none absolute -bottom-[5px] right-2 flex max-w-[75%] items-center gap-0 text-[11px] leading-none"
            style={{
              background: 'var(--color-gn-bg-base)',
            }}
            title={[modelLabel, currentModeLabel, ...otherFlags.map((f) => f.text)].filter(Boolean).join(' · ')}
          >
            {/* 模式名宽度探针：量完整名/短名各自占多少 px（绝对定位，不
                参与布局；data-probe 让内容宽度测量跳过它们）。 */}
            <span
              ref={modeFullProbeRef}
              data-probe
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 whitespace-nowrap opacity-0"
            >
              {currentModeLabel}
            </span>
            <span
              ref={modeShortProbeRef}
              data-probe
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 whitespace-nowrap opacity-0"
            >
              {currentModeShortLabel}
            </span>
            <span ref={modelRef} className="relative z-30 inline-flex shrink-0">
              <button
                ref={modelBtnRef}
                type="button"
                disabled={guest}
                onClick={() => {
                  if (guest) return
                  if (!modelOpen) setModeOpen(false)
                  setModelOpen((v) => !v)
                }}
                className="pointer-events-auto inline-flex max-w-[220px] min-w-0 items-center gap-1 rounded px-0.5 transition-colors hover:bg-gn-bg-highlight disabled:cursor-default disabled:hover:bg-transparent"
                style={{ color: captionColor }}
                title={guest ? `${modelLabel} · 访客只读` : `${modelLabel} · 点击切换模型`}
              >
                <span className="min-w-0 truncate">{modelCaption.base}</span>
                {modelCaption.effort && (
                  <span className="shrink-0 whitespace-nowrap">
                    ({modelCaption.effort})
                  </span>
                )}
              </button>
              {!guest && modelOpen && models.length > 0 && modelMenuPos && (
                <ModelMenu models={models} pos={modelMenuPos} menu={modelMenu} />
              )}
            </span>

            {/* 上下文用量读数（used/size）已移除：TUI 只在顶栏 context_bar 显示，
                composer 这行只留模型名与模式名，避免与顶栏芯片重复。 */}


            {/* 模式按钮（点击弹出弹窗，在弹窗内提供 Plan 独立开关与权限模式切换） */}
            <span ref={modeRef} className="relative z-30 inline-flex shrink-0 items-center">
              <span style={{ color: sepColor }} className="px-1">
                {Glyphs.middleDot}
              </span>
              <button
                ref={modeBtnRef}
                type="button"
                disabled={guest}
                onClick={() => {
                  if (guest) return
                  if (!modeOpen) setModelOpen(false)
                  setModeOpen((v) => !v)
                }}
                className="pointer-events-auto max-w-[160px] cursor-pointer truncate rounded px-0.5 transition-colors hover:bg-gn-bg-highlight disabled:cursor-default disabled:hover:bg-transparent"
                style={{ color: modeColor }}
                title={
                  guest
                    ? `当前模式: ${currentModeLabel} · 访客只读`
                    : `当前模式: ${currentModeLabel} · 点击切换模式`
                }
              >
                {modeLabel}
              </button>
              {!guest && modeOpen && modeMenuPos && (
                <ModeMenu pos={modeMenuPos} menu={modeMenu} />
              )}
            </span>

            <span className="flex min-w-0 items-center truncate">
              {otherFlags.map((f, i) => (
                <span key={i} className="inline-flex items-center">
                  <span style={{ color: sepColor }} className="px-1">
                    {Glyphs.middleDot}
                  </span>
                  <span
                    className="truncate"
                    style={{ color: f.color || flagColor }}
                  >
                    {f.text}
                  </span>
                </span>
              ))}
            </span>
          </div>
  )
}
