import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  Power,
  Radio,
  RefreshCw,
  Save,
  Shield,
  Unlink,
} from 'lucide-react'
import { transport } from '../api/client'
import { pushToast } from '../store/toast'

interface HostConfig {
  bind?: string
  port?: number
  host_id?: string
  host_name?: string
  hub_url?: string
  hub_pair_code?: string
  fe_token?: string
  grok_bin?: string
  proxy?: string
  no_proxy?: string
  start_host_on_launch?: boolean
  start_at_login?: boolean
  keep_awake?: boolean
}

interface HubState {
  configured: boolean
  hubUrl?: string
  hostId?: string
  hostName?: string
  paired: boolean
  connected: boolean
  transport?: string
  uptimeSec?: number
  lastError?: string
  storedUrl?: string
  canReuse?: boolean
}

/** 这几项写进文件后，要等 Host 进程重新起来才生效。 */
export function saveNeedsRestart(before: HostConfig, after: HostConfig): boolean {
  return (
    (before.port ?? 8765) !== (after.port ?? 8765) ||
    (before.bind ?? '127.0.0.1') !== (after.bind ?? '127.0.0.1') ||
    (before.fe_token ?? '') !== (after.fe_token ?? '') ||
    (before.proxy ?? '') !== (after.proxy ?? '') ||
    (before.no_proxy ?? '') !== (after.no_proxy ?? '') ||
    (before.grok_bin ?? '') !== (after.grok_bin ?? '')
  )
}

export function configFingerprint(c: HostConfig): string {
  return JSON.stringify([
    c.bind ?? '',
    c.port ?? 8765,
    c.host_id ?? '',
    c.host_name ?? '',
    c.hub_url ?? '',
    c.fe_token ?? '',
    c.grok_bin ?? '',
    c.proxy ?? '',
    c.no_proxy ?? '',
    c.start_host_on_launch ?? true,
    c.start_at_login ?? false,
    c.keep_awake ?? false,
  ])
}

