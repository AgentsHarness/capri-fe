import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { PendingReq } from '../api/types'

// ── chat store mock：pending / respondPermission / resetPermissions ──
const h = vi.hoisted(() => {
  const chatState: Record<string, unknown> = {}
  return { chatState }
})

vi.mock('../store/chat', () => ({
  useChatStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel(h.chatState),
    { getState: () => h.chatState },
  ),
}))

import { ApprovalStrip } from './ApprovalStrip'
import { applyUiSettings } from '../store/settings'

const respond = vi.fn()
const resetPermissions = vi.fn()

function setPending(pending: PendingReq[]) {
  Object.assign(h.chatState, { pending })
}

function req(over: Record<string, unknown>): PendingReq {
  return { requestId: 'r1', method: 'bash', params: {}, ...over } as PendingReq
}

const bashOptions: Array<Record<string, unknown>> = [
  { optionId: 'allow', name: '允许一次' },
  { optionId: 'allow-always-command', name: '始终允许该命令' },
  { optionId: 'reject', name: '拒绝' },
]

beforeEach(() => {
  for (const k of Object.keys(h.chatState)) delete h.chatState[k]
  Object.assign(h.chatState, {
    pending: [],
    respondPermission: respond,
    resetPermissions,
    cwd: undefined,
    sessionId: 'root',
    subagentIndex: {},
    entries: [],
  })
  respond.mockClear()
  resetPermissions.mockClear()
  applyUiSettings({}) // remember_tool_approvals 默认 false
})

function key(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(window, { key, ...init })
}

describe('ApprovalStrip — 渲染', () => {
  it('无 pending → null', () => {
    const { container } = render(<ApprovalStrip />)
    expect(container.firstChild).toBeNull()
  })

  it('bash 请求：waiting on you + method + 命令 + 选项行', () => {
    setPending([
      req({
        params: {
          toolCall: { title: 'ls -la' },
          options: bashOptions,
        },
      }),
    ])
    const { container } = render(<ApprovalStrip />)
    expect(container.textContent).toContain('waiting on you')
    expect(container.textContent).toContain('bash')
    expect(container.textContent).toContain('ls -la')
    // remember_tool_approvals=false → always 行被过滤
    expect(screen.getByRole('button', { name: /允许一次/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /拒绝/ })).not.toBeNull()
    expect(screen.queryByText(/始终允许该命令/)).toBeNull()
    expect(container.textContent).toContain('↑/↓ 或 j/k 选择')
  })

  it('remember_tool_approvals=true → always 行显示（含 always 徽标 + scope）', () => {
    applyUiSettings({ remember_tool_approvals: true })
    setPending([
      req({
        params: {
          toolCall: { title: 'ls -la' },
          options: bashOptions,
        },
      }),
    ])
    const { container } = render(<ApprovalStrip />)
    expect(container.textContent).toContain('始终允许该命令')
    expect(container.textContent).toContain('always')
    expect(container.textContent).toContain('精确')
    expect(container.textContent).toContain('←/→ 调整始终允许范围')
  })

  it('只有 always 选项时不过滤（防止空卡）', () => {
    setPending([
      req({
        params: { options: [{ optionId: 'allow-always-mcp', name: '允许' }] },
      }),
    ])
    const { container } = render(<ApprovalStrip />)
    expect(container.textContent).toContain('允许')
  })

  it('重置权限规则按钮 → resetPermissions', () => {
    setPending([req({ params: { options: bashOptions } })])
    render(<ApprovalStrip />)
    fireEvent.click(screen.getByRole('button', { name: '重置权限规则' }))
    expect(resetPermissions).toHaveBeenCalled()
  })

  it('多行命令折叠：>5 行显示截断 + Ctrl-F 提示；Ctrl+F 展开', () => {
    const lines = Array.from({ length: 7 }, (_, i) => `echo line ${i}`).join('\n')
    setPending([
      req({
        params: {
          toolCall: { title: lines },
          options: [{ optionId: 'allow', name: '允许一次' }],
        },
      }),
    ])
    const { container } = render(<ApprovalStrip />)
    expect(container.textContent).toContain('… Ctrl-F to expand')
    expect(container.textContent).toContain('Ctrl+F 展开命令')
    expect(container.textContent).not.toContain('echo line 6')
    key('f', { ctrlKey: true })
    expect(container.textContent).toContain('echo line 6')
    expect(container.textContent).not.toContain('… Ctrl-F to expand')
  })
})

