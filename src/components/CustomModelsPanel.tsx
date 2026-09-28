import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRightLeft, Filter, Plus, Search, X, Zap } from 'lucide-react'
import { transport } from '../api/client'
import type { CustomModelConfig, CustomModelFilters } from '../api/types'
import { compareCustomModels } from '../lib/quickAddModels'
import { pushToast } from '../store/toast'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { QuickAddModelsModal } from './QuickAddModelsModal'
import { ImportModelsFromHostModal } from './ImportModelsFromHostModal'

/**
 * 自定义模型面板（settings 内）—— `[model.<id>]` 可视化编辑。
 * 表单分「常用」（对齐实际配置最常见的字段，直接展示）与
 * 「高级设置」（折叠区，其余全部字段）；字段集合对齐 grok 源码的
 * `ConfigModelOverride`（xai-grok-shell/src/agent/config.rs）；
 * 保存写入 ~/.grok/config.toml，agent 的 config watcher 热加载后
 * 出现在模型列表（无需重启）。
 *
 * 顶栏「目录过滤」切到二级视图，编辑 `[models]` 的另外两个键
 * （hidden_models / disabled_models）：它们作用在整个模型目录上，因此能挡掉
 * 没有 `[model.*]` 节的条目（内置 grok-4.5/4.6、官方拉取的 grok-4.7 等）。
 * 列表主视图仅在已有生效规则时于底部展示一行轻量摘要。
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
  // asNew：从既有模型「复制」出来的新建表单——id 已预填但目标配置节尚不存在，
  // 保存时不能按重命名处理（会误删源条目）。
  const [editing, setEditing] = useState<{ cfg: CustomModelConfig; asNew?: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // 目录过滤（[models] hidden_models / disabled_models）：二级视图编辑，
  // savedFilters 记录 host 已落盘状态，filters 为打开二级视图期间的草稿。
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [savedFilters, setSavedFilters] = useState<CustomModelFilters>({
    hidden: [],
    disabled: [],
  })
  const [filters, setFilters] = useState<CustomModelFilters>({ hidden: [], disabled: [] })
  const [filtersDirty, setFiltersDirty] = useState(false)
  const [filtersSaving, setFiltersSaving] = useState(false)
  // 另一台 host（hub 模式）可能是旧版本，config.toml 里这两个键也可能写坏：
  // 读不到就记下 host 的说法，整块降级成提示，而不是让「保存」打到 404 上。
  const [filtersIssue, setFiltersIssue] = useState<string | null>(null)
  // 跨 host 导入（hub 模式 + 还有别的 host 才可能）：源/目标都按 host 区分。
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const hosts = useChatStore((s) => s.hosts)
  const targetHostName =
    hosts.find((h) => h.hostId === selectedHostId)?.hostName ?? selectedHostId ?? '本机'
  const canImportFromHost =
    transport.getConnectionMode() === 'hub' && hosts.some((h) => h.hostId !== selectedHostId)

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
      // 过滤名单与 [model.*] 同属一个 host 的配置：一次刷新同时读，
      // 读不到（旧 host / 键写坏）只降级那一块，不影响模型列表。
      const [list, hostFilters] = await Promise.all([
        transport.listCustomModels(),
        Promise.resolve()
          .then(() => transport.listModelFilters())
          .catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
      ])
      setModels([...list].sort(compareCustomModels))
      if (typeof hostFilters === 'string') {
        setFiltersIssue(hostFilters || '读取失败')
      } else {
        setFiltersIssue(null)
        setSavedFilters(hostFilters)
        setFilters(hostFilters)
        setFiltersDirty(false)
      }
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 列表是 host 级的（`?host=` / 近路随选中 host 变）：换 host 必须重读，
  // 否则面板会继续显示上一台的配置——对「导入到哪台」的判断尤其误导。
  useEffect(() => {
    void refresh()
  }, [refresh, selectedHostId])

  /** 复制为新条目：沿用全部配置字段，id 追加 -copy 后缀（被占用则 -copy2、-copy3…）。 */
  const copyOf = (m: CustomModelConfig): CustomModelConfig => {
    const taken = new Set(models.map((x) => x.id))
    let id = `${m.id}-copy`
    for (let n = 2; taken.has(id); n += 1) id = `${m.id}-copy${n}`
    return { ...m, id }
  }

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
          // 不带 sessionId：这是纯配置写入（把默认模型重指到新 id）。
          // 改模型列表不该改任何会话当前的模型，host 侧缺 sid 时只落盘。
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

  const openFilters = () => {
    setEditing(null)
    setFilters(savedFilters)
    setFiltersDirty(false)
    setFiltersOpen(true)
  }

  const closeFilters = () => {
    setFilters(savedFilters)
    setFiltersDirty(false)
    setFiltersOpen(false)
  }

  const saveFilters = async () => {
    setFiltersSaving(true)
    try {
      await transport.setModelFilters(filters)
      setSavedFilters(filters)
      setFiltersDirty(false)
      setFiltersOpen(false)
      pushToast('已保存目录过滤（hidden / disabled）')
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setFiltersSaving(false)
    }
  }

  const savedFiltersCount = savedFilters.hidden.length + savedFilters.disabled.length

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
            onClick={() => {
              setFiltersOpen(false)
              setEditing({ cfg: { id: '' } })
            }}
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
          {canImportFromHost && (
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg focus:outline-none sm:py-px"
              title="复制另一台 Host 已配置好的 [model.*] 条目到当前 Host"
            >
              <ArrowRightLeft className="h-3 w-3 text-gn-orange" />
              <span className="hidden sm:inline">从其他 Host 导入</span>
              <span className="sm:hidden">导入</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => (filtersOpen ? closeFilters() : openFilters())}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] focus:outline-none sm:py-px ${
              filtersOpen
                ? 'bg-gn-bg-highlight text-gn-fg'
                : 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
            }`}
            title="按模型 ID 或通配符隐藏 / 禁用目录中的模型（[models] hidden_models / disabled_models）"
          >
            <Filter className="h-3 w-3 text-gn-magenta" />
            <span>目录过滤</span>
            {savedFiltersCount > 0 && (
              <span className="rounded bg-gn-bg-highlight px-1 py-px font-mono text-[10px] text-gn-fg2">
                {savedFiltersCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {editing ? (
        <ModelForm
          initial={editing.cfg}
          asNew={editing.asNew}
          saving={saving}
          models={models}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : filtersOpen ? (
        <CatalogFilters
          filters={filters}
          issue={filtersIssue}
          dirty={filtersDirty}
          saving={filtersSaving}
          onChange={(next) => {
            setFilters(next)
            setFiltersDirty(true)
          }}
          onSave={() => void saveFilters()}
          onCancel={closeFilters}
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
              暂无自定义模型。点击上方「
              <Plus
                size={11}
                strokeWidth={2}
                className="inline-block align-[-2px]"
                aria-hidden
              />{' '}
              新增模型」或「
              <Zap
                size={11}
                strokeWidth={2}
                className="inline-block align-[-2px]"
                aria-hidden
              />{' '}
              快速添加」写入 ~/.grok/config.toml，agent 热加载后生效。
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
                              onClick={() => setEditing({ cfg: { ...m } })}
                              className="rounded border border-gn-prompt-border/50 px-1.5 py-0.5 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg focus:outline-none"
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing({ cfg: copyOf(m), asNew: true })}
                              className="rounded border border-gn-prompt-border/50 px-1.5 py-0.5 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg focus:outline-none"
                              title="以此模型为模板新建（配置原样预填，保存为新的 [model.*] 节）"
                            >
                              复制
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

          {/* 仅当已有生效过滤规则时，在列表下方渲染单行摘要条；零规则不占位。 */}
          {!loading && !error && !filtersIssue && savedFiltersCount > 0 && (
            <div className="flex items-center justify-between gap-2 rounded border border-gn-prompt-border/40 bg-gn-bg-dark/25 px-2.5 py-1.5 text-[11px]">
              <div className="min-w-0 flex-1 truncate text-gn-muted">
                <span className="text-gn-fg2">目录过滤：</span>
                {savedFilters.hidden.length > 0 && (
                  <span>
                    已隐藏 {savedFilters.hidden.length} 项（{savedFilters.hidden.join(', ')}）
                  </span>
                )}
                {savedFilters.hidden.length > 0 && savedFilters.disabled.length > 0 && (
                  <span> · </span>
                )}
                {savedFilters.disabled.length > 0 && (
                  <span>
                    已禁用 {savedFilters.disabled.length} 项（{savedFilters.disabled.join(', ')}）
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={openFilters}
                className="shrink-0 rounded border border-gn-prompt-border/50 px-1.5 py-0.5 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg focus:outline-none"
              >
                编辑过滤
              </button>
            </div>
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

      {importOpen && selectedHostId && (
        // key：换 host 即重建——源候选与「导入到」目标都会变，旧选择必须失效。
        <ImportModelsFromHostModal
          key={selectedHostId}
          isOpen={importOpen}
          onClose={() => setImportOpen(false)}
          targetHostId={selectedHostId}
          targetHostName={targetHostName}
          hosts={hosts}
          onImported={() => {
            void refresh()
          }}
        />
      )}
    </section>
  )
}

/**
 * 「目录过滤」二级视图 —— config.toml `[models]` 的 `hidden_models` /
 * `disabled_models`。与 `[model.*]` 表单不同，这两份名单作用在整个模型目录
 * 上：hidden 让命中的条目从模型列表/选择器消失（`-m` 仍可用），disabled 把
 * 命中的条目从目录里整条移除。条目按「目录键名或模型 id」做 glob 匹配。
 */
function CatalogFilters({
  filters,
  issue,
  dirty,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  filters: CustomModelFilters
  /** host 读不出这两份名单时的原话（旧 host 没有该端点 / 键的写法有问题）。 */
  issue: string | null
  dirty: boolean
  saving: boolean
  onChange: (next: CustomModelFilters) => void
  onSave: () => void
  onCancel: () => void
}) {
  if (issue) {
    return (
      <div className="border-t border-gn-prompt-border/40 px-3 py-2 sm:px-4">
        <div className="rounded border border-gn-prompt-border/40 bg-gn-bg-dark/25 p-2.5 text-[11px] leading-snug text-gn-muted">
          目录过滤（[models] hidden_models / disabled_models）不可用：{issue}
          ；host 需更新，或先修正 config.toml 里这两个键的写法。
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1 text-[12px] text-gn-muted hover:text-gn-fg"
          >
            返回
          </button>
        </div>
      </div>
    )
  }
  const count = filters.hidden.length + filters.disabled.length
  return (
    <div className="border-t border-gn-prompt-border/40 px-3 py-2 sm:px-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-gn-gutter">
          目录过滤（[models]）
          {count > 0 && (
            <span className="ml-1 normal-case tracking-normal text-gn-fg2">{count} 条</span>
          )}
        </span>
      </div>
      <div className="mt-1.5 space-y-2.5">
        <PatternListEditor
          label="hidden_models（隐藏：仅从模型列表/选择器消失，仍可用 -m 指定）"
          placeholder="grok-4.6 或 grok-*"
          patterns={filters.hidden}
          onChange={(next) => onChange({ ...filters, hidden: next })}
        />
        <PatternListEditor
          label="disabled_models（禁用：从模型目录整条移除，-m 也不再提供）"
          placeholder="grok-4.5 或 grok-*"
          patterns={filters.disabled}
          onChange={(next) => onChange({ ...filters, disabled: next })}
        />
      </div>
      <div className="mt-2 text-[10px] leading-snug text-gn-gutter">
        保存后 host 会重载模型目录，改动随即反映到模型列表；被 disabled 掉的条目
        若还被默认模型 / fork / 子代理等设置引用，会回落到其它模型。
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={onSave}
          className="rounded bg-gn-bg-highlight px-3 py-1 text-[12px] font-medium text-gn-fg hover:bg-gn-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存目录过滤'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-[12px] text-gn-muted hover:text-gn-fg"
        >
          返回
        </button>
      </div>
    </div>
  )
}

/** 过滤模式列表：chip 逐条删除，输入框回车/「添加」写入（支持一次粘贴多条）。 */
function PatternListEditor({
  label,
  placeholder,
  patterns,
  onChange,
}: {
  label: string
  placeholder: string
  patterns: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const parts = draft
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft('')
    if (parts.length === 0) return
    const next = [...patterns]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
  }
  return (
    <div>
      <div className="mb-0.5 text-[10px] text-gn-muted">{label}</div>
      {patterns.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {patterns.map((p) => (
            <span
              key={p}
              className="flex items-center gap-1 rounded bg-gn-bg-highlight/60 px-1.5 py-px font-mono text-[10.5px] text-gn-fg2"
            >
              {p}
              <button
                type="button"
                onClick={() => onChange(patterns.filter((x) => x !== p))}
                className="text-gn-muted hover:text-gn-red"
                aria-label={`删除 ${p}`}
              >
                <X size={10} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <input
          className={inputCls}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button
          type="button"
          onClick={add}
          className="shrink-0 rounded border border-gn-prompt-border/50 px-1.5 py-1 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg focus:outline-none"
        >
          添加
        </button>
      </div>
    </div>
  )
}

// ── 表单 ───────────────────────────────────────────────────────────────
/** reasoning_efforts 里只保留第一个 default（shell 的 derive_reasoning_effort_fields
 * 只认第一个 default 档），配置里多标时归一到第一个，保证表单展示与保存写回一致。 */
function singleDefaultEfforts(
  value: CustomModelConfig['reasoning_efforts'],
): CustomModelConfig['reasoning_efforts'] {
  let seen = false
  return value?.map((r) => {
    if (typeof r === 'string') return r
    if (r.default && !seen) {
      seen = true
      return r
    }
    const { default: _extra, ...rest } = r
    return rest
  })
}

function ModelForm({
  initial,
  asNew,
  saving,
  models,
  onCancel,
  onSave,
}: {
  initial: CustomModelConfig
  /** 复制出来的新建表单：initial.id 只是预填草稿，尚无对应配置节。 */
  asNew?: boolean
  saving: boolean
  models: CustomModelConfig[]
  onCancel: () => void
  onSave: (cfg: CustomModelConfig, oldId?: string) => void
}) {
  const [d, setD] = useState<CustomModelConfig>(() => ({
    ...initial,
    reasoning_efforts: singleDefaultEfforts(initial.reasoning_efforts),
  }))
  // 高级区默认收起；编辑已含高级字段的模型时自动展开，避免"看不见已配置项"。
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    ADVANCED_KEYS.some((k) => isSet(initial[k])),
  )
  const advancedCount = ADVANCED_KEYS.filter((k) => isSet(d[k])).length
  const isNew = asNew || !initial.id
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
          onClick={() => void onSave({ ...d, id: trimmedId }, asNew ? undefined : (initial.id || undefined))}
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
            {!asNew && initial.id && initial.id !== trimmedId
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
            className="rounded p-0.5 text-gn-muted hover:text-gn-red"
            aria-label="删除该行"
          >
            <X size={11} aria-hidden />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...(value ?? {}), [`k${entries.length + 1}`]: '' })}
        className="inline-flex items-center gap-1 rounded px-2 py-px text-[10.5px] text-gn-muted hover:text-gn-fg"
      >
        <Plus size={11} strokeWidth={2} aria-hidden />
        添加键值
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
  // 渲染，只有非空行才向上 emit——否则「添加档位」的空行会被立即过滤，
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
                // 「默认」互斥：勾上某一档即取消其他档的默认标记（shell 只认第一个 default 档）
                const next = rows.map((x) => ({ ...x, default: e.target.checked ? false : x.default }))
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
            className="rounded p-0.5 text-gn-muted hover:text-gn-red"
            aria-label="删除该行"
          >
            <X size={11} aria-hidden />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => update([...rows, { value: '', label: '', default: false }])}
        className="inline-flex items-center gap-1 rounded px-2 py-px text-[10.5px] text-gn-muted hover:text-gn-fg"
      >
        <Plus size={11} strokeWidth={2} aria-hidden />
        添加档位
      </button>
    </div>
  )
}
