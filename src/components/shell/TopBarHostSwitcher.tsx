import { useState } from 'react'
import { ChevronDown, LogOut, Plus, ShieldQuestion } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { transport } from '../../api/client'
import {
  hostSignal,
  hostSignalLabel,
  hostState,
  hostStateLabel,
  otherHostsSignal,
  type HostSignal,
  type HostState,
} from '../../lib/hostState'
import { pickLayerError } from '../../lib/layerErr'
import type { HostInfo } from '../../api/types'
import {
  AddHostModal,
  DeleteHostModal,
  HostActionsMenu,
  RenameHostModal,
  RestartAgentModal,
} from '../panels/host/HostActions'

/**
 * Hub 模式下列表行的通路标记（transport.activeRouteFor 的三态文案）：
 * - 直连 —— 本机近路可用，API/SSE 不绕 hub；
 * - 待验证 —— 探到了本机候选，但还差这台自己的钥匙，此刻仍走中继；
 * - 中继 —— 只有 hub 一条路（同机之外的一切机器，或用户显式选了中继）。
 * 没有近路候选（不能直连本机）的行不显示通道——只有中继一条路可走，
 * 标了也是噪声；对应 host 的操作菜单里「通路」区块也一并隐去。
 */
function hostRouteLabel(state: 'direct' | 'pending' | 'relay'): '直连' | '待验证' | '中继' {
  return state === 'direct' ? '直连' : state === 'pending' ? '待验证' : '中继'
}

/** 菜单打开位置边缘夹取：菜单宽 208px（w-52）、高 ~200px，贴着视口边缘。 */
function clampMenuPos(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - 212)),
    y: Math.max(4, Math.min(y, window.innerHeight - 136)),
  }
}

/** Host 列表行的实时状态点配色（离线/旧 hub 无状态字段 → 沿用绿/灰）。 */
function hostDotClass(h: HostInfo): string {
  switch (hostState(h)) {
    case 'thinking':
      return 'bg-gn-blue animate-pulse'
    case 'pending':
      return 'bg-gn-orange'
    case 'booting':
      return 'bg-gn-yellow'
    case 'idle':
      return 'bg-gn-green'
    default:
      return h.online ? 'bg-gn-green' : 'bg-gn-muted'
  }
}

const HOST_STATE_TEXT_CLASS: Record<HostState, string> = {
  thinking: 'text-gn-cyan',
  pending: 'text-gn-orange',
  booting: 'text-gn-yellow',
  idle: 'text-gn-green1',
}

/** 顶栏 host 名称前的两个点：左 = 其他 Host 聚合，右 = 当前 Host。 */
const HOST_SIGNAL_DOT_CLASS: Record<HostSignal, string> = {
  error: 'bg-gn-red',
  warning: 'bg-gn-warning',
  busy: 'bg-gn-blue animate-pulse',
  idle: 'bg-gn-green',
  offline: 'bg-gn-muted',
}