describe('ApprovalStrip — 鼠标操作', () => {
  it('点击选项 → respondPermission(optionId)', () => {
    setPending([req({ params: { options: bashOptions } })])
    render(<ApprovalStrip />)
    fireEvent.click(screen.getByRole('button', { name: /允许一次/ }))
    expect(respond).toHaveBeenCalledWith('r1', 'allow', false, undefined)
  })

  it('点击 always 选项 → 带默认 scope（精确 = 全词）', () => {
    applyUiSettings({ remember_tool_approvals: true })
    setPending([
      req({
        params: {
          toolCall: { title: 'ls -la', rawInput: {} },
          options: bashOptions,
        },
      }),
    ])
    render(<ApprovalStrip />)
    fireEvent.click(screen.getByRole('button', { name: /始终允许该命令/ }))
    expect(respond).toHaveBeenCalledWith(
      'r1',
      'allow-always-command',
      false,
      { commandParts: ['ls', '-la'], isGlob: false },
    )
  })

  it('顶部 reject 按钮（无 reject 选项）→ 直接取消', () => {
    setPending([
      req({ params: { options: [{ optionId: 'allow', name: '允许一次' }] } }),
    ])
    render(<ApprovalStrip />)
    fireEvent.click(screen.getByRole('button', { name: /reject/ }))
    expect(respond).toHaveBeenCalledWith('r1', undefined, true)
  })

  it('点击 reject 选项 → 行内 followup 输入；确认拒绝带反馈文本', () => {
    setPending([req({ params: { options: bashOptions } })])
    render(<ApprovalStrip />)
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }))
    const input = screen.getByPlaceholderText(/给 agent 的反馈/)
    fireEvent.change(input, { target: { value: '别用 rm' } })
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }))
    expect(respond).toHaveBeenCalledWith('r1', 'reject', true, undefined, '别用 rm')
  })

  it('顶部 reject 按钮点击两次 → 关闭 followup 不响应', () => {
    setPending([req({ params: { options: bashOptions } })])
    render(<ApprovalStrip />)
    const rejectBtn = screen.getByRole('button', { name: /reject/ })
    fireEvent.click(rejectBtn)
    expect(screen.getByPlaceholderText(/给 agent 的反馈/)).not.toBeNull()
    fireEvent.click(rejectBtn)
    expect(screen.queryByPlaceholderText(/给 agent 的反馈/)).toBeNull()
    expect(respond).not.toHaveBeenCalled()
  })
})

