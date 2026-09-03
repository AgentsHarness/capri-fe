import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Boxes, Eye, EyeOff, LoaderCircle, RefreshCw, Search, Sparkles, X, Zap } from 'lucide-react'
import { transport } from '../api/client'
import type { CustomModelConfig } from '../api/types'
import { pushToast } from '../store/toast'
import {
  extractEndpoints,
  generateModelConfigKey,
  fetchRemoteModels,
  getModelsDevMap,
  type DiscoveredModel,
} from '../lib/quickAddModels'

export function QuickAddModelsModal({
  isOpen,
  onClose,
  existingModels,
  onAdded,
}: {
  isOpen: boolean
  onClose: () => void
  existingModels: CustomModelConfig[]
  onAdded: () => void
}) {
  const endpoints = useMemo(() => extractEndpoints(existingModels), [existingModels])
  const [selectedEndpointKey, setSelectedEndpointKey] = useState<string>(() =>
    endpoints[0]?.key || 'custom',
  )
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiBackend, setApiBackend] = useState<CustomModelConfig['api_backend']>('chat_completions')
  const [showKey, setShowKey] = useState(false)

  // 当选择已有端点时自动填充；切到自定义端点时清空上次残留的 Base URL / API Key
  useEffect(() => {
    if (selectedEndpointKey === 'custom') {
      setCustomBaseUrl('')
      setApiKey('')
      return
    }
    const ep = endpoints.find((e) => e.key === selectedEndpointKey)
    if (ep) {
      setCustomBaseUrl(ep.baseUrl)
      setApiKey(ep.apiKey || '')
      if (ep.apiBackend) setApiBackend(ep.apiBackend)
    }
  }, [selectedEndpointKey, endpoints])

  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([])
  const [selectedRemoteIds, setSelectedRemoteIds] = useState<Set<string>>(new Set())
  const [searchFilter, setSearchFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [modelsDevLoading, setModelsDevLoading] = useState(false)

  // ESC 关闭
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  const effectiveBaseUrl = selectedEndpointKey === 'custom' ? customBaseUrl : customBaseUrl
  const existingKeySet = useMemo(() => new Set(existingModels.map((m) => m.id)), [existingModels])

  // 执行拉取
  const handleFetch = async () => {
    const urlToFetch = effectiveBaseUrl.trim()
    if (!urlToFetch) {
      setFetchError('Base URL 不能为空')
      return
    }

    setFetching(true)
    setFetchError(null)
    setDiscoveredModels([])
    setSelectedRemoteIds(new Set())

    try {
      // 启动 models.dev 预取
      setModelsDevLoading(true)
      const [rawModels, devMap] = await Promise.all([
        fetchRemoteModels(urlToFetch, apiKey),
        getModelsDevMap().finally(() => setModelsDevLoading(false)),
      ])

      const assignedKeys = new Set(existingKeySet)
      const list: DiscoveredModel[] = rawModels.map((m) => {
        const configKey = generateModelConfigKey(m.id, assignedKeys)
        assignedKeys.add(configKey)

        // 尝试从 models.dev 匹配丰富元数据
        const matched =
          devMap.get(m.id) ||
          devMap.get(m.id.toLowerCase()) ||
          devMap.get(m.id.split('/').pop()?.toLowerCase() || '')

        const name = matched?.name || m.name || m.id
        const contextWindow =
          matched?.limit?.context || m.context_window || 200000
        const maxCompletionTokens = matched?.limit?.output
        const supportsReasoning = Boolean(matched?.reasoning)

        let reasoningEfforts: DiscoveredModel['reasoningEfforts'] = undefined
        if (matched?.reasoning_options) {
          const effortOpt = matched.reasoning_options.find((o) => o.type === 'effort')
          if (effortOpt?.values) {
            reasoningEfforts = effortOpt.values.map((v) => ({
              value: v,
              label: v,
            }))
          }
        }

        const isExisting = existingModels.some(
          (em) =>
            em.base_url?.trim().replace(/\/+$/, '') === urlToFetch.replace(/\/+$/, '') &&
            (em.model === m.id || em.id === configKey),
        )

        return {
          remoteId: m.id,
          configKey,
          name,
          contextWindow,
          maxCompletionTokens,
          supportsReasoning,
          reasoningEfforts,
          isExisting,
          matchedDev: Boolean(matched),
        }
      })

      setDiscoveredModels(list)
      // 默认全选未添加的模型
      const initialSelected = new Set(
        list.filter((item) => !item.isExisting).map((item) => item.remoteId),
      )
      setSelectedRemoteIds(initialSelected)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetching(false)
    }
  }

  // 搜索过滤后的模型列表
  const filteredModels = useMemo(() => {
    if (!searchFilter.trim()) return discoveredModels
    const q = searchFilter.trim().toLowerCase()
    return discoveredModels.filter(
      (m) =>
        m.remoteId.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.configKey.toLowerCase().includes(q),
    )
  }, [discoveredModels, searchFilter])

  // 切换单个选择
  const toggleSelect = (remoteId: string) => {
    setSelectedRemoteIds((prev) => {
      const next = new Set(prev)
      if (next.has(remoteId)) {
        next.delete(remoteId)
      } else {
        next.add(remoteId)
      }
      return next
    })
  }

  // 快速选择动作
  const selectAllUnadded = () => {
    const unadded = discoveredModels.filter((m) => !m.isExisting).map((m) => m.remoteId)
    setSelectedRemoteIds(new Set(unadded))
  }

  const selectAll = () => {
    setSelectedRemoteIds(new Set(discoveredModels.map((m) => m.remoteId)))
  }

  const deselectAll = () => {
    setSelectedRemoteIds(new Set())
  }

  // 修改建议的配置节键名
  const updateConfigKey = (remoteId: string, newKey: string) => {
    setDiscoveredModels((prev) =>
      prev.map((m) => (m.remoteId === remoteId ? { ...m, configKey: newKey } : m)),
    )
  }

  // 保存所选模型
  const handleSaveSelected = async () => {
    if (selectedRemoteIds.size === 0) return
    setSaving(true)
    let count = 0
    const url = effectiveBaseUrl.trim()
    try {
      const selectedItems = discoveredModels.filter((m) => selectedRemoteIds.has(m.remoteId))
      for (const item of selectedItems) {
        const cfg: CustomModelConfig = {
          id: item.configKey.trim() || item.remoteId,
          model: item.remoteId,
          base_url: url,
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
          ...(apiBackend ? { api_backend: apiBackend } : {}),
          name: item.name,
          context_window: item.contextWindow,
          ...(item.maxCompletionTokens ? { max_completion_tokens: item.maxCompletionTokens } : {}),
          ...(item.supportsReasoning ? { supports_reasoning_effort: true } : {}),
          ...(item.reasoningEfforts && item.reasoningEfforts.length > 0
            ? { reasoning_efforts: item.reasoningEfforts }
            : {}),
        }
        await transport.upsertCustomModel(cfg)
        count++
      }
      pushToast(`已成功添加 ${count} 个自定义模型并热加载`)
      onAdded()
      onClose()
    } catch (e) {
      pushToast(`添加失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center gn-modal-dim p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="gn-modal-panel flex w-full max-w-[700px] flex-col max-h-[85vh] text-[12px]"
        role="dialog"
        aria-modal="true"
        aria-label="快速添加自定义模型"
      >
        {/* Header */}
        <header className="gn-modal-header">
          <Zap className="h-4 w-4 text-gn-cyan shrink-0" aria-hidden />
          <span className="text-[13px] font-bold text-gn-fg">快速拉取并添加模型</span>
          <span className="text-[11px] text-gn-muted">（从 /v1/models 批量发现并写入配置）</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-0.5 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            title="关闭 (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* Step 1: 端点配置 */}
          <div className="rounded border border-gn-prompt-border/60 bg-gn-bg-dark/40 p-3 space-y-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gn-gutter font-semibold">
              <span>选择或配置目标端点</span>
              {endpoints.length > 0 && (
                <span className="normal-case text-gn-muted">
                  已从现有配置中发现 {endpoints.length} 个端点
                </span>
              )}
            </div>

            {endpoints.length > 0 && (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10.5px] text-gn-muted">端点来源</span>
                  <select
                    value={selectedEndpointKey}
                    onChange={(e) => setSelectedEndpointKey(e.target.value)}
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  >
                    {endpoints.map((ep) => (
                      <option key={ep.key} value={ep.key}>
                        {ep.baseUrl} ({ep.count} 个模型)
                      </option>
                    ))}
                    <option value="custom">＋ 输入自定义新端点…</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10.5px] text-gn-muted">API 后端类型</span>
                  <select
                    value={apiBackend}
                    onChange={(e) => setApiBackend(e.target.value as CustomModelConfig['api_backend'])}
                    className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  >
                    <option value="chat_completions">chat_completions (OpenAI 兼容)</option>
                    <option value="responses">responses</option>
                    <option value="messages">messages (Anthropic)</option>
                  </select>
                </label>
              </div>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="text-[10.5px] text-gn-muted">Base URL (例如 https://api.deepseek.com/v1)</span>
                <input
                  type="text"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                  className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] font-mono text-gn-fg outline-none focus:border-gn-prompt-border-active"
                />
              </label>
              <label className="block sm:col-span-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] text-gn-muted">API Key (用于 Bearer 鉴权，可选)</span>
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="flex items-center gap-1 text-[10px] text-gn-muted hover:text-gn-fg"
                  >
                    {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    <span>{showKey ? '隐藏' : '显示'}</span>
                  </button>
                </div>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] font-mono text-gn-fg outline-none focus:border-gn-prompt-border-active"
                />
              </label>
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-[10.5px] text-gn-gutter">
                请求时会自动尝试 `/models` 与 `/v1/models`，同时连接 models.dev 补全上下文与推理参数。
              </span>
              <button
                type="button"
                disabled={fetching || !customBaseUrl.trim()}
                onClick={() => void handleFetch()}
                className="rounded bg-gn-bg-highlight px-3 py-1 text-[11.5px] font-medium text-gn-fg hover:bg-gn-bg-hover disabled:cursor-not-allowed disabled:opacity-40 flex items-center gap-1.5"
              >
                {fetching ? (
                  <>
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    <span>正在拉取…</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3 w-3 text-gn-gutter" />
                    <span>获取模型列表</span>
                  </>
                )}
              </button>
            </div>

            {fetchError && (
              <div className="rounded border border-gn-red/40 bg-gn-diff-del-bg/50 px-2.5 py-1.5 text-[11px] text-gn-red">
                <span className="font-semibold">拉取失败：</span> {fetchError}
                <div className="mt-1 text-[10px] text-gn-muted">
                  提示：请确认端点是否支持跨域访问（CORS），或使用支持本地反代的网关端点。
                </div>
              </div>
            )}
          </div>

          {/* Step 2: 模型列表及筛选 */}
          {discoveredModels.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gn-prompt-border/40 pb-1.5">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gn-gutter" />
                    <input
                      type="text"
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      placeholder="搜索模型名称或 ID…"
                      className="w-48 rounded border border-gn-prompt-border bg-gn-bg-dark pl-6 pr-2 py-0.5 text-[11px] text-gn-fg outline-none focus:border-gn-prompt-border-active placeholder:text-gn-gutter"
                    />
                  </div>
                  <span className="text-[11px] text-gn-muted">
                    共 {discoveredModels.length} 个（已选 {selectedRemoteIds.size} 个）
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[10.5px]">
                  <button
                    type="button"
                    onClick={selectAllUnadded}
                    className="rounded px-1.5 py-0.5 text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    全选未添加
                  </button>
                  <button
                    type="button"
                    onClick={selectAll}
                    className="rounded px-1.5 py-0.5 text-gn-muted hover:text-gn-fg"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={deselectAll}
                    className="rounded px-1.5 py-0.5 text-gn-muted hover:text-gn-fg"
                  >
                    清空
                  </button>
                </div>
              </div>

              {modelsDevLoading && (
                <div className="text-[10px] text-gn-cyan flex items-center gap-1">
                  <span>ℹ 正在从 models.dev 加载扩展元数据…</span>
                </div>
              )}

              {/* 列表区域 */}
              <div className="max-h-[320px] overflow-y-auto rounded border border-gn-prompt-border/60 divide-y divide-gn-prompt-border/30 bg-gn-bg-dark/30">
                {filteredModels.length === 0 ? (
                  <div className="py-6 text-center text-[11px] text-gn-muted">
                    没有匹配的模型条目
                  </div>
                ) : (
                  filteredModels.map((item) => {
                    const isSelected = selectedRemoteIds.has(item.remoteId)
                    return (
                      <div
                        key={item.remoteId}
                        className={`flex items-start gap-2.5 px-3 py-2 transition-colors ${
 isSelected ? 'bg-gn-bg-highlight/30' : 'hover:bg-gn-bg-dark/60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(item.remoteId)}
                          className="mt-1 accent-gn-magenta cursor-pointer"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-gn-fg text-[12px]">
                              {item.name}
                            </span>
                            <span className="font-mono text-[11px] text-gn-muted">
                              {item.remoteId}
                            </span>
                            {item.isExisting && (
                              <span className="rounded bg-gn-prompt-border/40 px-1.5 py-px text-[9.5px] text-gn-muted">
                                已配置
                              </span>
                            )}
                            {item.matchedDev && (
                              <span className="flex items-center gap-0.5 rounded bg-gn-cyan/15 px-1.5 py-px text-[9.5px] font-medium text-gn-cyan">
                                <Boxes className="h-2.5 w-2.5" />
                                <span>models.dev</span>
                              </span>
                            )}
                            {item.supportsReasoning && (
                              <span className="flex items-center gap-0.5 rounded bg-gn-yellow/15 px-1.5 py-px text-[9.5px] text-gn-yellow font-medium">
                                <Sparkles className="h-2.5 w-2.5" />
                                <span>思考推理</span>
                              </span>
                            )}
                            <span className="rounded bg-gn-bg-dark border border-gn-prompt-border/40 px-1.5 py-px text-[9.5px] tabular-nums text-gn-fg2">
                              {Math.round(item.contextWindow / 1000)}k 上下文
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 text-[10px] text-gn-gutter font-mono">
                            <span>[model.</span>
                            <input
                              type="text"
                              value={item.configKey}
                              onChange={(e) => updateConfigKey(item.remoteId, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              className="rounded border border-gn-prompt-border/40 bg-gn-bg-base px-1 py-px text-[10.5px] text-gn-fg outline-none focus:border-gn-prompt-border"
                              style={{ width: `${Math.max(item.configKey.length + 2, 12)}ch` }}
                            />
                            <span>]</span>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="gn-modal-footer flex items-center justify-between">
          <div className="text-[11px] text-gn-muted">
            {discoveredModels.length > 0 ? (
              <span>
                将把勾选的 <strong className="text-gn-fg">{selectedRemoteIds.size}</strong> 个模型写入{' '}
                <code className="text-gn-fg2">~/.grok/config.toml</code>
              </span>
            ) : (
              <span>点击「获取模型列表」扫描端点</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1 text-[12px] text-gn-muted hover:text-gn-fg"
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving || selectedRemoteIds.size === 0}
              onClick={() => void handleSaveSelected()}
              className="rounded bg-gn-bg-highlight px-3.5 py-1 text-[12px] font-semibold text-gn-fg hover:bg-gn-bg-hover disabled:cursor-not-allowed disabled:opacity-40 flex items-center gap-1"
            >
              {saving ? '正在写入配置…' : `添加所选模型 (${selectedRemoteIds.size})`}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
