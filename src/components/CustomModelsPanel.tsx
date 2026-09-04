import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Search, Zap } from 'lucide-react'
import { transport } from '../api/client'
import type { CustomModelConfig } from '../api/types'
import { compareCustomModels } from '../lib/quickAddModels'
import { pushToast } from '../store/toast'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { QuickAddModelsModal } from './QuickAddModelsModal'

/**
 * 自定义模型面板（settings 内）—— `[model.<id>]` 可视化编辑。
 * 表单分「常用」（对齐实际配置最常见的字段，直接展示）与
 * 「高级设置」（折叠区，其余全部字段）；字段集合对齐 grok 源码的
 * `ConfigModelOverride`（xai-grok-shell/src/agent/config.rs）；
 * 保存写入 ~/.grok/config.toml，agent 的 config watcher 热加载后
 * 出现在模型列表（无需重启）。
 */

const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const API_BACKENDS = ['chat_completions', 'responses', 'messages'] as const

type BoolishMode = 'unset' | 'true' | 'false' | 'fixed'

/** 高级折叠区包含的字段（其余字段为常用字段，直接展示）。 */
const ADVANCED_KEYS: (keyof CustomModelConfig)[] = [
  'agent_type', 'system_prompt_label', 'description',
  'env_key', 'auth_provider', 'model_provider', 'api_base_url',
  'extra_headers', 'env_http_headers', 'query_params',
  'temperature', 'top_p', 'max_completion_tokens', 'max_retries',
  'inference_idle_timeout_secs', 'stream_tool_calls',
  'reasoning_effort', 'supports_reasoning_effort',
  'hidden', 'supported_in_api', 'use_concise', 'supports_backend_search',
  'show_model_fingerprint', 'auto_compact_threshold_percent',
  'compactions_remaining', 'compaction_at_tokens',
]

