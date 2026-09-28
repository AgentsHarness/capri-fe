import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ArrowRightLeft, CheckCircle2, KeyRound, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { transport } from '../api/client'
import type { CustomModelConfig, HostInfo } from '../api/types'
import {
  buildImportValues,
  classifyImportRows,
  hasSecretFields,
  SECRET_FIELDS,
  type ImportRow,
  type ImportStatus,
} from '../lib/importModels'
import { compareCustomModels } from '../lib/quickAddModels'
import { pushToast } from '../store/toast'

/**
 * 「从其他 Host 导入自定义模型」——把源 Host 的 `[model.*]` 配置节批量复制到
 * 当前 Host（导入目标恒为面板所属的这台）。
 *
 * 安全口径：
 * - 读取源 Host 走 hub 中继（`listCustomModelsFromHost`），写入仍只打当前
 *   Host 的 `/api/custom-model`——不扩大写入面；
 * - 目标上已存在的条目默认**跳过**，必须逐条勾选才覆盖；同 slug 属于别的 id
 *   （host 必拒）与缺必填字段的条目直接禁用；
 * - 密钥字段默认复制，可用开关关掉；关掉且该条为覆盖时保留目标原值，
 *   不会把目标上的凭据冲空。
 */
export function ImportModelsFromHostModal({
  isOpen,
  onClose,
  targetHostId,
  targetHostName,
  hosts,
  onImported,
}: {
  isOpen: boolean
  onClose: () => void
  /** 导入目标：当前选中 Host（写入只打它）。 */
  targetHostId: string
  targetHostName: string
  /** 全部已配对 Host（源候选，剔除目标自己）。 */
  hosts: HostInfo[]
  onImported: () => void
}) {
  const sources = useMemo(
    () => hosts.filter((h) => h.hostId !== targetHostId),
    [hosts, targetHostId],
  )
  const [sourceHostId, setSourceHostId] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(true)

  const [sourceRows, setSourceRows] = useState<CustomModelConfig[]>([])
  const [targetRows, setTargetRows] = useState<CustomModelConfig[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  // 打开时选第一台在线源；离线源也列出但标注，由用户决定。
  useEffect(() => {
    if (!isOpen) return
    setSourceHostId((cur) => {
      if (cur && sources.some((s) => s.hostId === cur)) return cur
      return (sources.find((s) => s.online) ?? sources[0])?.hostId ?? ''
    })
  }, [isOpen, sources])

  const classified: ImportRow[] = useMemo(
    () => classifyImportRows(sourceRows, targetRows),
    [sourceRows, targetRows],
  )

  // 打开 / 换源即拉两侧列表：目标列表**重新拉**，不用面板的缓存——
  // 覆盖判断必须建立在目标此刻的真实配置上。默认勾选在同一批状态里算好
  // （而不是等下一次渲染的 effect）：否则有一帧「数据已到、勾选还没到」，
  // 用户会看到全不勾的列表。rowErrors 不在这里清：部分失败后要靠它把
  // 失败原因留在行上（清理由打开 / 换源负责）。
  const load = useCallback(async () => {
    if (!sourceHostId) return
    setLoading(true)
    setLoadError(null)
    try {
      const [src, tgt] = await Promise.all([
        transport.listCustomModelsFromHost(sourceHostId),
        transport.listCustomModels(),
      ])
      const sortedSrc = [...src].sort(compareCustomModels)
      const sortedTgt = [...tgt].sort(compareCustomModels)
      setSourceRows(sortedSrc)
      setTargetRows(sortedTgt)
      // 只有「目标上不存在」的条目默认勾选；覆盖必须用户逐条手动勾。
      setSelected(
        new Set(
          classifyImportRows(sortedSrc, sortedTgt)
            .filter((r) => r.status === 'new')
            .map((r) => r.id),
        ),
      )
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setSourceRows([])
      setTargetRows([])
      setSelected(new Set())
    } finally {
      setLoading(false)
    }
  }, [sourceHostId])

  useEffect(() => {
    if (!isOpen || !sourceHostId) return
    setRowErrors({})
    void load()
  }, [isOpen, sourceHostId, load])

  // ESC 关闭（保存中不响应，避免半途丢掉结果面板）。
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, saving, onClose])

  const selectableIds = useMemo(
    () => classified.filter((r) => r.status === 'new' || r.status === 'overwrite').map((r) => r.id),
    [classified],
  )
  const overwriteCount = useMemo(
    () => classified.filter((r) => selected.has(r.id) && r.status === 'overwrite').length,
    [classified, selected],
  )

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleImport = async () => {
    const picked = classified.filter((r) => selected.has(r.id))
    if (picked.length === 0) return
    setSaving(true)
    setRowErrors({})
    const failures: Record<string, string> = {}
    let ok = 0
    // 顺序写：host 侧是「读 config.toml → 改一节 → 原子写回」，并发会互相覆盖。
    for (const row of picked) {
      const targetRow = targetRows.find((t) => t.id === row.id)
      try {
        const values = buildImportValues(row, targetRow, includeSecrets)
        await transport.upsertCustomModel({ id: row.id, ...values } as CustomModelConfig)
        ok++
      } catch (e) {
        failures[row.id] = e instanceof Error ? e.message : String(e)
      }
    }
    setSaving(false)
    setRowErrors(failures)
    const failedCount = Object.keys(failures).length
    if (failedCount === 0) {
      pushToast(`已从「${sourceName}」导入 ${ok} 个模型并热加载`)
      onImported()
      onClose()
    } else {
      pushToast(`导入完成：成功 ${ok} 个，失败 ${failedCount} 个`)
      onImported()
      void load()
    }
  }

  if (!isOpen) return null

  const sourceName =
    hosts.find((h) => h.hostId === sourceHostId)?.hostName ?? (sourceHostId || '源 Host')

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center gn-modal-dim p-2 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <div
        className="gn-modal-panel flex w-full max-w-[760px] flex-col max-h-[90dvh] sm:max-h-[85vh] text-[12px]"
        role="dialog"
        aria-modal="true"
        aria-label="从其他 Host 导入自定义模型"
      >
        <header className="gn-modal-header">
          <ArrowRightLeft className="h-4 w-4 text-gn-cyan shrink-0" aria-hidden />
          <span className="text-[13px] font-bold text-gn-fg">从其他 Host 导入模型</span>
          <span className="hidden sm:inline text-[11px] text-gn-muted">
            （复制对方的 [model.*] 配置到本机）
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="ml-auto rounded p-0.5 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
            title="关闭 (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2.5 sm:px-4 sm:py-3 sm:space-y-3">
          {/* 源 / 目标 */}
          <div className="rounded border border-gn-prompt-border/60 bg-gn-bg-dark/40 p-3 space-y-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-[10.5px] text-gn-muted">源 Host（从它读取配置）</span>
                <select
                  value={sourceHostId}
                  onChange={(e) => setSourceHostId(e.target.value)}
                  disabled={saving}
                  className="mt-0.5 w-full rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active disabled:opacity-50"
                >
                  {sources.length === 0 && <option value="">没有其他 Host 可读</option>}
                  {sources.map((h) => (
                    <option key={h.hostId} value={h.hostId}>
                      {h.hostName}
                      {h.online ? '' : '（离线）'}
                    </option>
                  ))}
                </select>
              </label>
              <div className="block">
                <span className="text-[10.5px] text-gn-muted">导入到</span>
                <div className="mt-0.5 truncate rounded border border-gn-prompt-border/60 bg-gn-bg-base/50 px-2 py-1 text-[11.5px] text-gn-fg2">
                  {targetHostName}（当前 Host）
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2 pt-0.5 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex items-start gap-2 text-[10.5px] text-gn-muted">
                <input
                  type="checkbox"
                  checked={includeSecrets}
                  disabled={saving}
                  onChange={(e) => setIncludeSecrets(e.target.checked)}
                  className="mt-0.5 accent-gn-magenta cursor-pointer"
                />
                <span>
                  同时复制密钥类字段（{SECRET_FIELDS.join(' / ')}）。
                  <span className="block text-gn-gutter">
                    关掉后不写这些字段；覆盖已有条目时保留目标原有密钥。
                  </span>
                </span>
              </label>
              <button
                type="button"
                disabled={loading || !sourceHostId || saving}
                onClick={() => void load()}
                className="flex w-full items-center justify-center gap-1.5 rounded bg-gn-bg-highlight px-3 py-1.5 text-[11.5px] font-medium text-gn-fg hover:bg-gn-bg-hover disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:py-1"
              >
                {loading ? (
                  <>
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    <span>读取中…</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3 w-3 text-gn-gutter" />
                    <span>重新读取</span>
                  </>
                )}
              </button>
            </div>

            {loadError && (
              <div className="rounded border border-gn-red/40 bg-gn-diff-del-bg/50 px-2.5 py-1.5 text-[11px] text-gn-red">
                <span className="font-semibold">读取失败：</span> {loadError}
                <div className="mt-1 text-[10px] text-gn-muted">
                  提示：源 Host 离线或未通过 Hub 连接时读不到配置。
                </div>
              </div>
            )}
          </div>

          {/* 列表 */}
          {classified.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-col gap-2 border-b border-gn-prompt-border/40 pb-1.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[10.5px] text-gn-muted sm:text-[11px]">
                  「{sourceName}」共 {classified.length} 个配置节，已选{' '}
                  <strong className="text-gn-fg">{selected.size}</strong> 个
                  {overwriteCount > 0 && (
                    <span className="text-gn-orange">（含 {overwriteCount} 个覆盖）</span>
                  )}
                </span>
                <div className="flex items-center gap-1.5 text-[10.5px]">
                  <button
                    type="button"
                    onClick={() => setSelected(new Set(classified.filter((r) => r.status === 'new').map((r) => r.id)))}
                    className="rounded px-1.5 py-0.5 text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    全选新建
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelected(new Set(selectableIds))}
                    className="rounded px-1.5 py-0.5 text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="rounded px-1.5 py-0.5 text-gn-muted hover:text-gn-fg"
                  >
                    清空
                  </button>
                </div>
              </div>

              <div className="max-h-[42vh] sm:max-h-[340px] overflow-y-auto rounded border border-gn-prompt-border/60 bg-gn-bg-dark/30">
                {classified.map((row) => {
                  const disabled = row.status === 'invalid' || row.status === 'slug-conflict'
                  const isSelected = selected.has(row.id)
                  const err = rowErrors[row.id]
                  return (
                    <div
                      key={row.id}
                      className={`flex items-start gap-2.5 border-b border-gn-prompt-border/30 px-3 py-2 last:border-b-0 transition-[background-color] duration-150 ${
                        isSelected ? 'bg-gn-bg-highlight/30' : 'hover:bg-gn-bg-dark/60'
                      } ${disabled ? 'opacity-60' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={disabled || saving}
                        onChange={() => toggle(row.id)}
                        className="mt-1 accent-gn-magenta cursor-pointer disabled:cursor-not-allowed"
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-gn-fg text-[12px]">
                            {row.cfg.name || row.id}
                          </span>
                          <span className="font-mono text-[11px] text-gn-muted">{row.cfg.model}</span>
                          <StatusBadge status={row.status} />
                          {hasSecretFields(row.cfg) && (
                            <span
                              className="flex items-center gap-0.5 rounded bg-gn-yellow/15 px-1.5 py-px text-[9.5px] text-gn-yellow"
                              title={`含密钥类字段：${SECRET_FIELDS.join(' / ')}`}
                            >
                              <KeyRound className="h-2.5 w-2.5" />
                              <span>含密钥</span>
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-[10.5px] text-gn-gutter" title={row.cfg.base_url}>
                          [model.{row.id}] · {row.cfg.base_url}
                        </div>
                        {row.reason && (
                          <div className="text-[10px] text-gn-orange">{row.reason}</div>
                        )}
                        {err && (
                          <div className="text-[10px] text-gn-red">写入失败：{err}</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!loading && !loadError && sourceHostId && classified.length === 0 && (
            <div className="rounded border border-gn-prompt-border/40 bg-gn-bg-dark/30 p-3 text-center text-[11.5px] text-gn-muted">
              「{sourceName}」上没有可导入的自定义模型。
            </div>
          )}
        </div>

        <footer className="gn-modal-footer flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-gn-muted">
            <span className="truncate">
              写入目标 Host 的 ~/.grok/config.toml（agent 热加载生效）；密钥只在本次请求体里传输。
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded px-2.5 py-1 text-[11px] text-gn-muted hover:text-gn-fg disabled:opacity-40 sm:px-3 sm:text-[12px]"
            >
              取消
            </button>
            <button
              type="button"
              aria-label={`导入所选模型 (${selected.size})`}
              disabled={saving || selected.size === 0}
              onClick={() => void handleImport()}
              className="flex items-center gap-1 rounded bg-gn-bg-highlight px-3 py-1 text-[11.5px] font-semibold text-gn-fg hover:bg-gn-bg-hover disabled:cursor-not-allowed disabled:opacity-40 sm:px-3.5 sm:text-[12px]"
            >
              {saving ? (
                '正在写入…'
              ) : (
                <>
                  <span className="hidden sm:inline">
                    导入所选模型 ({selected.size}
                    {overwriteCount > 0 ? `，覆盖 ${overwriteCount}` : ''})
                  </span>
                  <span className="sm:hidden">导入 ({selected.size})</span>
                </>
              )}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function StatusBadge({ status }: { status: ImportStatus }) {
  switch (status) {
    case 'new':
      return (
        <span className="flex items-center gap-0.5 rounded bg-gn-green/15 px-1.5 py-px text-[9.5px] font-medium text-gn-green">
          <CheckCircle2 className="h-2.5 w-2.5" />
          <span>新建</span>
        </span>
      )
    case 'overwrite':
      return (
        <span className="rounded bg-gn-orange/15 px-1.5 py-px text-[9.5px] font-medium text-gn-orange">
          将覆盖
        </span>
      )
    case 'slug-conflict':
      return (
        <span className="flex items-center gap-0.5 rounded bg-gn-red/15 px-1.5 py-px text-[9.5px] font-medium text-gn-red">
          <AlertTriangle className="h-2.5 w-2.5" />
          <span>slug 冲突</span>
        </span>
      )
    default:
      return (
        <span className="rounded bg-gn-prompt-border/40 px-1.5 py-px text-[9.5px] text-gn-muted">
          无效
        </span>
      )
  }
}
