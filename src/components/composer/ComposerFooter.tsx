import { useMemo, useRef } from 'react'
import { useChatStore } from '../../store/chat'
import { isMultilineEnabled } from '../../commands/registry'
import { Glyphs } from '../../theme/glyphs'
import { useFittedModeLabel } from './useFittedModeLabel'
import { useMinWidth } from '../../hooks/useMinWidth'
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

  // 底栏（模型名 · 模式 · 其它 flag）由外层定位框 + 内层可收缩 flex 组成。
  // 窄屏（< lg）定位框左边界放在 ❯ 图标右侧（14px 内边距 + 1.25em 图标
  // ≈ 30px，取 32px），模型名不进入左侧图标列；lg 起定位框从 0 开始，
  // 内层仍靠右对齐，桌面底栏行为不变。
  // 模型名不再有固定像素上限：整行放得下就用完整名，只在整个行宽不够时
  // 由 flex 收缩并截断。模式名继续按实测宽度在完整名与短名之间选
  // （composer/useFittedModeLabel.ts）。探针只在行内量文本宽度，不参与布局。
  const footerRowRef = useRef<HTMLDivElement | null>(null)
  const modeFullProbeRef = useRef<HTMLSpanElement | null>(null)
  const modeShortProbeRef = useRef<HTMLSpanElement | null>(null)
  const modelNameRef = useRef<HTMLSpanElement | null>(null)
  const footerContentKey = [modelLabel, ...otherFlags.map((f) => f.text)].join(
    '\u0001',
  )
  const fittedModeLabel = useFittedModeLabel({
    rowRef: footerRowRef,
    fullProbeRef: modeFullProbeRef,
    shortProbeRef: modeShortProbeRef,
    modelNameRef,
    full: currentModeLabel,
    short: currentModeShortLabel,
    contentKey: footerContentKey,
  })
  // 桌面（≥ lg）固定用完整模式名：模型名再长也只截模型名，不把
  // always-approve 降成 always；只有窄屏空间不足时才用实测短名兜底。
  const modeLabel = useMinWidth(1024) ? currentModeLabel : fittedModeLabel

  return (
          <div className="pointer-events-none absolute -bottom-[5px] left-8 right-2 flex justify-end lg:left-0">
            <div
              ref={footerRowRef}
              className="flex min-w-0 max-w-full items-center gap-0 text-[11px] leading-none"
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
            {/* 模型槽不再设固定上限：让它按行内剩余空间展开，只有整行真的
                放不下时才由 flex 收缩、名字 span 才截断。effort 后缀保持
                shrink-0，永远完整显示。 */}
            <span ref={modelRef} className="relative z-30 flex min-w-0 shrink">
              <button
                ref={modelBtnRef}
                type="button"
                disabled={guest}
                onClick={() => {
                  if (guest) return
                  if (!modelOpen) setModeOpen(false)
                  setModelOpen((v) => !v)
                }}
                className="pointer-events-auto inline-flex min-w-0 max-w-full items-center gap-1 rounded px-0.5 transition-colors hover:bg-gn-bg-highlight disabled:cursor-default disabled:hover:bg-transparent"
                style={{ color: captionColor }}
                title={guest ? `${modelLabel} · 访客只读` : `${modelLabel} · 点击切换模型`}
              >
                <span ref={modelNameRef} className="min-w-0 truncate">
                  {modelCaption.base}
                </span>
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
          </div>
  )
}
