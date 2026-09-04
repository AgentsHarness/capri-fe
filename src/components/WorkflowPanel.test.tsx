import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import type { WorkflowRun } from '../store/chat'
import { WorkflowPanel } from './WorkflowPanel'

const controlMock = vi.fn()
const saveMock = vi.fn(async () => {})

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    runId: 'w1',
    name: '发布流程',
    status: 'running',
    firstSeenAt: 100,
    startedAt: 200,
    ...overrides,
  }
}

function setup(runs: Record<string, WorkflowRun>, overrides: Record<string, unknown> = {}) {
  useChatStore.setState({
    workflowPanelOpen: true,
    workflowRuns: runs,
    selectedWorkflowRunId: undefined,
    workflowControl: controlMock,
    saveWorkflowScript: saveMock,
    ...overrides,
  })
}

function dialogText(): string {
  return screen.getByRole('dialog', { name: 'workflows' }).textContent ?? ''
}

/** 行按钮所在的整行容器（含操作按钮）。 */
function rowOf(name: string): HTMLElement {
  let d = screen.getByText(name).closest('div') as HTMLElement
  while (d && !d.className.includes('cursor-pointer')) d = d.parentElement as HTMLElement
  return d
}

describe('WorkflowPanel', () => {
  beforeEach(() => {
    controlMock.mockReset()
    saveMock.mockReset()
    setup({})
  })

  it('未打开 → null', () => {
    setup({}, { workflowPanelOpen: false })
    const { container } = render(<WorkflowPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('无运行记录 → 暂无工作流运行记录', () => {
    render(<WorkflowPanel />)
    expect(screen.getByText('暂无工作流运行记录')).not.toBeNull()
  })

  it('列表行：名称 / 状态徽标 / phase / agents / started', () => {
    setup({
      w1: run({ name: 'A 流程', status: 'done', phase: 'build', agents: ['主 agent'], progress: 0.5 }),
    })
    render(<WorkflowPanel />)
    expect(screen.getByText('A 流程')).not.toBeNull()
    expect(screen.getByText('Done')).not.toBeNull()
    expect(screen.getByText('build')).not.toBeNull()
    expect(screen.getByText(/agents · 主 agent/)).not.toBeNull()
    expect(dialogText()).toContain('started ·')
    // 进度条 50%
    expect(screen.getByText('50%')).not.toBeNull()
  })

  it('状态归一化：active→Running / user_paused→Paused / budget_limited / interrupted→Failed / cancelled / complete→Done', () => {
    setup({
      w1: run({ status: 'active' }),
      w2: run({ runId: 'w2', name: 'p', status: 'user_paused', firstSeenAt: 90 }),
      w3: run({ runId: 'w3', name: 'b', status: 'budget_limited', firstSeenAt: 80 }),
      w4: run({ runId: 'w4', name: 'f', status: 'interrupted', firstSeenAt: 70 }),
      w5: run({ runId: 'w5', name: 'c', status: 'cancelled', firstSeenAt: 60 }),
      w6: run({ runId: 'w6', name: 'd', status: 'complete', firstSeenAt: 50 }),
    })
    render(<WorkflowPanel />)
    expect(screen.getByText('Running')).not.toBeNull()
    expect(screen.getByText('Paused')).not.toBeNull()
    expect(screen.getByText('Budget limited')).not.toBeNull()
    expect(screen.getByText('Failed')).not.toBeNull()
    expect(screen.getByText('Cancelled')).not.toBeNull()
    expect(screen.getByText('Done')).not.toBeNull()
  })

  it('按 startedAt 倒序排列', () => {
    setup({
      w1: run({ name: '新流程', startedAt: 200 }),
      w2: run({ runId: 'w2', name: '旧流程', startedAt: 100 }),
    })
    render(<WorkflowPanel />)
    const dialog = screen.getByRole('dialog', { name: 'workflows' })
    expect(dialog.textContent!.indexOf('新流程')).toBeLessThan(
      dialog.textContent!.indexOf('旧流程'),
    )
  })

  it('状态门控按钮：running→暂停/停止；paused→恢复/停止；budget_limited→仅恢复；done→仅保存脚本', () => {
    setup({
      w1: run({ name: 'run1' }),
      w2: run({ runId: 'w2', name: 'pau', status: 'paused', firstSeenAt: 90 }),
      w3: run({ runId: 'w3', name: 'bud', status: 'budget_limited', firstSeenAt: 80 }),
      w4: run({ runId: 'w4', name: 'fin', status: 'done', firstSeenAt: 70 }),
    })
    render(<WorkflowPanel />)
    expect(rowOf('run1').textContent).toContain('暂停')
    expect(rowOf('run1').textContent).toContain('停止')
    expect(rowOf('run1').textContent).not.toContain('恢复')
    expect(rowOf('pau').textContent).toContain('恢复')
    expect(rowOf('pau').textContent).toContain('停止')
    expect(rowOf('bud').textContent).toContain('恢复')
    expect(rowOf('bud').textContent).not.toContain('停止')
    expect(rowOf('fin').textContent).not.toContain('暂停')
    expect(rowOf('fin').textContent).toContain('保存脚本')
  })

  it('列表行按钮 → workflowControl / saveWorkflowScript', () => {
    setup({
      w1: run({ name: 'run1' }),
      w2: run({ runId: 'w2', name: 'p2', status: 'paused', firstSeenAt: 50 }),
    })
    render(<WorkflowPanel />)
    fireEvent.click(within(rowOf('run1')).getByRole('button', { name: '暂停' }))
    expect(controlMock).toHaveBeenCalledWith('w1', 'pause')
    fireEvent.click(within(rowOf('p2')).getByRole('button', { name: '恢复' }))
    expect(controlMock).toHaveBeenCalledWith('w2', 'resume')
    fireEvent.click(within(rowOf('run1')).getByRole('button', { name: '停止' }))
    expect(controlMock).toHaveBeenCalledWith('w1', 'stop')
    fireEvent.click(within(rowOf('p2')).getByRole('button', { name: '保存脚本' }))
    expect(saveMock).toHaveBeenCalledWith('w2')
  })

  it('pendingControl → 控制指令已发送徽标 + 按钮禁用', () => {
    setup({ w1: run({ name: 'fly', pendingControl: 'pause' }) })
    render(<WorkflowPanel />)
    expect(screen.getByText('控制指令已发送')).not.toBeNull()
    expect(screen.getByRole('button', { name: '暂停' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled()
  })

  it('点击行 → 详情视图：objective / elapsed / phases 高亮 / roster / script', () => {
    setup({
      w1: run({
        name: 'D 流程',
        status: 'running',
        objective: '把特性上线',
        elapsedMs: 5000,
        progress: 0.4,
        phases: [
          { title: 'plan', state: 'done' },
          { title: 'build', state: 'active' },
        ],
        agentRoster: [
          { name: '主agent', status: 'running', tokens: 1500 },
          { name: '副agent', status: 'done', tokens: 300 },
        ],
        script: 'let meta = #{};\n',
      }),
    })
    render(<WorkflowPanel />)
    fireEvent.click(screen.getByText('D 流程'))
    expect(dialogText()).toContain('运行详情 · D 流程')
    expect(screen.getByText('把特性上线')).not.toBeNull()
    expect(screen.getByText('elapsed · 5s')).not.toBeNull()
    expect(screen.getByText('40%')).not.toBeNull()
    // phase rail：当前 phase 高亮 ▶
    expect(screen.getByText('plan')).not.toBeNull()
    expect(screen.getByText('build')).not.toBeNull()
    expect(dialogText()).toContain('▶')
    // agent roster + tokens
    expect(screen.getByText('主agent')).not.toBeNull()
    expect(screen.getByText('1.5K')).not.toBeNull()
    // script
    expect(screen.getByText(/let meta = #\{\};/)).not.toBeNull()
  })

  it('详情视图控制按钮（running → 暂停/停止）与返回列表', () => {
    setup({ w1: run({ name: 'D', status: 'running', elapsedMs: 100 }) })
    render(<WorkflowPanel />)
    fireEvent.click(screen.getByText('D'))
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(controlMock).toHaveBeenCalledWith('w1', 'pause')
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))
    expect(useChatStore.getState().selectedWorkflowRunId).toBeUndefined()
    expect(dialogText()).toContain('工作流运行面板')
  })

  it('键盘：ArrowDown 移动光标 + Enter 打开详情；Esc 返回列表再 Esc 关闭', () => {
    setup({
      w1: run({ name: 'A1' }),
      w2: run({ runId: 'w2', name: 'B2', status: 'paused', firstSeenAt: 90 }),
    })
    render(<WorkflowPanel />)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(useChatStore.getState().selectedWorkflowRunId).toBe('w2')
    expect(dialogText()).toContain('运行详情 · B2')
    // Esc 回列表
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().selectedWorkflowRunId).toBeUndefined()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().workflowPanelOpen).toBe(false)
  })

  it('关闭按钮 / 背景点击关闭面板', () => {
    setup({ w1: run({ name: 'A1' }) })
    const first = render(<WorkflowPanel />)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(useChatStore.getState().workflowPanelOpen).toBe(false)
    first.unmount()
    setup({ w1: run({ name: 'A1' }) })
    render(<WorkflowPanel />)
    const overlay = screen.getByRole('dialog', { name: 'workflows' })
    fireEvent.mouseDown(overlay)
    expect(useChatStore.getState().workflowPanelOpen).toBe(false)
  })

  it('cursor 越界自动钳制（列表变短）', () => {
    setup({ w1: run({ name: 'A1', startedAt: 300 }), w2: run({ runId: 'w2', name: 'B2', startedAt: 200 }) })
    const first = render(<WorkflowPanel />)
    fireEvent.keyDown(window, { key: 'j' })
    // 移除一行 → cursor 钳到 0
    setup({ w1: run({ name: 'A1', startedAt: 300 }) })
    first.unmount()
    render(<WorkflowPanel />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(useChatStore.getState().selectedWorkflowRunId).toBe('w1')
  })

  it('empty 详情字段（无 phases/agents/script/时间）不渲染对应块', () => {
    setup({
      w1: run({ name: '裸流程', status: 'completed', startedAt: 0, firstSeenAt: 0 }),
    })
    render(<WorkflowPanel />)
    fireEvent.click(screen.getByText('裸流程'))
    expect(dialogText()).toContain('Completed')
    expect(dialogText()).not.toContain('phases')
    expect(dialogText()).not.toContain('agents')
    // 无 elapsedMs/startedAt → 显示占位 —
    expect(dialogText()).toContain('elapsed · —')
    expect(dialogText()).not.toContain('script')
  })
})