describe('ApprovalStrip — 键盘', () => {
  it('Enter 确认当前选中；j/k、1-9、Tab 走动选择', () => {
    setPending([
      req({ params: { options: [{ optionId: 'a', name: 'A' }, { optionId: 'b', name: 'B' }] } }),
    ])
    const { rerender } = render(<ApprovalStrip />)
    const flush = () => rerender(<ApprovalStrip />)
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith('r1', 'a', false, undefined)
    key('j')
    flush()
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith('r1', 'b', false, undefined)
    key('k')
    flush()
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith('r1', 'a', false, undefined)
    key('2')
    flush()
    expect(respond).toHaveBeenLastCalledWith('r1', 'b', false, undefined)
    // sel 仍是 0（数字键不移动选择）→ Tab 走到 1 → Enter 'b'
    key('Tab')
    flush()
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith('r1', 'b', false, undefined)
    // 再 Tab 回卷到 0 → Enter 'a'
    key('Tab')
    flush()
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith('r1', 'a', false, undefined)
  })

  it('Ctrl+C 取消请求；无选项时 Enter 被吞、Esc 可暂停', () => {
    setPending([req({ params: { options: bashOptions } })])
    render(<ApprovalStrip />)
    key('c', { ctrlKey: true })
    expect(respond).toHaveBeenCalledWith('r1', undefined, true)

    respond.mockClear()
    setPending([req({ params: {} })])
    render(<ApprovalStrip />)
    key('Enter')
    key('ArrowDown')
    expect(respond).not.toHaveBeenCalled()
    key('Escape')
    expect(screen.getByText(/返回权限卡/)).not.toBeNull()
  })

  it('Esc 暂停 → Tab 返回；暂停态下其它键被吞', () => {
    setPending([req({ params: { options: bashOptions } })])
    const { container } = render(<ApprovalStrip />)
    key('Escape')
    expect(container.textContent).toContain('返回权限卡')
    key('Enter')
    expect(respond).not.toHaveBeenCalled()
    key('Tab')
    expect(container.textContent).toContain('↑/↓ 或 j/k 选择')
    key('Enter')
    expect(respond).toHaveBeenCalledWith('r1', 'allow', false, undefined)
  })

  it('数字键 1-9 越界不响应；Ctrl+F 无展开需求时让路', () => {
    setPending([
      req({ params: { options: [{ optionId: 'a', name: 'A' }] } }),
    ])
    render(<ApprovalStrip />)
    key('9')
    expect(respond).not.toHaveBeenCalled()
    key('1')
    expect(respond).toHaveBeenCalledWith('r1', 'a', false, undefined)
  })

  it('←/→ 循环 bash scope：精确 → 目录（含 cwd）→ 通配（打开编辑器）', () => {
    applyUiSettings({ remember_tool_approvals: true })
    Object.assign(h.chatState, { cwd: '/work' })
    setPending([
      req({
        params: {
          toolCall: { title: 'npm test', rawInput: {} },
          options: bashOptions,
        },
      }),
    ])
    const { container, rerender } = render(<ApprovalStrip />)
    const flush = () => rerender(<ApprovalStrip />)
    key('ArrowRight')
    flush()
    expect(container.textContent).toContain('目录')
    key('j') // 选中 always 行（sel 0 → 1）
    flush()
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith(
      'r1',
      'allow-always-command',
      false,
      { commandParts: ['npm', '/work'], isGlob: false },
    )
    key('ArrowRight') // 通配 → pattern editor
    flush()
    const input = screen.getByPlaceholderText(/glob 模式/) as HTMLInputElement
    expect(input.value).toBe('npm test')
    fireEvent.change(input, { target: { value: 'npm *' } })
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith(
      'r1',
      'allow-always-command',
      false,
      { commandParts: ['npm *'], isGlob: true },
    )
    // Enter 已确认并关闭编辑器（scopeIdx 停在通配）
    expect(screen.queryByPlaceholderText(/glob 模式/)).toBeNull()
    key('ArrowLeft')
    flush()
    expect(container.textContent).toContain('目录')
    key('ArrowLeft')
    flush()
    expect(container.textContent).toContain('精确')
    key('ArrowLeft') // 回卷到通配时再次打开编辑器（h 键等价 ←）
    flush()
    expect(screen.getByPlaceholderText(/glob 模式/)).not.toBeNull()
  })

  it('e 键打开 glob 编辑器，保存按钮提交 glob scope', () => {
    applyUiSettings({ remember_tool_approvals: true })
    setPending([
      req({
        params: {
          toolCall: { title: 'gh api repos/*' },
          options: bashOptions,
        },
      }),
    ])
    render(<ApprovalStrip />)
    key('e')
    fireEvent.change(screen.getByPlaceholderText(/glob 模式/), {
      target: { value: 'gh api orgs/*' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(respond).toHaveBeenCalledWith(
      'r1',
      'allow-always-command',
      false,
      { commandParts: ['gh api orgs/*'], isGlob: true },
    )
    expect(screen.queryByPlaceholderText(/glob 模式/)).toBeNull()
  })

  it('reject 行键盘路径：数字键选中 → Enter 进 followup → Enter 确认', () => {
    setPending([req({ params: { options: bashOptions } })])
    const { rerender } = render(<ApprovalStrip />)
    // remember=false 时可见选项为 [allow, reject] → 2 号键选中 reject
    key('2')
    rerender(<ApprovalStrip />)
    const input = screen.getByPlaceholderText(/给 agent 的反馈/)
    fireEvent.change(input, { target: { value: '重写' } })
    key('Enter')
    expect(respond).toHaveBeenCalledWith('r1', 'reject', true, undefined, '重写')
  })
})

describe('ApprovalStrip — 作用域 preset 细节', () => {
  it('←/→ 无 always 选项时被吞（不折叠）', () => {
    setPending([
      req({ params: { options: [{ optionId: 'allow', name: 'A' }] } }),
    ])
    render(<ApprovalStrip />)
    key('ArrowRight')
    expect(screen.queryByPlaceholderText(/glob 模式/)).toBeNull()
  })

  it('MCP：tool/server scope 切换 + 结构化 scope 响应', () => {
    applyUiSettings({ remember_tool_approvals: true })
    setPending([
      req({
        params: {
          toolCall: {
            title: 'linear__search',
            rawInput: { variant: 'UseTool', tool_name: 'linear__search' },
          },
          options: [
            { optionId: 'allow', name: '允许一次' },
            {
              optionId: 'allow-always-mcp',
              name: '始终允许',
              meta: { tool_name: 'linear__search', server_prefix: 'linear' },
            },
          ],
        },
      }),
    ])
    const { container, rerender } = render(<ApprovalStrip />)
    const flush = () => rerender(<ApprovalStrip />)
    expect(container.textContent).toContain('←/→ 切换允许范围')
    expect(container.textContent).toContain('(Linear) Search')
    key('j') // 选中 always 行（sel 0 → 1）
    flush()
    key('ArrowRight') // server scope
    flush()
    expect(container.textContent).toContain('all tools from Linear')
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith(
      'r1',
      'allow-always-mcp',
      false,
      { kind: 'server', server: 'linear' },
    )
    key('ArrowLeft')
    flush()
    expect(container.textContent).toContain('(Linear) Search')
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith(
      'r1',
      'allow-always-mcp',
      false,
      { kind: 'tool', tool_name: 'linear__search' },
    )
  })

  it('MCP 无 server 前缀：无调整范围 UI，只允许 tool scope', () => {
    applyUiSettings({ remember_tool_approvals: true })
    setPending([
      req({
        params: {
          toolCall: { title: 'plain_tool', rawInput: { variant: 'UseTool', tool_name: 'plain_tool' } },
          options: [{ optionId: 'allow-always-mcp', name: '始终允许', meta: { tool_name: 'plain_tool' } }],
        },
      }),
    ])
    const { container } = render(<ApprovalStrip />)
    expect(container.textContent).toContain('始终允许')
    // has_adjustable_scope=false：无 scope 徽标行，←/→ 被吞
    expect(container.textContent).not.toContain('切换允许范围')
    expect(screen.queryByRole('button', { name: 'e 编辑' })).toBeNull()
    key('ArrowRight')
    expect(container.textContent).not.toContain('切换允许范围')
    key('Enter')
    expect(respond).toHaveBeenLastCalledWith(
      'r1',
      'allow-always-mcp',
      false,
      { kind: 'tool', tool_name: 'plain_tool' },
    )
  })
})

describe('ApprovalStrip — 子代理来源标注', () => {
  it('source 字符串 / 对象 / session 跟踪 / 未跟踪 / 根会话', () => {
    setPending([
      req({ params: { source: 'writer', options: [] } }),
    ])
    const { container } = render(<ApprovalStrip />)
    expect(container.textContent).toContain('Subagent "writer":')

    setPending([
      req({ params: { subagent: { name: 'thinker', subagent_type: 'deep' }, options: [] } }),
    ])
    const { container: c2 } = render(<ApprovalStrip />)
    expect(c2.textContent).toContain('Subagent "thinker" (deep):')

    Object.assign(h.chatState, {
      sessionId: 'root',
      subagentIndex: { c1: 'e9' },
      entries: [{ id: 'e9', kind: 'subagent', title: '翻译', status: 'started' }],
    })
    setPending([req({ params: { session_id: 'c1', options: [] } })])
    const { container: c3 } = render(<ApprovalStrip />)
    expect(c3.textContent).toContain('Subagent "翻译":')

    setPending([req({ params: { session_id: 'unknown-sid', options: [] } })])
    const { container: c4 } = render(<ApprovalStrip />)
    expect(c4.textContent).toContain('Child session (untracked):')

    setPending([req({ params: { session_id: 'root', options: [] } })])
    const { container: c5 } = render(<ApprovalStrip />)
    expect(c5.textContent).not.toContain('Subagent')
    expect(c5.textContent).not.toContain('Child session')
  })
})