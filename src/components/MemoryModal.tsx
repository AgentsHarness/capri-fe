import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, Copy, FileText, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import type { MemoryFileInfo } from '../lib/memory'
import {
  MEMORY_FORGET_MAX_FILE_BYTES,
  MEMORY_PREVIEW_MAX_BYTES,
  baseName,
  canEnableMemory,
  disabledMemoryNotice,
  disabledReasonLabel,
  emptyMemoryNotice,
  filterMemoryFiles,
  groupMemoryFiles,
  isMemoryFileDeletable,
  memoryContentHash,
  memoryFileLabel,
  memorySizeText,
} from '../lib/memory'

/**
 * /memory — the web counterpart of the TUI memory modal
 * (xai-grok-pager/views/memory_modal.rs).
 *
 * Left: the note list grouped Global / Workspace / Sessions, from
 * `x.ai/memory/list` via the host's /api/memory-list, with the generated
 * `MEMORY.md` indexes marked and session logs newest first. Right: the
 * selected note, read through the agent (/api/fs/read-file). Memory can be
 * turned on/off for the session and notes deleted; deletion needs the BLAKE3
 * of exactly the previewed bytes, so a note edited behind the user's back is
 * refused by the store instead of disappearing silently.
 *
 * The TUI renders ONLY the notice when memory is off or nothing but indexes
 * exists (`shows_notice`); that rule is kept here.
 */

/** Per-note read cap for the filter's content search (TUI MAX_SEARCH_BYTES_PER_NOTE). */
const SEARCH_BYTES_PER_NOTE = 262_144
/** Total read cap for the filter's content search (TUI MAX_SEARCH_BYTES_TOTAL). */
const SEARCH_BYTES_TOTAL = 8 * 1_048_576

type Preview = {
  path: string
  loading: boolean
  content?: string
  /** BLAKE3 of `content` — absent while the note could not be read in full. */
  hash?: string
  tooLarge?: boolean
  error?: string
}

/** Stable empty fallback — a fresh `[]` per render would defeat the memos. */
const NO_FILES: MemoryFileInfo[] = []