/** Bare host means https. Path and query are dropped, matching the host. */
export function normalizeHubURL(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const s = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    if (!u.hostname) return ''
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

/** Reuse is offered only when the field is the address the stored credential is bound to. */
export function credentialMatchesField(typed: string, stored: string | undefined): boolean {
  const a = normalizeHubURL(typed)
  const b = normalizeHubURL(stored ?? '')
  return a !== '' && a === b
}

export function saveStatusText(needsRestart: boolean): string {
  if (!needsRestart) return '已保存。'
  return '已保存。端口、绑定、本机钥匙、代理或 grok 路径要重启 Host 后才生效，请在托盘菜单里点「重启 Host」。'
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return '0 秒'
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`
  const hours = Math.floor(sec / 3600)
  const mins = Math.floor((sec % 3600) / 60)
  return `${hours} 小时 ${mins} 分`
}

export function HostSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')

  // 原始配置备份（用于对比是否有需重启的变更）
  const [initialConfig, setInitialConfig] = useState<HostConfig>({})
  const [config, setConfig] = useState<HostConfig>({})
  const [hubState, setHubState] = useState<HubState | null>(null)

  // 表单临时编辑字段
  const [pairCode, setPairCode] = useState('')
  const [rePairExpanded, setRePairExpanded] = useState(false)
  const [showToken, setShowToken] = useState(false)

  // 读取配置与 Hub 状态
  const fetchData = useCallback(async () => {
    try {
      const [cfgRes, hubRes] = await Promise.all([
        transport.apiFetch('/api/host/config').then((r) => r.json()),
        transport.apiFetch('/api/hub/state').then((r) => r.json()),
      ])

      if (cfgRes.ok && cfgRes.config) {
        setConfig(cfgRes.config)
        setInitialConfig(cfgRes.config)
      }
      if (hubRes.ok && hubRes.hub) {
        setHubState(hubRes.hub)
      }
    } catch (e) {
      pushToast('读取设置失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
    const timer = setInterval(async () => {
      try {
        const res = await transport.apiFetch('/api/hub/state').then((r) => r.json())
        if (res.ok && res.hub) {
          setHubState(res.hub)
        }
      } catch {
        // 静默
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [fetchData])

  const requiresRestart = useMemo(
    () => saveNeedsRestart(initialConfig, config),
    [initialConfig, config],
  )

  const formDirty = configFingerprint(config) !== configFingerprint(initialConfig)
  const reuseReady =
    credentialMatchesField(config.hub_url ?? '', hubState?.storedUrl) && !rePairExpanded

  // 校验绑定安全策略
  const isLAN = config.bind === '0.0.0.0'
  const bindPolicyError = useMemo(() => {
    if (isLAN && !(config.fe_token ?? '').trim()) {
      return '绑定到局域网（0.0.0.0）必须设置本机钥匙（FE_TOKEN），以防局域网未授权访问。'
    }
    return null
  }, [isLAN, config.fe_token])

  const handleSave = async () => {
    if (bindPolicyError) {
      pushToast('配置校验不通过: ' + bindPolicyError)
      return
    }

    const needsRestart = saveNeedsRestart(initialConfig, config)
    setSaving(true)
    setSaveStatus('')
    try {
      const res = await transport
        .apiFetch('/api/host/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        })
        .then((r) => r.json())

      if (!res.ok) {
        throw new Error(res.error || '保存失败')
      }

      setInitialConfig(res.config)
      setConfig(res.config)
      setSaveStatus(saveStatusText(needsRestart))
    } catch (e) {
      pushToast('保存失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  // 立即配对
  const handlePair = async () => {
    if (!pairCode.trim()) {
      pushToast('请输入 6 位 Hub 配对码')
      return
    }
    setActionBusy(true)
    try {
      const res = await transport
        .apiFetch('/api/hub/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hubUrl: config.hub_url,
            code: pairCode.trim(),
          }),
        })
        .then((r) => r.json())

      if (!res.ok) {
        throw new Error(res.error || '配对失败')
      }
      setHubState(res.hub)
      setPairCode('')
      setRePairExpanded(false)
      pushToast(`配对成功，已连上 Hub：${res.hub.hubUrl}`)
    } catch (e) {
      pushToast('配对失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setActionBusy(false)
    }
  }

  // 立即复用已有凭证
  const handleReuse = async () => {
    setActionBusy(true)
    try {
      const res = await transport
        .apiFetch('/api/hub/reuse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hubUrl: config.hub_url }),
        })
        .then((r) => r.json())

      if (!res.ok) {
        throw new Error(res.error || '复用凭证连接失败')
      }
      setHubState(res.hub)
      pushToast(`已通过存留凭证连接到 Hub：${res.hub.hubUrl}`)
    } catch (e) {
      pushToast('连接失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setActionBusy(false)
    }
  }

  // 断开 Hub
  const handleDisconnect = async () => {
    setActionBusy(true)
    try {
      const res = await transport
        .apiFetch('/api/hub/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        .then((r) => r.json())

      if (!res.ok) {
        throw new Error(res.error || '断开失败')
      }
      setHubState(res.hub)
      setConfig((prev) => ({ ...prev, hub_url: '' }))
      pushToast('已断开 Hub，当前已恢复为仅本机独立模式')
    } catch (e) {
      pushToast('断开失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setActionBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gn-bg-base text-gn-muted font-ui">
        <RefreshCw size={20} className="animate-spin mr-2 text-gn-cyan" />
        加载系统设置…
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gn-bg-base text-gn-fg font-ui select-none">
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-8 space-y-8">
        <h1 className="text-[15px] font-medium text-gn-fg">Capri 系统设置</h1>
        {/* 1. 本机配置 */}
        <section className="rounded-lg border border-gn-prompt-border bg-gn-bg-dark/40 p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-gn-prompt-border pb-3">
            <Radio size={16} className="text-gn-blue" />
            <h2 className="text-[14px] font-medium text-gn-fg">本机服务 (Host)</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] text-gn-muted mb-1.5">本机代号 (显示名)</label>
              <input
                type="text"
                value={config.host_name ?? ''}
                onChange={(e) => setConfig({ ...config, host_name: e.target.value })}
                placeholder="例如 MacBook-Pro / Windows-PC"
                className="w-full rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-[13px] text-gn-fg outline-none focus:border-gn-cyan"
              />
              <p className="mt-1 text-[11px] text-gn-muted">网页端和 Hub 列表上的设备标识名称</p>
            </div>

            <div>
              <label className="block text-[12px] text-gn-muted mb-1.5">Host ID (固定标识)</label>
              <input
                type="text"
                value={config.host_id ?? ''}
                readOnly
                className="w-full rounded border border-gn-prompt-border bg-gn-bg-highlight/50 px-3 py-1.5 text-[13px] text-gn-muted font-mono outline-none cursor-not-allowed"
              />
              <p className="mt-1 text-[11px] text-gn-muted">系统自动生成，历史会话关联标识</p>
            </div>

            <div>
              <label className="block text-[12px] text-gn-muted mb-1.5">监听端口</label>
              <input
                type="number"
                value={config.port ?? 8765}
                onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value, 10) || 8765 })}
                className="w-full rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-[13px] text-gn-fg font-mono outline-none focus:border-gn-cyan"
              />
            </div>

            <div>
              <label className="block text-[12px] text-gn-muted mb-1.5">访问范围</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, bind: '127.0.0.1' })}
                  className={`flex-1 rounded py-1.5 text-[12px] border transition ${
                    !isLAN
                      ? 'border-gn-cyan bg-gn-cyan/10 text-gn-cyan font-medium'
                      : 'border-gn-prompt-border bg-gn-bg-base text-gn-muted hover:text-gn-fg'
                  }`}
                >
                  仅本机 (127.0.0.1)
                </button>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, bind: '0.0.0.0' })}
                  className={`flex-1 rounded py-1.5 text-[12px] border transition ${
                    isLAN
                      ? 'border-gn-cyan bg-gn-cyan/10 text-gn-cyan font-medium'
                      : 'border-gn-prompt-border bg-gn-bg-base text-gn-muted hover:text-gn-fg'
                  }`}
                >
                  局域网开放 (0.0.0.0)
                </button>
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="block text-[12px] text-gn-muted mb-1.5">
                本机访问钥匙 (FE_TOKEN)
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={config.fe_token ?? ''}
                  onChange={(e) => setConfig({ ...config, fe_token: e.target.value })}
                  placeholder="仅本机访问可留空；局域网访问必填"
                  className={`w-full rounded border bg-gn-bg-base px-3 py-1.5 pr-10 text-[13px] text-gn-fg font-mono outline-none ${
                    bindPolicyError ? 'border-gn-red' : 'border-gn-prompt-border focus:border-gn-cyan'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gn-muted hover:text-gn-fg"
                >
                  {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {bindPolicyError && <p className="mt-1 text-[11px] text-gn-red">{bindPolicyError}</p>}
            </div>
          </div>
        </section>

        {/* 2. Hub 中继连接 */}
        <section className="rounded-lg border border-gn-prompt-border bg-gn-bg-dark/40 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-gn-prompt-border pb-3">
            <div className="flex items-center gap-2">
              <Globe size={16} className="text-gn-green" />
              <h2 className="text-[14px] font-medium text-gn-fg">Hub 中继连接</h2>
            </div>
            {/* 状态徽标 */}
            {hubState && (
              <div className="flex items-center gap-2 text-[12px]">
                {hubState.connected ? (
                  <span className="flex items-center gap-1.5 text-gn-green">
                    <span className="h-2 w-2 rounded-full bg-gn-green animate-pulse" />
                    已连接 · {hubState.transport?.toUpperCase() || 'ONLINE'} (
                    {formatDuration(hubState.uptimeSec)})
                  </span>
                ) : hubState.configured ? (
                  hubState.paired ? (
                    <span className="flex items-center gap-1.5 text-gn-yellow">
                      <span className="h-2 w-2 rounded-full bg-gn-yellow" />
                      连接中… {hubState.lastError ? `(${hubState.lastError})` : ''}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-gn-yellow">
                      <span className="h-2 w-2 rounded-full bg-gn-yellow" />
                      未配对
                    </span>
                  )
                ) : (
                  <span className="text-gn-muted">纯本机模式 (未配置 Hub)</span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-[12px] text-gn-muted mb-1.5">Hub 服务器地址</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={config.hub_url ?? ''}
                  onChange={(e) => setConfig({ ...config, hub_url: e.target.value })}
                  placeholder="https://hub.example.com 或 http://192.168.1.10:8787"
                  className="flex-1 rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-[13px] text-gn-fg outline-none focus:border-gn-cyan"
                />
                {normalizeHubURL(hubState?.hubUrl || config.hub_url || '') && (
                  <button
                    type="button"
                    onClick={() => {
                      const url = normalizeHubURL(hubState?.hubUrl || config.hub_url || '')
                      if (url) window.open(url, '_blank', 'noopener,noreferrer')
                    }}
                    className="rounded border border-gn-prompt-border px-3 py-1.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight"
                  >
                    打开 Hub
                  </button>
                )}
                {hubState?.configured && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void handleDisconnect()}
                    className="flex items-center gap-1 rounded border border-gn-red/40 bg-gn-red/10 px-3 py-1.5 text-[12px] text-gn-red hover:bg-gn-red/20 disabled:opacity-50"
                  >
                    <Unlink size={13} />
                    <span>断开 Hub</span>
                  </button>
                )}
              </div>
            </div>

            {/* 凭证诊断与配对操作 */}
            {hubState && reuseReady ? (
              <div className="rounded border border-gn-green/30 bg-gn-green/5 p-3.5 space-y-2">
                <p className="text-[12px] text-gn-fg flex items-center gap-1.5">
                  <Check size={14} className="text-gn-green" />
                  <span>
                    本机已存储可复用的 Hub 凭证：
                    <code className="text-gn-green font-mono">{hubState.storedUrl}</code>
                  </span>
                </p>
                <div className="flex gap-2.5 pt-1">
                  {!hubState.connected && (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => void handleReuse()}
                      className="rounded bg-gn-green/20 px-3 py-1 text-[12px] font-medium text-gn-green hover:bg-gn-green/30 disabled:opacity-50"
                    >
                      立即连上 (直接复用凭证)
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setRePairExpanded(true)}
                    className="rounded border border-gn-prompt-border px-3 py-1 text-[12px] text-gn-muted hover:text-gn-fg"
                  >
                    输入新配对码重新配对…
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                <label className="block text-[12px] text-gn-muted">输入 Hub 配对码</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={pairCode}
                    onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                    placeholder="6 位配对码 (如 ABC234)"
                    className="w-48 rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-[13px] font-mono tracking-widest text-gn-fg outline-none focus:border-gn-cyan"
                  />
                  <button
                    type="button"
                    disabled={actionBusy || !pairCode.trim()}
                    onClick={() => void handlePair()}
                    className="flex items-center gap-1.5 rounded bg-gn-cyan px-4 py-1.5 text-[13px] font-medium text-gn-bg-dark hover:opacity-90 disabled:opacity-50"
                  >
                    <span>立即配对</span>
                  </button>
                  {rePairExpanded && (
                    <button
                      type="button"
                      onClick={() => {
                        setRePairExpanded(false)
                        setPairCode('')
                      }}
                      className="rounded px-3 py-1.5 text-[12px] text-gn-muted hover:text-gn-fg"
                    >
                      取消
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-gn-muted">
                  配对码可在 Hub 的控制台或日志（GET /api/pairing）中获取，15 分钟内有效。
                </p>
              </div>
            )}
          </div>
        </section>

        {/* 3. 出网代理 */}
        <section className="rounded-lg border border-gn-prompt-border bg-gn-bg-dark/40 p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-gn-prompt-border pb-3">
            <Shield size={16} className="text-gn-yellow" />
            <h2 className="text-[14px] font-medium text-gn-fg">出网代理 (Proxy)</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] text-gn-muted mb-1.5">代理服务器地址</label>
              <input
                type="text"
                value={config.proxy ?? ''}
                onChange={(e) => setConfig({ ...config, proxy: e.target.value })}
                placeholder="http://127.0.0.1:7890 或 socks5://..."
                className="w-full rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-[13px] font-mono text-gn-fg outline-none focus:border-gn-cyan"
              />
            </div>

            <div>
              <label className="block text-[12px] text-gn-muted mb-1.5">排除地址 (No Proxy)</label>
              <input
                type="text"
                value={config.no_proxy ?? ''}
                onChange={(e) => setConfig({ ...config, no_proxy: e.target.value })}
                placeholder="localhost,127.0.0.1,.local"
                className="w-full rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-[13px] font-mono text-gn-fg outline-none focus:border-gn-cyan"
              />
            </div>
          </div>
          <p className="text-[11px] text-gn-muted leading-relaxed">
            设置后 Hub 中继与本机拉起的 Grok Agent 均会遵循此代理出网。留空时系统未开代理则直连。
          </p>
        </section>

        {/* 4. Agent 引擎环境 */}
        <section className="rounded-lg border border-gn-prompt-border bg-gn-bg-dark/40 p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-gn-prompt-border pb-3">
            <Cpu size={16} className="text-gn-magenta" />
            <h2 className="text-[14px] font-medium text-gn-fg">Agent 引擎环境</h2>
          </div>

          <div>
            <label className="block text-[12px] text-gn-muted mb-1.5">
              Grok 可执行文件路径 (grok_bin)
            </label>
            <input
              type="text"
              value={config.grok_bin ?? ''}
              onChange={(e) => setConfig({ ...config, grok_bin: e.target.value })}
              placeholder="留空自动探测 (~/.local/bin/grok 等)"
              className="w-full rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-[13px] font-mono text-gn-fg outline-none focus:border-gn-cyan"
            />
            <p className="mt-1 text-[11px] text-gn-muted">
              指定 Grok CLI 二进制文件的绝对路径。留空则在启动时自动寻找。
            </p>
          </div>
        </section>

        {/* 5. 系统偏好 */}
        <section className="rounded-lg border border-gn-prompt-border bg-gn-bg-dark/40 p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-gn-prompt-border pb-3">
            <Power size={16} className="text-gn-plan" />
            <h2 className="text-[14px] font-medium text-gn-fg">系统偏好</h2>
          </div>

          <div className="space-y-3.5">
            <label className="flex items-center justify-between cursor-pointer">
              <div className="space-y-0.5">
                <span className="text-[13px] text-gn-fg">打开应用时启动 Host</span>
                <p className="text-[11px] text-gn-muted">启动 Capri 托盘/菜单栏时自动启动 Host 引擎。</p>
              </div>
              <input
                type="checkbox"
                checked={config.start_host_on_launch ?? true}
                onChange={(e) => setConfig({ ...config, start_host_on_launch: e.target.checked })}
                className="h-4 w-4 rounded accent-gn-cyan cursor-pointer"
              />
            </label>
          </div>
        </section>
      </main>

      <footer className="border-t border-gn-prompt-border bg-gn-bg-base px-6 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-4">
          <p className="min-w-0 flex-1 text-[12px] leading-snug" role="status">
            {!formDirty && saveStatus ? (
              <span className="text-gn-green">{saveStatus}</span>
            ) : requiresRestart ? (
              <span className="text-gn-yellow">这些修改保存后需要手动重启 Host 才生效。</span>
            ) : null}
          </p>
          <button
            type="button"
            disabled={saving || !!bindPolicyError}
            onClick={() => void handleSave()}
            className="flex shrink-0 items-center gap-1.5 rounded bg-gn-bg-highlight px-3 py-1.5 text-[13px] font-medium text-gn-fg transition hover:bg-gn-bg-hover disabled:opacity-50"
          >
            <Save size={14} />
            <span>{saving ? '保存中…' : '保存'}</span>
          </button>
        </div>
      </footer>
    </div>
  )
}
