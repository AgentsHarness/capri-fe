import { useState } from 'react'
import { useChatStore } from '../../store/chat'
import { transport } from '../../api/client'
import { DirectoryPickerModal } from '../DirectoryPickerModal'
import { useWorktreeGate } from './useWorktreeGate'

/** "Agents" 与 "Herness" 两段字符画（空状态居中 logo）。figlet「lean」风格，
 *  纯 ASCII 字符（_ / \ |），各平台等宽字体里对齐稳定。构建时去掉每行尾随
 *  空格并把每行补齐到同一宽度（保持字母原有左对齐），由外层居中。 */
const buildBlock = (rows: string[]) => {
  const trimmed = rows.map((l) => l.trimEnd())
  const w = Math.max(...trimmed.map((l) => l.length))
  return trimmed.map((l) => l.padEnd(w)).join('\n')
}
const AGENTS_ART = buildBlock([
  '  _                    _       ',
  '  /_\\   __ _  ___ _ __ | |_ ___ ',
  ' //_\\\\ / _` |/ _ \\ \'_ \\| __/ __|',
  '/  _  \\ (_| |  __/ | | | |_\\__ \\',
  '\\_/ \\_/\\__, |\\___|_| |_|\\__|___/',
  '       |___/                     ',
])
const HERNESS_ART = buildBlock([
  '  /\\  /\\__ _ _ __ _ __   ___  ___ ___ ',
  ' / /_/ / _` | \'__| \'_ \\ / _ \\/ __/ __|',
  '/ __  / (_| | |  | | | |  __/\\__ \\__ \\',
  '\\/ /_/ \\__,_|_|  |_| |_|\\___||___/___/',
  '                                     ',
])

/** 空状态：无活动会话时的引导。居中显示 AGENTS 字符画，下方是「选择工作目录」
 *  入口（点开弹出 DirectoryPickerModal，底层复用 `!` shell 通道）。目录不选
 *  则留空用宿主默认目录；没有"开始"按钮——发送消息即等于开始新对话。
 *  已选目录且在 git 仓库里时，额外出现「在新 worktree 中开始」：为仓库新建
 *  一个 git worktree 并把 emptyCwd 切到 worktree 路径，仍由「发消息即开新
 *  会话」的既有流程接管。 */