/** 字段是否“已设置”（非 undefined / 空串 / 空数组 / 空对象）。 */
const isSet = (v: unknown): boolean => {
  if (v === undefined || v === null || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

export function CustomModelsPanel() {

  const [models, setModels] = useState<CustomModelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<CustomModelConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const filteredModels = useMemo(() => {
    const list = [...models].sort(compareCustomModels)
    if (!searchQuery.trim()) return list
    const q = searchQuery.trim().toLowerCase()
    return list.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.model && m.model.toLowerCase().includes(q)) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        (m.base_url && m.base_url.toLowerCase().includes(q)),
    )
  }, [models, searchQuery])

  const refresh = useCallback(async () => {
    try {
      const list = await transport.listCustomModels()
      setModels([...list].sort(compareCustomModels))
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async (cfg: CustomModelConfig, oldId?: string) => {
    setSaving(true)
    try {
      const isRename = Boolean(oldId && oldId !== cfg.id)
      let defaultCleared = false
      if (isRename && oldId) {
        const delRes = await transport.deleteCustomModel(oldId)
        defaultCleared = Boolean(delRes?.defaultCleared)
      }
      await transport.upsertCustomModel(cfg)
      if (defaultCleared) {
        try {
          await transport.setDefaultModel(cfg.id, cfg.reasoning_effort)
        } catch {
          // 忽略默认模型重设失败，模型配置本身已保存成功
        }
      }
      pushToast(
        isRename
          ? `已更新模型 id 并保存「${cfg.name || cfg.id}」`
          : cfg.name || cfg.id
            ? `已保存自定义模型「${cfg.name || cfg.id}」`
            : '已保存',
      )
      setEditing(null)
      void refresh()
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const del = async (id: string) => {
    try {
      const r = await transport.deleteCustomModel(id)
      pushToast(
        r.defaultCleared
          ? `已删除「${id}」，并清除了默认模型设置`
          : `已删除自定义模型「${id}」`,
      )
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    }
    setConfirmDelete(null)
    void refresh()
  }

  return (
    <section className="py-1">
      <div className="flex items-center justify-between px-3 pt-2 pb-1 sm:px-4">
        <span className="text-[10px] uppercase tracking-wider text-gn-gutter">
          [model.*] 自定义模型<span className="hidden sm:inline">（BYOK）</span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setEditing({ id: '' })}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg focus:outline-none sm:py-px"
          >
            <Plus className="h-3 w-3 text-gn-gutter" />
            <span>新增模型</span>
          </button>
          <button
            type="button"
            onClick={() => setQuickAddOpen(true)}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg focus:outline-none sm:py-px"
            title="从已有或自定义端点拉取 /v1/models 批量添加"
          >
            <Zap className="h-3 w-3 text-gn-cyan" />
            <span>快速添加</span>
          </button>
        </div>
      </div>

      {editing ? (
        <ModelForm
          initial={editing}
          saving={saving}
          models={models}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : (
        <div className="space-y-1.5 px-3 pb-2 sm:px-4">
          {loading ? (
            <div className="py-2 text-[11.5px] text-gn-muted">加载中…</div>
          ) : error ? (
            <div className="py-2">
              <span className="text-[11.5px] text-gn-red">{error}</span>{' '}
              <button
                type="button"
                onClick={() => void refresh()}
                className="text-[11px] text-gn-muted underline hover:text-gn-fg"
              >
                重试
              </button>
            </div>
          ) : models.length === 0 ? (
            <div className="rounded border border-gn-prompt-border/40 bg-gn-bg-dark/30 p-3 text-center text-[11.5px] text-gn-muted">
              暂无自定义模型。点击上方「＋ 新增模型」或「⚡ 快速添加」写入 ~/.grok/config.toml，agent 热加载后生效。
            </div>
          ) : (
            <>
              {/* 工具栏：统计与快速搜索 */}
              <div className="flex items-center justify-between gap-2 text-[10.5px]">
                <span className="truncate text-gn-gutter">
                  {searchQuery ? (
                    <>
                      找到 <span className="font-semibold text-gn-fg">{filteredModels.length}</span> / {models.length} 个模型
                    </>
                  ) : (
                    <>
                      已配置 <span className="font-semibold text-gn-fg">{models.length}</span> 个模型
                    </>
                  )}
                </span>
                {models.length >= 3 && (
                  <div className="relative shrink-0">
                    <Search className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-gn-gutter" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="搜索模型、Slug 或 Base URL…"
                      className="w-28 rounded border border-gn-prompt-border bg-gn-bg-dark pl-5 pr-2 py-0.5 text-[10.5px] text-gn-fg outline-none transition-all placeholder:text-gn-gutter focus:w-40 focus:border-gn-prompt-border-active sm:w-44 sm:focus:w-44"
                    />
                  </div>
                )}
              </div>

              {/* 列表项 */}
              {filteredModels.length === 0 ? (
                <div className="py-3 text-center text-[11px] text-gn-muted">
                  没有匹配的自定义模型
                </div>
              ) : (
                <div className="overflow-hidden rounded border border-gn-prompt-border/40 bg-gn-bg-dark/25">
                  {filteredModels.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-2 border-b border-gn-prompt-border/25 px-2.5 py-1.5 last:border-b-0 transition-[background-color] duration-150 hover:bg-gn-bg-highlight/30"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium leading-snug text-gn-fg">
                          {m.name || m.id}
                        </div>
                        <div
                          className="truncate font-mono text-[10.5px] leading-tight text-gn-muted"
                          title={`${m.model} · ${m.base_url}`}
                        >
                          {m.model} · {m.base_url}
                        </div>
                      </div>

                      {/* 右侧：操作按钮 */}
                      <div className="flex shrink-0 items-center gap-1">
                        {confirmDelete === m.id ? (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-gn-red">确定删除？</span>
                            <button
                              type="button"
                              onClick={() => void del(m.id)}
                              className="rounded bg-gn-diff-del-bg px-1.5 py-0.5 text-[10.5px] font-medium text-gn-red hover:bg-gn-red/20 focus:outline-none"
                            >
                              确定
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(null)}
                              className="rounded px-1.5 py-0.5 text-[10.5px] text-gn-muted hover:text-gn-fg focus:outline-none"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setEditing({ ...m })}
                              className="rounded border border-gn-prompt-border/50 px-1.5 py-0.5 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg focus:outline-none"
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(m.id)}
                              className="rounded border border-gn-prompt-border/50 px-1.5 py-0.5 text-[10.5px] text-gn-muted hover:border-gn-red/50 hover:text-gn-red focus:outline-none"
                            >
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {quickAddOpen && (
        <QuickAddModelsModal
          isOpen={quickAddOpen}
          onClose={() => setQuickAddOpen(false)}
          existingModels={models}
          onAdded={() => {
            void refresh()
          }}
        />
      )}
    </section>
  )
}

// ── 表单 ───────────────────────────────────────────────────────────────

function ModelForm({
  initial,
  saving,
  models,
  onCancel,
  onSave,
}: {
  initial: CustomModelConfig
  saving: boolean
  models: CustomModelConfig[]
  onCancel: () => void
  onSave: (cfg: CustomModelConfig, oldId?: string) => void
}) {
  const [d, setD] = useState<CustomModelConfig>(initial)
  // 高级区默认收起；编辑已含高级字段的模型时自动展开，避免"看不见已配置项"。
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    ADVANCED_KEYS.some((k) => isSet(initial[k])),
  )
  const advancedCount = ADVANCED_KEYS.filter((k) => isSet(d[k])).length
  const isNew = !initial.id
  const trimmedId = d.id.trim()
  const trimmedModel = d.model?.trim() ?? ''
  const trimmedBaseUrl = d.base_url?.trim() ?? ''
  // 相同 id 只能配置一个（排除当前编辑模型自身）；
  // 相同 routing slug 也只能配置一个（排除当前编辑模型自身）。
  const idCollision = models.some(
    (m) => m.id !== initial.id && m.id === trimmedId,
  )
  const slugCollision = models.some(
    (m) => m.id !== initial.id && !!m.model && m.model === trimmedModel,
  )
  const blocked = idCollision || slugCollision
  const set = <K extends keyof CustomModelConfig,>(k: K, v: CustomModelConfig[K]) =>
    setD((prev) => ({ ...prev, [k]: v }))
  const num = (k: 'max_completion_tokens' | 'context_window' | 'max_retries' | 'inference_idle_timeout_secs' | 'auto_compact_threshold_percent' | 'temperature' | 'top_p') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value
      if (raw === '') return set(k, undefined)
      const n = k === 'temperature' || k === 'top_p' ? Number.parseFloat(raw) : Number(raw)
      if (Number.isFinite(n)) set(k, n as never)
    }

  return (
    <div className="border-t border-gn-prompt-border/40 px-3 py-2 sm:px-4">
      {/* 常用字段 —— 对齐实际配置里最常见的用法；其余进「高级设置」。 */}
      <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 sm:gap-y-1.5">
        <Field label="id（配置节键，必填）">
          <input
            className={inputCls}
            value={d.id}
            onChange={(e) => set('id', e.target.value)}
            placeholder="my-model"
          />
        </Field>
        <Field label="model（路由 slug，必填）">
          <input
            className={inputCls}
            value={d.model ?? ''}
            onChange={(e) => set('model', e.target.value)}
            placeholder="my-model"
          />
        </Field>
        <Field label="base_url（必填）" wide>
          <input
            className={inputCls}
            value={d.base_url ?? ''}
            onChange={(e) => set('base_url', e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <Field label="name（显示名）">
          <input
            className={inputCls}
            value={d.name ?? ''}
            onChange={(e) => set('name', e.target.value)}
            placeholder="My Model"
          />
        </Field>
        <Field label="api_backend">
          <select
            className={inputCls}
            value={d.api_backend ?? ''}
            onChange={(e) => set('api_backend', (e.target.value || undefined) as CustomModelConfig['api_backend'])}
          >
            <option value="">（默认 chat_completions）</option>
            {API_BACKENDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </Field>
        <Field label="api_key">
          <input
            className={inputCls}
            type="password"
            value={d.api_key ?? ''}
            onChange={(e) => set('api_key', e.target.value)}
            placeholder="sk-…"
          />
        </Field>
        <Field label="context_window（token）">
          <input
            className={inputCls}
            type="number"
            value={d.context_window ?? ''}
            onChange={num('context_window')}
            placeholder="200000"
          />
        </Field>
        <Field label="reasoning_efforts（档位菜单）" wide>
          <EffortListEditor
            value={d.reasoning_efforts}
            onChange={(v) => set('reasoning_efforts', v)}
          />
        </Field>
      </div>

      {/* 高级设置 —— 折叠区（其余全部字段）；编辑已含高级字段的模型时自动展开。 */}
      <div className="mt-2 border-t border-gn-prompt-border/40">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="mt-1 flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left text-[10px] uppercase tracking-wider text-gn-gutter hover:bg-gn-bg-highlight hover:text-gn-fg"
        >
          <IconGlyph glyph={advancedOpen ? Glyphs.chevronDown : Glyphs.chevron} />
          <span>高级设置</span>
          {advancedCount > 0 && (
            <span className="rounded bg-gn-bg-highlight px-1 py-px text-[9px] normal-case tracking-normal text-gn-fg2">
              {advancedCount} 项已设置
            </span>
          )}
        </button>
        {advancedOpen && (
          <>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-gn-gutter">元信息</div>
            <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 sm:gap-y-1.5">
              <Field label="agent_type（系统提示身份）">
                <input
                  className={inputCls}
                  value={d.agent_type ?? ''}
                  onChange={(e) => set('agent_type', e.target.value)}
                  placeholder="grok-build"
                />
              </Field>
              <Field label="system_prompt_label">
                <input
                  className={inputCls}
                  value={d.system_prompt_label ?? ''}
                  onChange={(e) => set('system_prompt_label', e.target.value)}
                />
              </Field>
              <Field label="description" wide>
                <input
                  className={inputCls}
                  value={d.description ?? ''}
                  onChange={(e) => set('description', e.target.value)}
                />
              </Field>
            </div>

            <div className="mt-2 text-[10px] uppercase tracking-wider text-gn-gutter">鉴权</div>
            <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 sm:gap-y-1.5">
              <Field label="env_key（逗号分隔可多个）">
                <input
                  className={inputCls}
                  value={Array.isArray(d.env_key) ? d.env_key.join(', ') : (d.env_key ?? '')}
                  onChange={(e) => {
                    const parts = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    set('env_key', parts.length > 1 ? parts : (parts[0] ?? undefined))
                  }}
                  placeholder="MY_API_KEY"
                />
              </Field>
              <Field label="auth_provider">
                <input
                  className={inputCls}
                  value={d.auth_provider ?? ''}
                  onChange={(e) => set('auth_provider', e.target.value)}
                />
              </Field>
              <Field label="model_provider">
                <input
                  className={inputCls}
                  value={d.model_provider ?? ''}
                  onChange={(e) => set('model_provider', e.target.value)}
                />
              </Field>
              <Field label="api_base_url" wide>
                <input
                  className={inputCls}
                  value={d.api_base_url ?? ''}
                  onChange={(e) => set('api_base_url', e.target.value)}
                />
              </Field>
              <Field label="extra_headers" wide>
                <KVEditor value={d.extra_headers} onChange={(v) => set('extra_headers', v)} />
              </Field>
              <Field label="env_http_headers" wide>
                <KVEditor value={d.env_http_headers} onChange={(v) => set('env_http_headers', v)} />
              </Field>
              <Field label="query_params" wide>
                <KVEditor value={d.query_params} onChange={(v) => set('query_params', v)} />
              </Field>
            </div>

            <div className="mt-2 text-[10px] uppercase tracking-wider text-gn-gutter">采样参数</div>
            <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 sm:gap-y-1.5">
              <Field label="temperature">
                <input
                  className={inputCls}
                  type="number"
                  step="0.1"
                  value={d.temperature ?? ''}
                  onChange={num('temperature')}
                />
              </Field>
              <Field label="top_p">
                <input
                  className={inputCls}
                  type="number"
                  step="0.1"
                  value={d.top_p ?? ''}
                  onChange={num('top_p')}
                />
              </Field>
              <Field label="max_completion_tokens">
                <input
                  className={inputCls}
                  type="number"
                  value={d.max_completion_tokens ?? ''}
                  onChange={num('max_completion_tokens')}
                />
              </Field>
              <Field label="max_retries">
                <input
                  className={inputCls}
                  type="number"
                  value={d.max_retries ?? ''}
                  onChange={num('max_retries')}
                />
              </Field>
              <Field label="inference_idle_timeout_secs">
                <input
                  className={inputCls}
                  type="number"
                  value={d.inference_idle_timeout_secs ?? ''}
                  onChange={num('inference_idle_timeout_secs')}
                />
              </Field>
              <BoolField label="stream_tool_calls" value={d.stream_tool_calls} onChange={(v) => set('stream_tool_calls', v)} />
            </div>

            <div className="mt-2 text-[10px] uppercase tracking-wider text-gn-gutter">推理档位</div>
            <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 sm:gap-y-1.5">
              <Field label="reasoning_effort（默认档）">
                <select
                  className={inputCls}
                  value={d.reasoning_effort ?? ''}
                  onChange={(e) => set('reasoning_effort', e.target.value || undefined)}
                >
                  <option value="">（未设置）</option>
                  {EFFORT_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <BoolField label="supports_reasoning_effort" value={d.supports_reasoning_effort} onChange={(v) => set('supports_reasoning_effort', v)} />
            </div>

            <div className="mt-2 text-[10px] uppercase tracking-wider text-gn-gutter">目录与显示</div>
            <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 sm:gap-y-1.5">
              <BoolField label="hidden" value={d.hidden} onChange={(v) => set('hidden', v)} />
              <BoolField label="supported_in_api" value={d.supported_in_api} onChange={(v) => set('supported_in_api', v)} />
              <BoolField label="use_concise" value={d.use_concise} onChange={(v) => set('use_concise', v)} />
              <BoolField label="supports_backend_search" value={d.supports_backend_search} onChange={(v) => set('supports_backend_search', v)} />
              <BoolField label="show_model_fingerprint" value={d.show_model_fingerprint} onChange={(v) => set('show_model_fingerprint', v)} />
              <Field label="auto_compact_threshold_percent">
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  max={100}
                  value={d.auto_compact_threshold_percent ?? ''}
                  onChange={num('auto_compact_threshold_percent')}
                />
              </Field>
              <Field label="compactions_remaining">
                <BoolishSelect
                  value={d.compactions_remaining}
                  onChange={(v) => set('compactions_remaining', v)}
                />
              </Field>
              <Field label="compaction_at_tokens">
                <BoolishSelect
                  value={d.compaction_at_tokens}
                  onChange={(v) => set('compaction_at_tokens', v)}
                />
              </Field>
            </div>
          </>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={saving || blocked || !trimmedId || !trimmedModel || !trimmedBaseUrl}
          onClick={() => void onSave({ ...d, id: trimmedId }, initial.id || undefined)}
          className="rounded bg-gn-bg-highlight px-3 py-1 text-[12px] font-medium text-gn-fg hover:bg-gn-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? '保存中…' : isNew ? '新增' : '保存修改'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-[12px] text-gn-muted hover:text-gn-fg"
        >
          取消
        </button>
        {idCollision ? (
          <span className="text-[10.5px] text-gn-red">
            id「{trimmedId}」已存在——相同模型只能配置一个，请直接编辑现有条目
          </span>
        ) : slugCollision ? (
          <span className="text-[10.5px] text-gn-red">
            model（路由 slug）「{trimmedModel}」已被其他条目使用，不能重复配置
          </span>
        ) : (
          <span className="text-[10.5px] text-gn-gutter">
            {initial.id && initial.id !== trimmedId
              ? `保存=重命名 [model.${initial.id}] → [model.${trimmedId || '…'}]`
              : `保存=整节替换 \`[model.${trimmedId || '…'}]\``}
          </span>
        )}
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active'

function Field({
  label,
  children,
  wide,
}: {
  label: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <label className={`block min-w-0 ${wide ? 'col-span-1 sm:col-span-2' : ''}`}>
      <span className="mb-0.5 block text-[10px] text-gn-muted">{label}</span>
      {children}
    </label>
  )
}

function BoolField({
  label,
  value,
  onChange,
}: {
  label: string
  value?: boolean
  onChange: (v?: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2 self-end pb-1.5">
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked ? true : undefined)}
        className="accent-gn-magenta"
      />
      <span className="text-[11px] text-gn-fg2">{label}</span>
    </label>
  )
}

/** true / false / 固定数字 三态编辑（compactions_remaining 等）。 */
function BoolishSelect({
  value,
  onChange,
}: {
  value?: boolean | number
  onChange: (v?: boolean | number) => void
}) {
  const mode: BoolishMode =
    value === undefined ? 'unset' : typeof value === 'boolean' ? (value ? 'true' : 'false') : 'fixed'
  const fixed = typeof value === 'number' ? value : 1
  return (
    <div className="flex items-center gap-1.5">
      <select
        className={inputCls}
        value={mode}
        onChange={(e) => {
          const m = e.target.value as BoolishMode
          if (m === 'unset') onChange(undefined)
          else if (m === 'true') onChange(true)
          else if (m === 'false') onChange(false)
          else onChange(fixed)
        }}
      >
        <option value="unset">未设置</option>
        <option value="true">true（动态）</option>
        <option value="false">false（禁用）</option>
        <option value="fixed">固定值</option>
      </select>
      {mode === 'fixed' && (
        <input
          className={`${inputCls} w-20`}
          type="number"
          value={fixed}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) onChange(n)
          }}
        />
      )}
    </div>
  )
}

/** 键值对编辑（extra_headers / query_params / env_http_headers）。 */
function KVEditor({
  value,
  onChange,
}: {
  value?: Record<string, string>
  onChange: (v?: Record<string, string>) => void
}) {
  const entries = Object.entries(value ?? {})
  const upsert = (oldKey: string, key: string, val: string) => {
    const next = { ...(value ?? {}) }
    if (oldKey !== key) delete next[oldKey]
    if (key.trim()) next[key.trim()] = val
    onChange(Object.keys(next).length > 0 ? next : undefined)
  }
  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1">
          <input
            className={`${inputCls} flex-1`}
            value={k}
            placeholder="key"
            onChange={(e) => upsert(k, e.target.value, v)}
          />
          <input
            className={`${inputCls} flex-1`}
            value={v}
            placeholder="value"
            onChange={(e) => upsert(k, k, e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              const next = { ...(value ?? {}) }
              delete next[k]
              onChange(Object.keys(next).length > 0 ? next : undefined)
            }}
            className="rounded px-1 text-[11px] text-gn-muted hover:text-gn-red"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...(value ?? {}), [`k${entries.length + 1}`]: '' })}
        className="rounded px-2 py-px text-[10.5px] text-gn-muted hover:text-gn-fg"
      >
        ＋ 添加键值
      </button>
    </div>
  )
}

/** reasoning_efforts 列表编辑（裸字符串或 {value,label,default}）。 */
function EffortListEditor({
  value,
  onChange,
}: {
  value?: CustomModelConfig['reasoning_efforts']
  onChange: (v?: CustomModelConfig['reasoning_efforts']) => void
}) {
  // 本地草稿态：value 为空的行（新增行、只填了 label 的行）保留在本地参与
  // 渲染，只有非空行才向上 emit——否则「＋ 添加档位」的空行会被立即过滤，
  // 按钮看起来没反应。
  const [rows, setRows] = useState(() =>
    (value ?? []).map((r) =>
      typeof r === 'string'
        ? { value: r, label: '', default: false }
        : { value: r.value ?? '', label: r.label ?? '', default: r.default === true },
    ),
  )
  const update = (next: { value: string; label: string; default: boolean }[]) => {
    setRows(next)
    const out: NonNullable<CustomModelConfig['reasoning_efforts']> = []
    for (const r of next) {
      if (!r.value) continue
      out.push({
        value: r.value,
        ...(r.label && r.label !== r.value ? { label: r.label } : {}),
        ...(r.default ? { default: true } : {}),
      })
    }
    onChange(out.length > 0 ? out : undefined)
  }
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1">
          <select
            className={`${inputCls} flex-1`}
            value={r.value}
            onChange={(e) => {
              const next = [...rows]
              next[i] = { ...r, value: e.target.value }
              update(next)
            }}
          >
            <option value="">（选择档位）</option>
            {EFFORT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <input
            className={`${inputCls} flex-1`}
            value={r.label}
            placeholder="label"
            onChange={(e) => {
              const next = [...rows]
              next[i] = { ...r, label: e.target.value }
              update(next)
            }}
          />
          <label className="flex items-center gap-1 text-[10.5px] text-gn-muted">
            <input
              type="checkbox"
              checked={r.default}
              onChange={(e) => {
                const next = [...rows]
                next[i] = { ...r, default: e.target.checked }
                update(next)
              }}
              className="accent-gn-magenta"
            />
            默认
          </label>
          <button
            type="button"
            onClick={() => update(rows.filter((_, j) => j !== i))}
            className="rounded px-1 text-[11px] text-gn-muted hover:text-gn-red"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => update([...rows, { value: '', label: '', default: false }])}
        className="rounded px-2 py-px text-[10.5px] text-gn-muted hover:text-gn-fg"
      >
        ＋ 添加档位
      </button>
    </div>
  )
}