export function TopBarHostSwitcher({
  onEnterGuest,
  onLogout,
}: {
  onEnterGuest?: () => void
  onLogout?: () => void
}) {
  const hostName = useChatStore((s) => s.hostName)
  const hostId = useChatStore((s) => s.hostId)
  const hosts = useChatStore((s) => s.hosts)
  const mode = useChatStore((s) => s.mode)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const switchHost = useChatStore((s) => s.switchHost)
  const setHostRoute = useChatStore((s) => s.setHostRoute)
  const conn = useChatStore((s) => s.conn)
  const layerErrors = useChatStore((s) => s.layerErrors)

  const [openHosts, setOpenHosts] = useState(false)
  // 单个 host 的操作菜单（右键 / 行内 ⋮ 打开，fixed 坐标）。
  const [menuHost, setMenuHost] = useState<{ host: HostInfo; pos: { x: number; y: number } } | null>(null)
  // 添加 Host（配对码）模态框。
  const [addHostOpen, setAddHostOpen] = useState(false)
  // 修改名称 / 删除 / 重启确认的目标 host。
  const [renameTarget, setRenameTarget] = useState<HostInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<HostInfo | null>(null)
  const [restartTarget, setRestartTarget] = useState<HostInfo | null>(null)

  const currentHost =
    hosts.find((h) => h.hostId === selectedHostId) ??
    (hosts.length ? hosts[0] : null)
  const layerErr = pickLayerError(layerErrors)
  // 名称前的两个状态点：左点汇总其他 Host（正忙优先 > 在线 > 离线），
  // 右点只看当前 Host。分层错误/警告覆盖在右点上，优先级高于正忙；
  // 注册表还没有当前 Host 时按连接状态兜底。
  const otherHosts = hosts.filter((h) => h.hostId !== currentHost?.hostId)
  const othersSignal = otherHostsSignal(hosts, currentHost?.hostId)
  const currentSignal: HostSignal =
    layerErr?.err.level === 'error' || conn === 'error'
      ? 'error'
      : layerErr
        ? 'warning'
        : currentHost
          ? hostSignal(currentHost)
          : conn === 'busy'
            ? 'busy'
            : conn === 'ready'
              ? 'idle'
              : 'offline'
  // 只有一台 Host 时左点没有意义：只画当前 Host 一个点。
  const hostSignalsTitle =
    otherHosts.length > 0
      ? `其他 Host：${hostSignalLabel(othersSignal)} · 当前 Host：${hostSignalLabel(currentSignal)}`
      : `当前 Host：${hostSignalLabel(currentSignal)}`

  // Host label reflects connection health: abnormal → "connecting" / "error".
  // 分层错误（hub/host 层）不改写这里的文案：host 名字保持原样，错误/警告
  // 由名称前的状态点与右侧 LayerErrNotice 指示——错误既不挤掉 host 名字，
  // 也不另占一整条。
  const hostLabel = layerErr
    ? hostName || 'Local Host'
    : conn === 'connecting'
      ? 'connecting'
      : conn === 'error' || conn === 'offline'
        ? 'error'
        : hostName || 'Local Host'
  const hostLabelColor = layerErr
    ? ''
    : conn === 'connecting'
      ? 'text-gn-muted'
      : conn === 'error' || conn === 'offline'
        ? 'text-gn-red'
        : ''

  return (
        <div className="relative min-w-0 shrink">
          {mode === 'local' ? (
            // 本地模式：锁定本机 —— 静态 Localhost 标签，不可点击、无下拉。
            <div
              className="flex min-h-8 max-w-[40vw] items-center gap-1.5 truncate rounded px-2 py-0.5 sm:max-w-xs"
              title="本地模式（仅本机 capri-host，无 host 切换）"
            >
              <span className="min-w-0 truncate text-gn-fg">Localhost</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpenHosts((v) => !v)}
              onContextMenu={(e) => {
                // 网页端：右键当前 host 直接弹操作菜单（修改 / 删除）。
                e.preventDefault()
                if (currentHost) {
                  setMenuHost({ host: currentHost, pos: clampMenuPos(e.clientX, e.clientY) })
                } else {
                  setOpenHosts(true)
                }
              }}
              className={`flex max-w-[40vw] sm:max-w-xs items-center gap-1.5 truncate rounded px-2 py-0.5 hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8 ${hostLabelColor}`}
              title={
                conn === 'connecting' || conn === 'error' || conn === 'offline'
                  ? `连接状态: ${conn}${hostName ? ` · ${hostName}` : ''} · ${hostSignalsTitle}`
                  : `${hostName || 'Local Host'}（右键可管理 Host） · ${hostSignalsTitle}`
              }
            >
              <span className="mr-0.5 flex shrink-0 items-center gap-1" aria-hidden>
                {otherHosts.length > 0 && (
                  <span
                    data-host-dot="others"
                    className={`h-1.5 w-1.5 rounded-full ${HOST_SIGNAL_DOT_CLASS[othersSignal]}`}
                  />
                )}
                <span
                  data-host-dot="current"
                  className={`h-1.5 w-1.5 rounded-full ${HOST_SIGNAL_DOT_CLASS[currentSignal]}`}
                />
              </span>
              <span className="min-w-0 truncate">{hostLabel}</span>
              <ChevronDown
                size={12}
                strokeWidth={2}
                className="shrink-0 text-gn-gutter"
                aria-hidden
              />
            </button>
          )}
          {openHosts && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                aria-label="close"
                onClick={() => {
                  setOpenHosts(false)
                  setMenuHost(null)
                }}
              />
              <div className="absolute left-0 top-full z-40 mt-1 w-64 max-w-[90vw] gn-menu">
                <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-gn-gutter">
                  hosts
                </div>
                {(hosts.length
                  ? hosts
                  : [{ hostId: hostId || 'local', hostName: hostName || 'Local Host', online: true }]
                ).map((h) => {
                  const current = h.hostId === selectedHostId
                  // 空列表时的合成行只是渲染占位，没有实时数据；别把它标成「空闲」。
                  const state = hosts.length ? hostState(h) : undefined
                  const stateLabel = hostStateLabel(state)
                  // 每次渲染读 transport：discoverLocalHost / refreshHosts 后
                  // hosts 更新会带动重绘，通路标记随之刷新。近路是按 hostId 逐台
                  // 验证的（同机可能有多台 host，也可能一台都没有）。
                  const localRoute = transport.getLocalRoute(h.hostId)
                  // 不能直连本机的（无近路候选）不显示通道：行内标记与悬停
                  // 提示都省掉——反正只有 Hub 中继一条路，标了也是噪声。
                  const hasCandidate = transport.hasLocalCandidate(h.hostId)
                  const routeState = transport.activeRouteFor(h.hostId)
                  const route = hostRouteLabel(routeState)
                  const routeHint =
                    routeState === 'direct'
                      ? `API/SSE 直连 ${localRoute?.base || '本机'}`
                      : routeState === 'pending'
                        ? '已探到本机这台，等它的钥匙（现在走 Hub 中继）'
                        : '经 Hub 中继'
                  return (
                    <div
                      key={h.hostId}
                      className="group/host relative"
                      onContextMenu={(e) => {
                        // 网页端：右键任意 host 行弹操作菜单。
                        e.preventDefault()
                        setMenuHost({ host: h, pos: clampMenuPos(e.clientX, e.clientY) })
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setMenuHost(null)
                          setOpenHosts(false)
                          void switchHost(h.hostId)
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-2 pr-9 text-left text-[12px] hover:bg-gn-bg-highlight ${current ? 'bg-gn-bg-highlight' : ''}`}
                        title={
                          h.online
                            ? stateLabel
                              ? `切换到 ${h.hostName}（${stateLabel}${hasCandidate ? ` · ${routeHint}` : ''}，右键可管理）`
                              : hasCandidate
                                ? `切换到 ${h.hostName}（${routeHint}，右键可管理）`
                                : `切换到 ${h.hostName}（右键可管理）`
                            : `${h.hostName}（离线${hasCandidate ? ` · ${routeHint}` : ''}）`
                        }
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${hostDotClass(h)}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-gn-fg">
                            {h.hostName}
                            {current && <span className="ml-1.5 text-[10px] text-gn-cyan">当前</span>}
                            {hasCandidate && (
                              <span
                                className={`ml-1.5 text-[10px] ${
 route === '直连'
                                    ? 'text-gn-green'
                                    : route === '待验证'
                                      ? 'text-gn-yellow'
                                      : 'text-gn-gutter'
                                }`}
                              >
                                {route}
                              </span>
                            )}
                          </div>
                          <div className="truncate font-mono text-[10px] text-gn-muted">
                            {h.hostId}
                            {stateLabel && (
                              <span className={`ml-1.5 ${state ? HOST_STATE_TEXT_CLASS[state] : ''}`}>
                                {stateLabel}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      {/* 行内 ⋮ 菜单图标：移动端（无右键）的主要入口，桌面端悬停可见。 */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          const r = e.currentTarget.getBoundingClientRect()
                          setMenuHost(
                            menuHost?.host.hostId === h.hostId
                              ? null
                              : { host: h, pos: clampMenuPos(r.right - 208, r.bottom + 2) },
                          )
                        }}
                        aria-label={`${h.hostName} 操作`}
                        title="修改 / 删除"
                        className={`absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-gn-gutter hover:bg-gn-bg-highlight hover:text-gn-fg lg:opacity-0 lg:group-hover/host:opacity-100 ${menuHost?.host.hostId === h.hostId ? 'lg:opacity-100' : ''}`}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden
                        >
                          <circle cx="3.2" cy="8" r="1.4" />
                          <circle cx="8" cy="8" r="1.4" />
                          <circle cx="12.8" cy="8" r="1.4" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
                <div className="border-t border-gn-prompt-border">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHosts(false)
                      setAddHostOpen(true)
                    }}
                    className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    title="获取新配对码，在另一台机器上接入 hub"
                  >
                    <Plus size={13} strokeWidth={2} aria-hidden />
                    添加 Host
                  </button>
                  {/* 切换到访客模式：只读分享视图。纯 local 没有 hub 承载
                      白名单，不给入口；管理员未登录时也没有可切的身份。 */}
                  {onEnterGuest && transport.getAccessToken() && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenHosts(false)
                        onEnterGuest()
                      }}
                      className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                      title="切换到访客模式（只读分享视图；本地没有存过访客令牌时会要求输入）"
                    >
                      <ShieldQuestion size={13} strokeWidth={2} aria-hidden />
                      切换到访客模式
                    </button>
                  )}
                  {onLogout && transport.getAccessToken() && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenHosts(false)
                        onLogout()
                      }}
                      className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                      title="退出登录（清掉本机保存的 Hub 密钥；各台 Host 的近路钥匙保留）"
                    >
                      <LogOut size={13} strokeWidth={2} aria-hidden />
                      退出登录
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {/* 单个 host 的操作菜单：右键（网页）/ ⋮ 图标（移动端）打开。 */}
          {menuHost && (
            <HostActionsMenu
              host={menuHost.host}
              pos={menuHost.pos}
              onClose={() => setMenuHost(null)}
              onRename={(h) => {
                setMenuHost(null)
                setRenameTarget(h)
              }}
              onDelete={(h) => {
                setMenuHost(null)
                setDeleteTarget(h)
              }}
              onRestart={(h) => {
                setMenuHost(null)
                setRestartTarget(h)
              }}
              routeState={transport.activeRouteFor(menuHost.host.hostId)}
              onRoute={(h, choice) => void setHostRoute(h.hostId, choice)}
              // 重启作用于当前选中 host 的 agent（transport 按选中
              // host 路由）；非当前 host 行不显示重启项，避免误解。
              canRestart={menuHost.host.hostId === selectedHostId}
            />
          )}
          {renameTarget && (
            <RenameHostModal host={renameTarget} onClose={() => setRenameTarget(null)} />
          )}
          {deleteTarget && (
            <DeleteHostModal host={deleteTarget} onClose={() => setDeleteTarget(null)} />
          )}
          {restartTarget && (
            <RestartAgentModal host={restartTarget} onClose={() => setRestartTarget(null)} />
          )}
          {addHostOpen && <AddHostModal onClose={() => setAddHostOpen(false)} />}
        </div>
  )
}
