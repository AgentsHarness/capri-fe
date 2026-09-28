import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  CircleAlert,
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  RotateCcw,
  X,
} from 'lucide-react'
import { createLocalDir, listLocalDirs, type LocalDirEntry } from '../api/localFs'
import { isRootedLocalPath, joinLocalPath, parentOfLocalPath } from '../lib/localPaths'

/**
 * 目录选择弹窗（空状态「选择工作目录」的落地）。
 *
 * 列目录走 host 本地端点 `POST /api/local/dirs`（host 侧 os.ReadDir，不经
 * agent、也不经 `!` shell 通道）：返回的是宿主原生路径，Windows 上也接受
 * MSYS 写法（`/d/aiwork` → `D:\aiwork`）。前端不做路径拼接与平台判断 ——
 * 子项目直接用返回的 path，上级用字面路径交给 host 归一化（见 localPaths.ts）。
 *
 * 「选择此目录」只认**已经被 host 成功列出**的目录：手改路径后直接点它会先
 * 验一遍，路径不存在 / 不是目录就只报错、不回落到别的目录，避免把不存在的
 * 路径写进 emptyCwd。当前目录下还能新建文件夹（host 侧 mkdir，建好直接进入）。
 */

interface DirectoryPickerModalProps {
  open: boolean
  /** 优先起始目录（当前 emptyCwd，可空 → 宿主主目录）。 */
  initial?: string
  onClose: () => void
  /** 选中目录时回调（写入 emptyCwd），参数是宿主归一化后的绝对路径。 */
  onPick: (dir: string) => void
}

