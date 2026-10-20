import { useMemo, useState } from 'react'
import { ChevronDown, LogOut, ShieldQuestion, TriangleAlert } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import type { GuestSessionItem } from '../../api/types'
import { ThemePicker } from '../ui/ThemePicker'
import { formatGuestExpiry } from '../../api/rpc/guestTokens'
import { pickLayerError } from '../../lib/layerErr'
import { LayerErrNotice } from '../ui/LayerErrNotice'

/**
 * 访客顶栏：只显示当前 Host（静态标签，不给 host 切换器）+ 会话 +
 * 「访客 · 只读」徽标 + 主题 + 令牌状态 + 退出。
 *
 * 会话列表按 hostName 分组，条目来自 `accessRole.sessions`——访客能看的
 * 会话集合由 hub 决定，前端不认识别的会话。只有一条会话时不渲染下拉，
 * 直接把标题摊在行里（分享链接的常见形态，少一层多余的可点区域）。
 */
export function GuestTopBar({ onExit }: { onExit: () => void }) {
  const sessions = useChatStore((s) => s.guestSessions)
  const sessionId = useChatStore((s) => s.sessionId)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const switchGuestSession = useChatStore((s) => s.switchGuestSession)
  const layerErrors = useChatStore((s) => s.layerErrors)
  const [open, setOpen] = useState(false)

  // hub / host 层错误与管理员的顶栏同源（hub WS 断线、host boot 失败、
  // host 离线），只读视图同样要能看到；重启按钮是写操作，访客不渲染。
  const layerErr = pickLayerError(layerErrors)

  // 当前 host：优先当前会话所在的那台（Host 名来自白名单快照）。
  const currentHost = useMemo(() => {
    const hit = sessions.find(
      (s) => s.hostId === selectedHostId && s.sessionId === sessionId,
    )
    const byHost = sessions.find((s) => s.hostId === selectedHostId)
    return hit?.hostName || byHost?.hostName || selectedHostId || 'Host'
  }, [sessions, selectedHostId, sessionId])

  const current = sessions.find((s) => s.sessionId === sessionId)
  const currentTitle = current?.title || current?.sessionId || '选择会话'
  const single = sessions.length <= 1

  // 按 hostName 分组（同一台的会话排在一起，保持白名单顺序）。
  const groups = useMemo(() => {
    const out: { hostId: string; hostName: string; items: GuestSessionItem[] }[] = []
    for (const s of sessions) {
      let g = out.find((x) => x.hostId === s.hostId)
      if (!g) {
        g = { hostId: s.hostId, hostName: s.hostName || s.hostId, items: [] }
        out.push(g)
      }
      g.items.push(s)
    }
    return out
  }, [sessions])

  return (
    <header className="relative z-40 select-none border-b border-gn-prompt-border bg-gn-bg-base">
      {/* 窄屏布局：第一行只放 host / 只读徽标 / 图标按钮，会话下拉（标题
          动辄二三十个字）整行落到第二行。让下拉留在第一行会被压成几个
          字，什么都读不出来。只有一条会话时没有下拉，标题在第一行截断。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-[6px] text-[12px] text-gn-muted sm:px-4">
        {/* Host：访客只有这一台（当前会话所在的），不提供切换。 */}
        {layerErr && (
          // 与管理员顶栏同一套：host 名保持原样，前面加告警图标，
          // 错误文案单独一条在右侧（见下方 LayerErrNotice）。
          <TriangleAlert
            size={12}
            strokeWidth={2}
            className={`shrink-0 ${layerErr.err.level === 'error' ? 'text-gn-red' : 'text-gn-warning'}`}
            aria-hidden
          />
        )}
        <span
          className="inline-flex min-w-0 max-w-[40vw] shrink select-none items-center gap-1 rounded px-1 py-0.5 font-medium text-gn-fg sm:max-w-[28vw] sm:px-1.5"
          title={`Host：${currentHost}`}
        >
          <span className="truncate">{currentHost}</span>
        </span>
        <span className="shrink-0 rounded bg-gn-bg-highlight px-1.5 py-0.5 text-[10.5px] text-gn-muted">
          <span className="sm:hidden">只读</span>
          <span className="hidden sm:inline">访客 · 只读</span>
        </span>

        {single ? (
          sessions.length > 0 ? (
            <span
              className="min-w-0 flex-1 truncate text-gn-fg2"
              title={currentTitle}
            >
              {currentTitle}
            </span>
          ) : (
            <div className="flex-1" />
          )
        ) : (
          <>
            {/* 会话下拉（窄屏第二行 / 桌面行内） */}
            <div className="relative order-last w-full min-w-0 sm:order-none sm:w-auto">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label="切换会话"
                title={currentTitle}
                className="inline-flex min-h-8 w-full items-center gap-1 rounded px-1.5 hover:bg-gn-bg-highlight hover:text-gn-fg sm:w-auto sm:max-w-[32rem]"
              >
                <span className="truncate">{currentTitle}</span>
                <ChevronDown size={12} strokeWidth={2.5} className="shrink-0" aria-hidden />
              </button>
              {open && (
                <>
                  <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
                  <div
                    className="absolute left-0 top-full z-50 mt-1 max-h-[60vh] w-[min(24rem,92vw)] overflow-y-auto rounded-md border border-gn-prompt-border bg-gn-bg-base py-1 shadow-xl"
                    role="listbox"
                    aria-label="可访问的会话"
                  >
                    {groups.map((g) => (
                      <div key={g.hostId}>
                        <div className="px-3 pt-2 pb-1 font-mono text-[10.5px] tracking-wide text-gn-gutter">
                          {g.hostName}
                        </div>
                        {g.items.map((s) => {
                          const active = s.sessionId === sessionId
                          return (
                            <button
                              key={`${s.hostId}:${s.sessionId}`}
                              type="button"
                              role="option"
                              aria-selected={active}
                              onClick={() => {
                                setOpen(false)
                                void switchGuestSession(s)
                              }}
                              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gn-bg-highlight ${
                                active ? 'bg-gn-bg-highlight/60 text-gn-fg' : 'text-gn-fg2'
                              }`}
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {s.title || s.sessionId.slice(0, 12)}
                              </span>
                              {s.stale && (
                                <span className="shrink-0 text-[10px] text-gn-yellow" title="该会话在 Host 上已不存在">
                                  已失效
                                </span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="flex-1" />
          </>
        )}

        <ThemePicker />
        <GuestTokenStatus />
        <button
          type="button"
          onClick={onExit}
          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded px-1.5 hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="退出访客模式"
          aria-label="退出访客模式"
        >
          <LogOut size={13} strokeWidth={2} aria-hidden />
          <span className="hidden sm:inline">退出</span>
        </button>
        {/* hub / host 层错误：与管理员顶栏同一条提示，窄屏整行落到第二行。
            重启按钮是写操作 —— allowRestart=false，访客只看到原因 + ✕。 */}
        {layerErr && (
          <LayerErrNotice
            key={`${layerErr.layer}:${layerErr.err.at}`}
            layer={layerErr.layer}
            err={layerErr.err}
            allowRestart={false}
            className="order-last w-full pb-1 sm:order-none sm:w-auto sm:max-w-[26rem] sm:pb-0"
          />
        )}
      </div>
    </header>
  )
}

/**
 * 令牌状态：顶栏只留一个入口，详情（只读、到期、可访问会话数）放进
 * 弹窗——到期时间带完整年月日，铺在顶栏会把窄屏那一行挤爆。
 */
function GuestTokenStatus() {
  const identity = useChatStore((s) => s.guestIdentity)
  const sessions = useChatStore((s) => s.guestSessions)
  const [open, setOpen] = useState(false)
  const label = identity?.guest.label || '访客'
  const expires = identity?.guest.expiresAt ?? 0

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="访客令牌状态"
        title={`访客令牌：${label} · 到期 ${formatGuestExpiry(expires)}`}
        className="inline-flex min-h-8 min-w-0 max-w-[40vw] items-center gap-1 rounded px-1.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg sm:max-w-[14rem]"
      >
        <ShieldQuestion size={12} strokeWidth={2} aria-hidden className="shrink-0" />
        <span className="hidden truncate sm:inline">{label}</span>
        <ChevronDown size={11} strokeWidth={2.5} className="shrink-0 text-gn-gutter" aria-hidden />
      </button>
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label="关闭令牌状态"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute right-0 top-full z-50 mt-1 w-64 max-w-[92vw] gn-menu text-[11.5px]"
            role="dialog"
            aria-label="访客令牌状态"
          >
            <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-gn-gutter">
              guest token
            </div>
            <dl className="px-3 pb-2 text-gn-fg2">
              <div className="flex items-start gap-2 py-0.5">
                <dt className="w-12 shrink-0 text-gn-gutter">标签</dt>
                <dd className="min-w-0 flex-1 break-words">{label}</dd>
              </div>
              <div className="flex items-start gap-2 py-0.5">
                <dt className="w-12 shrink-0 text-gn-gutter">权限</dt>
                <dd className="min-w-0 flex-1">只读（无法输入）</dd>
              </div>
              <div className="flex items-start gap-2 py-0.5">
                <dt className="w-12 shrink-0 text-gn-gutter">到期</dt>
                <dd className="min-w-0 flex-1 tabular-nums">{formatGuestExpiry(expires)}</dd>
              </div>
              <div className="flex items-start gap-2 py-0.5">
                <dt className="w-12 shrink-0 text-gn-gutter">会话</dt>
                <dd className="min-w-0 flex-1">{sessions.length} 个可访问</dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </div>
  )
}
