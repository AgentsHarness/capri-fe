import { useState } from 'react'
import { useChatStore } from '../../store/chat'
import { DirectoryPickerModal } from '../DirectoryPickerModal'

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
 *  则留空用宿主默认目录；没有"开始"按钮——发送消息即等于开始新对话。 */
export function EmptyStatePicker() {
  const emptyCwd = useChatStore((s) => s.emptyCwd)
  const setEmptyCwd = useChatStore((s) => s.setEmptyCwd)
  const [picking, setPicking] = useState(false)
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
        for Grok Build <span className="text-gn-gutter/60">1.0.0</span>
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
          <div
            className="mx-auto mt-1.5 max-w-[300px] truncate font-mono text-[11px] text-gn-cyan"
            title={emptyCwd}
          >
            {emptyCwd}
          </div>
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