export function DirectoryPickerModal({
  open,
  initial,
  onClose,
  onPick,
}: DirectoryPickerModalProps) {
  /** host 确认过的当前目录（归一化后的宿主原生路径）；'' = 还没有可用的目录。 */
  const [dir, setDir] = useState('')
  const [draft, setDraft] = useState('')
  const [home, setHome] = useState('')
  const [dirs, setDirs] = useState<LocalDirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [choosing, setChoosing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newBusy, setNewBusy] = useState(false)
  const [newError, setNewError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const req = useRef(0)

  const resetCreate = useCallback(() => {
    setCreating(false)
    setNewName('')
    setNewError(undefined)
  }, [])

  /**
   * 载入并确认一个目录。成功返回 host 归一化后的路径（同时更新输入框）；
   * 失败把原因写进 error 并清掉「当前目录」——未确认的路径既不能选，也不能
   * 在其下面新建文件夹。换目录时收起新建输入行（它属于上一个目录）。
   */
  const load = useCallback(
    async (target: string): Promise<string | undefined> => {
      const id = ++req.current
      resetCreate()
      setLoading(true)
      setError(undefined)
      const res = await listLocalDirs(target)
      if (id !== req.current) return undefined
      setLoading(false)
      if (!res.ok) {
        setDir('')
        setDirs([])
        setError(res.error)
        setDraft(res.path ?? target)
        return undefined
      }
      setDir(res.path)
      setDraft(res.path)
      setHome(res.home)
      setDirs(res.dirs)
      return res.path
    },
    [resetCreate],
  )

  // 打开时初始化：优先 emptyCwd，空则让宿主给主目录。
  useEffect(() => {
    if (!open) return
    req.current = 0
    setDirs([])
    setError(undefined)
    resetCreate()
    void load(initial?.trim() || '')
  }, [open, initial, load, resetCreate])

  // 进入/切换目录后聚焦并选中路径输入框，方便直接改写。
  useEffect(() => {
    if (open) inputRef.current?.select()
  }, [open, dir])

  // 新建文件夹输入行展开时聚焦；Esc 先收这一行，再谈关弹窗。
  useEffect(() => {
    if (creating) nameRef.current?.focus()
  }, [creating])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (creating) {
        resetCreate()
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, creating, resetCreate])

  if (!open) return null

  const raw = draft.trim()
  const target = raw || dir
  // 上级按钮针对「看得见的这条路径」：草稿带起点就按草稿爬，否则按已确认的
  // 当前目录爬（相对草稿的上级不该被解释成主目录下的路径）。
  const upTarget = parentOfLocalPath(raw && isRootedLocalPath(raw) ? raw : dir)
  const knownInvalid = !!error && target !== dir
  const canPick = !loading && !choosing && !!target && !knownInvalid

  const submitDraft = () => {
    if (!raw || raw === dir) return
    void load(isRootedLocalPath(raw) ? raw : joinLocalPath(dir, raw))
  }

  const choose = async () => {
    if (!canPick) return
    setChoosing(true)
    try {
      let resolved: string | undefined = dir
      if (target !== dir) {
        resolved = await load(isRootedLocalPath(target) ? target : joinLocalPath(dir, target))
      }
      if (!resolved) return // 未确认：load 已把原因写进 error，弹窗不关
      onPick(resolved)
      onClose()
    } finally {
      setChoosing(false)
    }
  }

  const cancelCreate = () => {
    resetCreate()
  }

  const submitCreate = async () => {
    const name = newName.trim()
    if (!dir || newBusy) return
    if (!name) {
      setNewError('请输入文件夹名称')
      return
    }
    if (name === '.' || name === '..') {
      setNewError(`文件夹名称无效：${name}`)
      return
    }
    if (name.includes('/') || name.includes('\\')) {
      setNewError('文件夹名称不能包含路径分隔符')
      return
    }
    setNewBusy(true)
    setNewError(undefined)
    const res = await createLocalDir(dir, name)
    setNewBusy(false)
    if (!res.ok) {
      setNewError(res.error)
      return
    }
    cancelCreate()
    await load(res.path) // 建好就直接进去，接着点「选择此目录」
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="选择工作目录"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div tabIndex={-1} className="mt-8 w-full max-w-[480px] gn-modal-panel">
        <header className="gn-modal-header">
          <span className="text-[13px] font-bold text-gn-fg">选择工作目录</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (upTarget && !loading) void load(upTarget)
              }}
              disabled={!upTarget || loading}
              className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40 disabled:hover:bg-transparent"
              title="上级目录"
            >
              <ArrowUp size={12} aria-hidden />
              上级
            </button>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // 输入法组字中的 Enter 是上屏候选词，不是「跳转」
                // （中文目录名按回车选词会拿半截路径去跳）。
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') submitDraft()
              }}
              spellCheck={false}
              placeholder="路径或 ~（回车跳转）"
              className="min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gutter/70 focus:border-gn-cyan/50"
            />
            <button
              type="button"
              onClick={() => {
                if (creating) cancelCreate()
                else {
                  setCreating(true)
                  setNewName('')
                  setNewError(undefined)
                }
              }}
              disabled={!dir || loading}
              className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40 disabled:hover:bg-transparent"
              title="在当前目录新建文件夹"
            >
              <FolderPlus size={12} aria-hidden />
              新建文件夹
            </button>
          </div>

          {creating && (
            <div className="mt-2 flex items-center gap-2">
              <input
                ref={nameRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') void submitCreate()
                }}
                spellCheck={false}
                placeholder="新文件夹名称"
                className="min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gutter/70 focus:border-gn-cyan/50"
              />
              <button
                type="button"
                onClick={() => void submitCreate()}
                disabled={newBusy || !newName.trim()}
                className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-cyan hover:bg-gn-bg-highlight disabled:opacity-40 disabled:hover:bg-transparent"
                title="创建并进入新文件夹"
              >
                {newBusy ? (
                  <LoaderCircle size={12} className="animate-spin" aria-hidden />
                ) : (
                  <Check size={12} aria-hidden />
                )}
                创建
              </button>
              <button
                type="button"
                onClick={cancelCreate}
                className="shrink-0 rounded p-1 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                aria-label="取消新建文件夹"
                title="取消新建 (Esc)"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          )}
          {newError && <div className="mt-1.5 text-[11px] text-gn-red">{newError}</div>}

          <div className="mt-3 max-h-[280px] overflow-y-auto rounded border border-gn-prompt-border/60">
            {loading ? (
              <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-[11px] text-gn-muted">
                <LoaderCircle size={12} className="animate-spin" aria-hidden />
                读取目录…
              </div>
            ) : error ? (
              <div className="px-3 py-6 text-center">
                <div className="inline-flex items-center gap-1.5 text-left text-[11px] text-gn-red">
                  <CircleAlert size={12} className="shrink-0" aria-hidden />
                  {error}
                </div>
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => void load(raw || dir)}
                    className="inline-flex items-center gap-1 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    <RotateCcw size={11} aria-hidden />
                    重试
                  </button>
                </div>
              </div>
            ) : dirs.length === 0 ? (
              <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-[11px] text-gn-muted">
                <FolderOpen size={12} aria-hidden />
                此目录没有子目录
              </div>
            ) : (
              dirs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onClick={() => void load(d.path)}
                  className="flex w-full items-center gap-2 border-b border-gn-prompt-border/40 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-gn-bg-highlight"
                  title={d.path}
                >
                  <Folder size={12} className="shrink-0 text-gn-cyan" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-gn-fg">
                    {d.name}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div
              className="min-w-0 truncate font-mono text-[10px] text-gn-gutter"
              title={target || home}
            >
              当前：{target || home || '—'}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void choose()}
                disabled={!canPick}
                title={knownInvalid ? '路径不可用：先按回车确认或修正路径' : '把当前目录作为工作目录'}
                className="rounded bg-gn-bg-highlight px-3 py-1 text-[11px] text-gn-cyan hover:bg-gn-bg-dark disabled:opacity-40"
              >
                选择此目录
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