export function MemoryModal() {
  const open = useChatStore((s) => s.memoryOpen)
  const listing = useChatStore((s) => s.memoryListing)
  const status = useChatStore((s) => s.memoryStatus)
  const loadError = useChatStore((s) => s.memoryError)
  const notice = useChatStore((s) => s.memoryNotice)
  const closeMemory = useChatStore((s) => s.closeMemory)
  const refreshMemory = useChatStore((s) => s.refreshMemory)
  const memoryToggle = useChatStore((s) => s.memoryToggle)
  const forgetMemoryNote = useChatStore((s) => s.forgetMemoryNote)
  const memoryDream = useChatStore((s) => s.memoryDream)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<Preview | undefined>(undefined)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  /** Narrow viewports collapse to one pane: the preview replaces the list. */
  const [detailOnly, setDetailOnly] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const files = listing?.files ?? NO_FILES
  const activePath = selected ?? files[0]?.path
  const contents = useSearchContents(files, query, open)
  const shown = useMemo(
    () => filterMemoryFiles(files, query, contents),
    [files, query, contents],
  )
  const groups = useMemo(() => groupMemoryFiles(shown), [shown])
  // TUI shows_notice: memory off, or on with nothing but the generated indexes.
  const stateNotice = useMemo(() => {
    if (!listing) return undefined
    if (!listing.enabled) return disabledMemoryNotice(listing.disabledReason)
    if (!files.some((f) => !f.generated)) {
      return emptyMemoryNotice(listing.captureEnabled, listing.dreamEnabled)
    }
    return undefined
  }, [listing, files])

  // Selection: keep the current note while it is still listed, otherwise start
  // at the first row (TUI apply_listing → selected = 0).
  useEffect(() => {
    if (!open) return
    if (selected && files.some((f) => f.path === selected)) return
    setSelected(files[0]?.path)
  }, [open, files, selected])

  // Every open re-reads the listing (the TUI opens on a fresh
  // x.ai/memory/list); the cached listing stays painted while it lands.
  const refreshedForOpen = useRef(false)
  useEffect(() => {
    if (!open) {
      refreshedForOpen.current = false
      return
    }
    if (refreshedForOpen.current) return
    refreshedForOpen.current = true
    void refreshMemory()
  }, [open, refreshMemory])

  // Preview of the selected note.
  useEffect(() => {
    if (!open || !activePath || stateNotice) {
      setPreview(undefined)
      return
    }
    let cancelled = false
    setPreview({ path: activePath, loading: true })
    void (async () => {
      try {
        const { content } = await transport.fsReadFile(activePath)
        if (cancelled) return
        if (new TextEncoder().encode(content).length > MEMORY_PREVIEW_MAX_BYTES) {
          // Never saw the whole note, so no digest may be offered: deletion
          // stays disabled (TUI NoteRead::TooLarge).
          setPreview({ path: activePath, loading: false, tooLarge: true })
          return
        }
        setPreview({ path: activePath, loading: false, content, hash: memoryContentHash(content) })
      } catch (e) {
        if (cancelled) return
        setPreview({
          path: activePath,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, activePath, stateNotice])

  useEffect(() => {
    if (open) return
    setQuery('')
    setSelected(undefined)
    setPreview(undefined)
    setConfirming(undefined)
    setDetailOnly(false)
    setCopied(false)
  }, [open])

  const selectedFile = files.find((f) => f.path === activePath)
  const deletable = Boolean(
    selectedFile && isMemoryFileDeletable(selectedFile) && preview?.hash && !preview.loading,
  )
  const canToggle = Boolean(
    listing && (listing.enabled || canEnableMemory(listing.disabledReason)),
  )

  const requestDelete = useCallback(async () => {
    if (!selectedFile || !preview?.hash) return
    setConfirming(undefined)
    const res = await forgetMemoryNote(selectedFile.path, preview.hash)
    // A successful delete drops the row; a refusal keeps it with the store's
    // own explanation on the notice line.
    if (res.ok) {
      setPreview(undefined)
      setSelected(undefined)
    }
  }, [selectedFile, preview?.hash, forgetMemoryNote])

  // Keyboard parity with the TUI (t / x / arrows / Esc); the search field keeps
  // the keys it needs while focused.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (confirming) setConfirming(undefined)
        else if (detailOnly) setDetailOnly(false)
        else if (query) setQuery('')
        else closeMemory()
        return
      }
      if (document.activeElement === searchRef.current) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!shown.length) return
        e.preventDefault()
        const i = shown.findIndex((f) => f.path === activePath)
        const next =
          e.key === 'ArrowDown' ? Math.min(shown.length - 1, i + 1) : Math.max(0, i - 1)
        setSelected(shown[next].path)
        return
      }
      if (e.key === 'Enter' && activePath) {
        setDetailOnly(true)
        return
      }
      if (e.key === 't' && canToggle) {
        e.preventDefault()
        void memoryToggle(!listing?.enabled)
        return
      }
      if (e.key === 'x' && deletable) {
        e.preventDefault()
        setConfirming(selectedFile?.path)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    open,
    confirming,
    detailOnly,
    query,
    closeMemory,
    shown,
    activePath,
    canToggle,
    listing?.enabled,
    memoryToggle,
    deletable,
    selectedFile,
  ])

  // Keep the active list item visible within the left scroll area.
  useEffect(() => {
    if (!activePath || !listRef.current) return
    const activeEl = listRef.current.querySelector<HTMLElement>('[aria-current="true"]')
    if (typeof activeEl?.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [activePath])

  if (!open) return null

  const loading = status === 'loading' && !listing
  const showOnlyNotice = !loading && (Boolean(stateNotice) || (!listing && Boolean(loadError)))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto gn-modal-dim p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="memory"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeMemory()
      }}
    >
      <div
        className="my-auto flex h-[90dvh] sm:h-[82vh] max-h-[780px] min-h-[380px] w-full max-w-[960px] flex-col overflow-hidden gn-modal-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="gn-modal-header shrink-0">
          <span className="text-gn-magenta" aria-hidden>
            {Glyphs.diamondFilled}
          </span>
          <span className="text-[13px] font-bold text-gn-fg">记忆</span>
          {listing ? (
            <span
              className={`rounded px-1.5 py-0.5 text-[10.5px] ${
                listing.enabled ? 'text-gn-green' : 'text-gn-warning'
              }`}
            >
              {listing.enabled ? '已启用' : disabledReasonLabel(listing.disabledReason)}
            </span>
          ) : null}
          {listing ? (
            <button
              type="button"
              onClick={() => void memoryToggle(!listing.enabled)}
              disabled={!canToggle}
              title={listing.enabled ? '关闭本会话的记忆 (t)' : '开启本会话的记忆 (t)'}
              className="ml-1 rounded border border-gn-prompt-border px-2 py-0.5 text-[10.5px] text-gn-fg2 transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {listing.enabled ? '关闭记忆' : '开启记忆'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setCopied(false)
              void refreshMemory()
            }}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="刷新记忆列表"
            title="刷新列表"
          >
            <RefreshCw size={13} aria-hidden />
          </button>
          <button
            type="button"
            onClick={closeMemory}
            className="rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭弹窗"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-gn-muted">
            正在读取记忆…
          </div>
        ) : showOnlyNotice ? (
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            <section className="rounded border border-gn-prompt-border bg-gn-bg-dark p-4 text-[12px] leading-relaxed">
              <div className="font-bold text-gn-fg">{stateNotice?.title ?? loadError}</div>
              {stateNotice ? (
                <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-gn-fg2">
                  {stateNotice.lines.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              ) : null}
              {listing && !listing.enabled ? (
                <div className="mt-3 text-gn-muted">
                  {canEnableMemory(listing.disabledReason)
                    ? '点上方「开启记忆」或按 t 可临时开启（只对本次会话生效）。'
                    : '这里无法开启；需要记忆时请新建会话。'}
                </div>
              ) : null}
            </section>
          </div>
        ) : (
          <>
            <div className="shrink-0 flex flex-col border-b border-gn-prompt-border/60 bg-gn-bg-dark/20">
              {loadError ? (
                <div className="border-b border-gn-warning/30 bg-gn-warning/10 px-4 py-1.5 text-[11.5px] text-gn-warning">
                  {loadError}（下面显示的是缓存列表）
                </div>
              ) : null}
              <div className="flex items-center gap-2 px-4 py-2.5">
                <div className="relative flex-1">
                  <Search
                    size={13}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gn-muted"
                    aria-hidden
                  />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        if (query) {
                          setQuery('')
                        } else {
                          searchRef.current?.blur()
                        }
                      }
                    }}
                    placeholder="搜索名称 / 路径 / 内容（按 / 聚焦）"
                    aria-label="搜索记忆文件"
                    className="h-8 w-full rounded border border-gn-prompt-border bg-gn-bg-dark pl-8 pr-7 text-[12px] text-gn-fg outline-none placeholder:text-gn-muted focus:border-gn-magenta transition-colors"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery('')
                        searchRef.current?.focus()
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg transition-colors"
                      aria-label="清空搜索"
                      title="清空"
                    >
                      <X size={12} aria-hidden />
                    </button>
                  ) : null}
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-gn-muted">
                  {shown.length}/{files.length}
                </span>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 gap-3 p-3 sm:p-4 md:grid-cols-[minmax(240px,2fr)_minmax(0,3fr)]">
              <div
                className={`min-h-0 flex-1 flex-col ${detailOnly ? 'hidden md:flex' : 'flex'}`}
              >
                <div
                  ref={listRef}
                  className="flex-1 min-h-0 overflow-y-auto pr-1"
                >
                  {shown.length === 0 ? (
                    <div className="flex h-full min-h-[140px] items-center justify-center p-6 text-center text-[11.5px] text-gn-muted">
                      没有匹配「{query}」的记忆文件
                    </div>
                  ) : (
                    groups.map((g) => (
                      <div key={g.label} className="mb-2.5">
                        <div className="sticky top-0 z-10 mb-1 flex items-center justify-between border-b border-gn-prompt-border/40 bg-gn-bg-base/95 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-gn-gutter backdrop-blur-xs">
                          <span className="text-gn-muted">{g.label}</span>
                          <span className="tabular-nums text-[9.5px] text-gn-gutter">{g.items.length}</span>
                        </div>
                        <ul className="flex flex-col gap-1">
                          {g.items.map((f) => (
                            <li key={f.path}>
                              <MemoryRow
                                file={f}
                                active={f.path === activePath}
                                onSelect={() => {
                                  setSelected(f.path)
                                  setConfirming(undefined)
                                  setDetailOnly(true)
                                }}
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div
                className={`min-h-0 flex-1 flex-col ${detailOnly ? 'flex' : 'hidden md:flex'}`}
              >
                <MemoryPreview
                  file={selectedFile}
                  preview={preview}
                  deletable={deletable}
                  confirming={confirming === selectedFile?.path}
                  copied={copied}
                  onBack={() => setDetailOnly(false)}
                  onCopy={() => {
                    if (!preview?.content) return
                    void navigator.clipboard.writeText(preview.content).then(() => {
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    })
                  }}
                  onAskDelete={() => setConfirming(selectedFile?.path)}
                  onCancelDelete={() => setConfirming(undefined)}
                  onConfirmDelete={() => void requestDelete()}
                />
              </div>
            </div>
          </>
        )}

        {notice ? (
          <div className="shrink-0 px-4 pb-2">
            <div
              className={`rounded border px-3 py-1.5 text-[11.5px] ${
                notice.error
                  ? 'border-gn-red/40 bg-gn-diff-del-bg/30 text-gn-red'
                  : 'border-gn-prompt-border bg-gn-bg-dark text-gn-fg2'
              }`}
            >
              {notice.text}
            </div>
          </div>
        ) : null}

        <footer className="gn-modal-footer shrink-0 flex flex-wrap items-center gap-2">
          <span className="ml-auto" />
          <button
            type="button"
            onClick={() => void memoryDream()}
            disabled={!listing?.enabled || !listing.dreamEnabled}
            title={listing?.dreamEnabled ? '整理记忆为主题（/dream）' : '本会话不可用 /dream'}
            className="min-h-8 rounded px-3 py-1 text-[12px] text-gn-fg2 hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
          >
            整理记忆
          </button>
          <button
            type="button"
            onClick={closeMemory}
            className="min-h-8 rounded border border-gn-prompt-border px-3.5 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight transition-colors"
          >
            关闭
          </button>
        </footer>
      </div>
    </div>
  )
}

function MemoryRow({
  file,
  active,
  onSelect,
}: {
  file: MemoryFileInfo
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active}
      className={`group w-full rounded border px-2.5 py-1.5 text-left transition-colors ${
        active
          ? 'border-gn-magenta/70 bg-gn-bg-highlight text-gn-fg shadow-xs'
          : 'border-gn-prompt-border/60 hover:border-gn-prompt-border hover:bg-gn-bg-highlight/50 text-gn-fg2'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-gn-fg">
          {memoryFileLabel(file)}
        </span>
        {file.generated ? (
          <span className="shrink-0 rounded border border-gn-prompt-border/60 bg-gn-bg-base px-1 text-[9.5px] text-gn-muted">
            索引
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gn-muted">
        <span className="min-w-0 flex-1 truncate">{baseName(file.path)}</span>
        <span className="shrink-0 tabular-nums">{memorySizeText(file)}</span>
      </div>
    </button>
  )
}

/** Why the row's delete is offered or refused — the store's own rule. */
function deleteHint(file: MemoryFileInfo, readable: boolean): string {
  if (!isMemoryFileDeletable(file)) {
    if (file.generated) return '索引文件由 store 生成，不可删除'
    if (file.sizeBytes > MEMORY_FORGET_MAX_FILE_BYTES) return '文件过大，store 不提供删除'
    return '只有 topics / observations/_inbox 笔记与会话日志可删除'
  }
  if (!readable) return '内容尚未完整读取，无法给出删除凭据'
  return '删除该记忆文件 (x)'
}

function MemoryPreview({
  file,
  preview,
  deletable,
  confirming,
  copied,
  onBack,
  onCopy,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  file?: MemoryFileInfo
  preview?: Preview
  deletable: boolean
  confirming: boolean
  copied: boolean
  onBack: () => void
  onCopy: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (contentRef.current) {
      if (typeof contentRef.current.scrollTo === 'function') {
        contentRef.current.scrollTo({ top: 0 })
      } else {
        contentRef.current.scrollTop = 0
      }
    }
  }, [file?.path])

  const lineCount = useMemo(() => {
    if (!preview?.content) return 0
    return preview.content.replace(/\n$/, '').split('\n').length
  }, [preview?.content])

  if (!file) {
    return (
      <div className="flex h-full w-full min-h-0 flex-col items-center justify-center rounded border border-gn-prompt-border bg-gn-bg-dark p-6 text-center text-[12px] text-gn-muted">
        <FileText size={20} className="mb-2 text-gn-muted/60" aria-hidden />
        <span>选择左侧文件以查看内容</span>
      </div>
    )
  }

  const ready = preview?.path === file.path && !preview.loading

  return (
    <div className="flex h-full w-full min-h-0 flex-col rounded border border-gn-prompt-border bg-gn-bg-dark overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base/40 px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded p-0.5 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg md:hidden"
          aria-label="返回列表"
        >
          <ChevronLeft size={14} aria-hidden />
        </button>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span
            className="min-w-0 truncate font-mono text-[11.5px] font-medium text-gn-path"
            title={file.path}
          >
            {file.path}
          </span>
          <span className="shrink-0 text-[10px] text-gn-muted tabular-nums">
            {memorySizeText(file)}
            {lineCount > 0 ? ` · ${lineCount} 行` : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          disabled={!ready || !preview?.content}
          className={`rounded p-1 transition-colors ${
            copied
              ? 'bg-gn-green/10 text-gn-green'
              : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
          } disabled:opacity-40`}
          aria-label="复制内容"
          title={copied ? '已复制' : '复制内容'}
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        </button>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onConfirmDelete}
              className="rounded bg-gn-diff-del-bg px-2 py-0.5 text-[10.5px] font-medium text-gn-red hover:opacity-90 transition-opacity"
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              className="rounded px-1.5 py-0.5 text-[10.5px] text-gn-fg2 hover:bg-gn-bg-highlight transition-colors"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onAskDelete}
            disabled={!deletable}
            title={deleteHint(file, Boolean(preview?.hash))}
            className="rounded p-1 text-gn-muted hover:bg-gn-diff-del-bg hover:text-gn-red disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            aria-label="删除记忆文件"
          >
            <Trash2 size={12} aria-hidden />
          </button>
        )}
      </div>

      <div
        ref={contentRef}
        className="flex-1 min-h-0 overflow-y-auto p-3.5 select-text"
      >
        {preview?.loading ? (
          <div className="flex h-full min-h-[160px] items-center justify-center text-[11.5px] text-gn-muted">
            正在读取…
          </div>
        ) : preview?.error ? (
          <div className="p-3 text-[11.5px] text-gn-red">读取失败: {preview.error}</div>
        ) : preview?.tooLarge ? (
          <div className="flex h-full min-h-[160px] items-center justify-center p-4 text-center text-[11.5px] text-gn-muted">
            （文件过大，未完整读取，无法预览或删除）
          </div>
        ) : preview?.content ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.6] text-gn-fg2">
            {preview.content}
          </pre>
        ) : (
          <div className="flex h-full min-h-[160px] items-center justify-center text-[11.5px] text-gn-muted">
            无内容
          </div>
        )}
      </div>
    </div>
  )
}

/** Notes already read for the filter, keyed by path (survives modal closes). */
const searchCache = new Map<string, string>()

/**
 * Bodies the filter matches against. Only runs once a query exists, and is
 * bounded the way the TUI bounds its own content cache (per note 256 KiB, 8 MiB
 * in total) so a large store cannot turn every keystroke into unbounded reads.
 * Unreadable notes cache as an empty body — never re-read on the next key.
 */
function useSearchContents(
  files: MemoryFileInfo[],
  query: string,
  open: boolean,
): Record<string, string> {
  const [contents, setContents] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open || !query.trim()) return
    const missing: MemoryFileInfo[] = []
    let budget = SEARCH_BYTES_TOTAL
    for (const f of files) {
      if (searchCache.has(f.path)) {
        budget -= Math.min(searchCache.get(f.path)?.length ?? 0, SEARCH_BYTES_PER_NOTE)
        continue
      }
      if (budget <= 0) break
      missing.push(f)
    }
    if (!missing.length) {
      // Everything is cached already; sync the state once.
      setContents((prev) => (Object.keys(prev).length ? prev : snapshotSearchCache(files)))
      return
    }
    let cancelled = false
    void Promise.all(
      missing.map(async (f) => {
        try {
          const { content } = await transport.fsReadFile(f.path)
          searchCache.set(f.path, content.slice(0, SEARCH_BYTES_PER_NOTE))
        } catch {
          searchCache.set(f.path, '')
        }
      }),
    ).then(() => {
      if (cancelled) return
      setContents(snapshotSearchCache(files))
    })
    return () => {
      cancelled = true
    }
  }, [open, query, files])
  return contents
}

function snapshotSearchCache(files: MemoryFileInfo[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files) {
    const hit = searchCache.get(f.path)
    if (hit !== undefined) out[f.path] = hit
  }
  return out
}
