import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { recentWorkspaceDirs } from '../../store/workspaceDirs'
import { repoNameFromCwd } from '../../store/historyGroups'
import { DirectoryPickerModal } from '../ui/DirectoryPickerModal'
import { ChipDropdown } from '../ui/ChipDropdown'
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

/** 空状态：无活动会话时的引导。居中显示 AGENTS 字符画，下方是「快速选择」
 *  （侧边栏已有的工作目录）、「选择工作目录」入口（点开弹出
 *  DirectoryPickerModal，走 host 本地目录端点 /api/local/dirs）。
 *  目录不选则留空用宿主默认目录；没有"开始"按钮——发送消息即等于开始新对话。
 *
 *  「使用 Worktree」是状态开关而不是建目录动作：按下只记意图（按钮变成
 *  「关闭 Worktree」），首条消息发出时才为当前目录新建 git worktree 并把
 *  会话目录切到它上面（见 store/chat/send.ts）——与 TUI 的 worktree 模式
 *  一致：开关只表达意图，真正落盘发生在建会话那一刻。 */
export function EmptyStatePicker() {
  const emptyCwd = useChatStore((s) => s.emptyCwd)
  const setEmptyCwd = useChatStore((s) => s.setEmptyCwd)
  const emptyWorktree = useChatStore((s) => s.emptyWorktree === true)
  const setEmptyWorktree = useChatStore((s) => s.setEmptyWorktree)
  const emptyWorktreePath = useChatStore((s) => s.emptyWorktreePath ?? '')
  const setEmptyWorktreePath = useChatStore((s) => s.setEmptyWorktreePath)
  const emptyWorktreeBusy = useChatStore((s) => s.emptyWorktreeBusy === true)
  const workspaces = useChatStore((s) => s.workspaces)
  const sessions = useChatStore((s) => s.sessions)
  const [picking, setPicking] = useState(false)
  const gate = useWorktreeGate(emptyCwd)
  const [quickOpen, setQuickOpen] = useState(false)
  const quickRef = useRef<HTMLDivElement>(null)
  const recentDirs = recentWorkspaceDirs(workspaces, sessions)

  // 目录换到非 git 仓库时开关失去意义：直接复位，别让按钮停在一个做不到的
  // 状态上（发送时也不会去建 worktree）。
  useEffect(() => {
    if (emptyWorktree && gate.status === 'not-repo') setEmptyWorktree(false)
  }, [emptyWorktree, gate.status, setEmptyWorktree])

  const pickDir = (dir: string) => {
    setEmptyCwd(dir)
    setQuickOpen(false)
  }

  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center px-4 pt-8 min-[481px]:pt-20">
      <div className="flex w-full justify-center">
        <div className="flex flex-col items-center">
          <pre className="select-none whitespace-pre font-art text-[9px] leading-[1.05] text-gn-fg min-[481px]:text-[14px]">
            {AGENTS_ART}
          </pre>
        </div>
      </div>
      <div className="flex w-full justify-center">
        <div className="flex flex-col items-center">
          <pre className="select-none whitespace-pre font-art text-[9px] leading-[1.05] text-gn-fg min-[481px]:text-[14px]">
            {HERNESS_ART}
          </pre>
        </div>
      </div>
      <div className="mt-6 select-none text-[13px] font-normal tracking-wide text-gn-muted/80">
        for Grok Build <span className="text-gn-gutter/60">1.0.41</span>
      </div>
      <div className="mt-6 flex flex-col items-center text-center">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          {recentDirs.length > 0 && (
            <div ref={quickRef} className="relative inline-flex">
              <button
                type="button"
                onClick={() => setQuickOpen((v) => !v)}
                aria-expanded={quickOpen}
                aria-haspopup="menu"
                className="inline-flex items-center gap-1.5 text-[12px] text-gn-muted transition-colors hover:text-gn-fg"
                title="从侧边栏已有的工作目录中快速选择"
              >
                <Folder size={13} aria-hidden />
                快速选择
                <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-gn-gutter" aria-hidden />
              </button>
              <ChipDropdown
                open={quickOpen}
                onClose={() => setQuickOpen(false)}
                label="最近的工作目录"
                widthClass="w-80"
                anchorRef={quickRef}
              >
                {recentDirs.map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    role="menuitem"
                    onClick={() => pickDir(dir)}
                    title={dir}
                    className={`flex w-full min-h-8 items-center gap-2 px-3 py-1.5 text-left hover:bg-gn-bg-highlight ${
                      dir === emptyCwd ? 'text-gn-cyan' : 'text-gn-muted hover:text-gn-fg'
                    }`}
                  >
                    <FolderOpen size={12} className="shrink-0" aria-hidden />
                    {/* 主行用侧边栏的短名，第二行是完整路径：目录多时按名字
                        认得出来，同名不同盘时路径仍能区分。 */}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{repoNameFromCwd(dir)}</span>
                      <span className="block truncate font-mono text-[10px] text-gn-gutter">
                        {dir}
                      </span>
                    </span>
                  </button>
                ))}
              </ChipDropdown>
            </div>
          )}
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
        </div>
        {emptyCwd?.trim() ? (
          <>
            <div
              className="mx-auto mt-1.5 max-w-[300px] truncate font-mono text-[11px] text-gn-cyan"
              title={emptyCwd}
            >
              {emptyCwd}
            </div>
            {/* Worktree 开关：仅在已选目录时出现；非 git 仓库 / 探测中置灰。
                按下只翻转意图，首条消息发出时才真正建 worktree。 */}
            <div className="mx-auto mt-3 flex w-full max-w-[320px] flex-col items-center gap-2">
              {gate.status === 'ready' ? (
                <button
                  type="button"
                  disabled={emptyWorktreeBusy}
                  aria-pressed={emptyWorktree}
                  onClick={() => setEmptyWorktree(!emptyWorktree)}
                  className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-[12px] text-gn-cyan transition-colors hover:bg-gn-bg-highlight disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                  title={
                    emptyWorktree
                      ? '关闭 worktree 模式：首条消息直接在所选目录里建会话'
                      : '为当前目录新建 git worktree，首条消息在 worktree 里建会话'
                  }
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
                  {emptyWorktree ? '关闭 Worktree' : '使用 Worktree'}
                </button>
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
                  使用 Worktree
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
                  使用 Worktree
                </button>
              )}
              {emptyWorktree && gate.status === 'ready' && (
                <>
                  <input
                    value={emptyWorktreePath}
                    onChange={(e) => setEmptyWorktreePath(e.target.value)}
                    disabled={emptyWorktreeBusy}
                    spellCheck={false}
                    placeholder="worktree 路径（可选，留空自动命名）"
                    className="w-full min-w-0 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[11px] text-gn-fg outline-none placeholder:text-gn-gutter/70 focus:border-gn-cyan/50 disabled:opacity-40"
                  />
                  <div className="text-[11px] text-gn-gutter">
                    {emptyWorktreeBusy
                      ? '正在创建 worktree…'
                      : '发送消息时创建 worktree，会话在新 worktree 中开始'}
                  </div>
                </>
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
