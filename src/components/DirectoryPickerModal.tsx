import { useCallback, useEffect, useRef, useState } from 'react'
import { runShellCommand } from '../api/shell'

/**
 * 目录选择弹窗（空状态「选择工作目录」的落地）。
 *
 * 底层实现参考 `!` shell 模式：走 `/api/shell`（TUI shell-mode bridge），
 * 在宿主机上用 `find` 列出当前目录的直接子目录——同一套机制就是跑 `!`
 * shell 命令的那个通道。`find` 命令以 cwd=dir 运行，输出 `./name` 相对
 * 路径，这里在 JS 侧拼回绝对路径，避免命令里转义引号/特殊字符。
 *
 * 交互：↑ 上级 / 点目录进入 / 可手改路径后回车；「选择此目录」把当前
 * 目录回传给 store（setEmptyCwd），随后的首条消息用它创建会话。
 */

interface DirectoryPickerModalProps {
  open: boolean
  /** 优先起始目录（当前 emptyCwd，可空 → 用宿主当前工作目录）。 */
  initial?: string
  onClose: () => void
  /** 选中目录时回调（写入 emptyCwd）。 */
  onPick: (dir: string) => void
}

function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? base + name : base + '/' + name
}

/** 上级目录；已在根或相对单段时返回 null（不可再上）。 */
function parentDir(dir: string): string | null {
  const t = dir.replace(/\/+$/, '')
  if (!t || t === '/') return null
  const idx = t.lastIndexOf('/')
  if (idx <= 0) return '/'
  return t.slice(0, idx)
}

interface DirEntry {
  name: string
  path: string
}

/** 列出一个目录的直接子目录（绝对路径）。exitCode!=0（目录不存在等）按错误处理。 */
async function listDirs(dir: string): Promise<DirEntry[]> {
  const res = await runShellCommand('find . -maxdepth 1 -type d', dir)
  if (!res.ok) throw new Error(res.error || '无法列出目录')
  if (res.exitCode != null && res.exitCode !== 0) {
    throw new Error((res.stderr || '').trim() || `无法读取目录：${dir}`)
  }
  return (res.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '.')
    .map((l) => {
      const name = l.startsWith('./') ? l.slice(2) : l
      return { name, path: joinPath(dir, name) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function DirectoryPickerModal({
  open,
  initial,
  onClose,
  onPick,
}: DirectoryPickerModalProps) {
  const [dir, setDir] = useState('')
  const [draft, setDraft] = useState('')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const req = useRef(0)

  const load = useCallback(async (d: string) => {
    const id = ++req.current
    setLoading(true)
    setError(undefined)
    try {
      const list = await listDirs(d)
      if (id !== req.current) return
      setDirs(list)
    } catch (e) {
      if (id !== req.current) return
      setError(e instanceof Error ? e.message : String(e))
      setDirs([])
    } finally {
      if (id === req.current) setLoading(false)
    }
  }, [])

  // 打开时初始化：优先 emptyCwd，否则用宿主当前工作目录（echo $PWD）。
  useEffect(() => {
    if (!open) return
    req.current = 0
    setError(undefined)
    setDirs([])
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        let start = initial?.trim() || ''
        if (!start) {
          const h = await runShellCommand('echo "$PWD"')
          start = h.ok ? (h.stdout ?? '').trim() : ''
        }
        if (cancelled) return
        setDir(start || '/')
        setDraft(start || '/')
        await load(start || '/')
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, initial, load])

  // 进入/切换目录后聚焦并选中路径输入框，方便直接改写。
  useEffect(() => {
    if (open) inputRef.current?.select()
  }, [open, dir])

  // Esc 关闭。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const goUp = () => {
    const p = parentDir(dir)
    if (p && p !== dir) {
      setDir(p)
      setDraft(p)
      void load(p)
    }
  }

  const enter = (p: string) => {
    setDir(p)
    setDraft(p)
    void load(p)
  }

  const submitDraft = () => {
    const p = draft.trim()
    if (p && p !== dir) enter(p)
  }

  // 取当前生效目录：优先用户改过的路径，否则当前浏览目录。
  const current = draft.trim() || dir || '/'

  const choose = () => {
    onPick(current)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="选择工作目录"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        tabIndex={-1}
        className="mt-8 w-full max-w-[480px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="text-[13px] font-bold text-gn-fg">选择工作目录</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goUp}
              disabled={!parentDir(dir)}
              className="shrink-0 rounded border border-gn-prompt-border px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40 disabled:hover:bg-transparent"
              title="上级目录"
            >
              ↑ 上级
            </button>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitDraft()
              }}
              spellCheck={false}
              placeholder="路径或 ~（回车跳转）"
              className="min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gutter/70 focus:border-gn-cyan/50"
            />
          </div>

          <div className="mt-3 max-h-[280px] overflow-y-auto rounded border border-gn-prompt-border/60">
            {loading ? (
              <div className="px-3 py-6 text-center text-[11px] text-gn-muted">读取目录…</div>
            ) : error ? (
              <div className="px-3 py-6 text-center">
                <div className="text-[11px] text-gn-red">{error}</div>
                <button
                  type="button"
                  onClick={() => void load(dir)}
                  className="mt-2 rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                >
                  重试
                </button>
              </div>
            ) : dirs.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-gn-muted">此目录没有子目录</div>
            ) : (
              dirs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onClick={() => enter(d.path)}
                  className="flex w-full items-center gap-2 border-b border-gn-prompt-border/40 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-gn-bg-highlight"
                  title={d.path}
                >
                  <span className="shrink-0 text-[11px] text-gn-cyan">▸</span>
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
              title={current}
            >
              当前：{current}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={choose}
                className="rounded border border-gn-cyan/50 bg-gn-bg-highlight px-3 py-1 text-[11px] text-gn-cyan hover:bg-gn-bg-dark"
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