export function EmptyStatePicker() {
  const emptyCwd = useChatStore((s) => s.emptyCwd)
  const setEmptyCwd = useChatStore((s) => s.setEmptyCwd)
  const [picking, setPicking] = useState(false)
  const gate = useWorktreeGate(emptyCwd)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()
  const [wtPathDraft, setWtPathDraft] = useState('')

  const handleCreate = async () => {
    if (creating || gate.status !== 'ready') return
    setCreating(true)
    setCreateError(undefined)
    const customPath = wtPathDraft.trim()
    try {
      const raw = await transport.gitWorktreeCreate({
        sourcePath: gate.repoRoot,
        ...(customPath ? { worktreePath: customPath } : {}),
        copyMode: 'dirty',
      })
      const o = (raw ?? {}) as Record<string, unknown>
      const wt =
        (typeof o.worktreePath === 'string' && o.worktreePath) ||
        (typeof o.worktree_path === 'string' && o.worktree_path) ||
        ''
      if (!wt) throw new Error('创建 worktree 失败：响应缺少 worktree 路径')
      setEmptyCwd(wt)
      setWtPathDraft('')
      // 目录行随 emptyCwd 就地更新为 worktree 路径；TopBar 状态行
      // （空状态也可见）再给一条明确反馈。不在这里新开会话——
      // 后续首条消息经 send 的 emptyCwd 流程自然开新会话。
      useChatStore.setState({ statusText: `已切换到新 worktree：${wt}，发送消息即开始` })
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center px-4 pt-8 min-[481px]:pt-20">
      <div className="flex w-full justify-center">
        <div className="flex flex-col items-center">
          <pre className="select-none whitespace-pre font-mono text-[9px] leading-[1.05] text-gn-fg min-[481px]:text-[14px]">
            {AGENTS_ART}
          </pre>
        </div>
      </div>
      <div className="flex w-full justify-center">
        <div className="flex flex-col items-center">
          <pre className="select-none whitespace-pre font-mono text-[9px] leading-[1.05] text-gn-fg min-[481px]:text-[14px]">
            {HERNESS_ART}
          </pre>
        </div>
      </div>
      <div className="mt-6 select-none text-[13px] font-normal tracking-wide text-gn-muted/80">
        for Grok Build <span className="text-gn-gutter/60">1.0.13</span>
      </div>
      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="inline-flex items-center gap-1.5 text-[12px] text-gn-muted transition-colors hover:text-gn-fg"
          title="选择新会话的工作目录"
        >
          <svg
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5 shrink-0"
            style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }}
            aria-hidden
          >
            <path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 2H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4Z" />
          </svg>
          选择工作目录
        </button>
        {emptyCwd?.trim() ? (
          <>
            <div
              className="mx-auto mt-1.5 max-w-[300px] truncate font-mono text-[11px] text-gn-cyan"
              title={emptyCwd}
            >
              {emptyCwd}
            </div>
            {/* 「在新 worktree 中开始」：仅在已选目录且该目录是 git 仓库时
                可点。探测中显示禁用占位；非 git 仓库 → 置灰 + title 说明。 */}
            <div className="mx-auto mt-3 flex w-full max-w-[320px] flex-col items-center gap-2">
              {gate.status === 'ready' ? (
                <>
                  <input
                    value={wtPathDraft}
                    onChange={(e) => setWtPathDraft(e.target.value)}
                    disabled={creating}
                    spellCheck={false}
                    placeholder="worktree 路径（可选，留空自动命名）"
                    className="w-full min-w-0 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[11px] text-gn-fg outline-none placeholder:text-gn-gutter/70 focus:border-gn-cyan/50 disabled:opacity-40"
                  />
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => void handleCreate()}
                    className="inline-flex items-center gap-1.5 rounded border border-gn-cyan/50 px-3 py-1 text-[12px] text-gn-cyan transition-colors hover:bg-gn-bg-highlight disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                    title="为当前目录新建 git worktree，并把新会话的工作目录切到 worktree 上"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }}
                      aria-hidden
                    >
                      <path d="M3.5 2.5v7a3 3 0 0 0 3 3H12" />
                      <circle cx="3.5" cy="2.5" r="1.5" />
                      <circle cx="3.5" cy="12.5" r="1.5" />
                      <circle cx="12" cy="12.5" r="1.5" />
                    </svg>
                    {creating ? '正在创建 worktree…' : '在新 worktree 中开始'}
                  </button>
                </>
              ) : gate.status === 'checking' || gate.status === 'idle' ? (
                <button
                  type="button"
                  disabled
                  className="inline-flex cursor-default items-center gap-1.5 text-[12px] text-gn-muted disabled:opacity-60"
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }}
                    aria-hidden
                  >
                    <path d="M3.5 2.5v7a3 3 0 0 0 3 3H12" />
                    <circle cx="3.5" cy="2.5" r="1.5" />
                    <circle cx="3.5" cy="12.5" r="1.5" />
                    <circle cx="12" cy="12.5" r="1.5" />
                  </svg>
                  正在检查 git 仓库…
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="inline-flex cursor-default items-center gap-1.5 text-[12px] text-gn-muted disabled:opacity-40"
                  title={gate.reason}
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }}
                    aria-hidden
                  >
                    <path d="M3.5 2.5v7a3 3 0 0 0 3 3H12" />
                    <circle cx="3.5" cy="2.5" r="1.5" />
                    <circle cx="3.5" cy="12.5" r="1.5" />
                    <circle cx="12" cy="12.5" r="1.5" />
                  </svg>
                  在新 worktree 中开始
                </button>
              )}
              {createError && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gn-red">{createError}</span>
                  <button
                    type="button"
                    onClick={() => void handleCreate()}
                    className="rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="mt-1.5 text-[11px] text-gn-gutter">
            发送消息即可从此工作目录开始新对话
          </div>
        )}
      </div>
      <DirectoryPickerModal
        open={picking}
        initial={emptyCwd}
        onClose={() => setPicking(false)}
        onPick={setEmptyCwd}
      />
    </div>
  )
}
