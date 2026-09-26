import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentRow, PersonaRow } from '../api/rpc/agents'

const transportMock = vi.hoisted(() => ({
  agentsList: vi.fn(),
  agentsSetDefault: vi.fn(async () => {}),
  agentsToggle: vi.fn(async () => {}),
  personasList: vi.fn(),
  personasCreate: vi.fn(async () => {}),
  personasDelete: vi.fn(async () => {}),
  onEvent: vi.fn(),
}))

vi.mock('../api/client', () => ({ transport: transportMock }))

vi.mock('../store/chat', () => ({
  useChatStore: (sel: (s: { cwd: string }) => unknown) => sel({ cwd: '/ws' }),
}))

import { AgentsModal, openAgentsModal } from './AgentsModal'
import { pushToast } from '../store/toast'

vi.mock('../store/toast', () => ({ pushToast: vi.fn() }))
const toastMock = vi.mocked(pushToast)

function agent(over: Partial<AgentRow> = {}): AgentRow {
  return {
    name: 'reviewer',
    description: '审阅改动',
    scope: 'user',
    path: '/home/.grok/agents/reviewer.md',
    enabled: true,
    builtin: false,
    isDefault: false,
    model: 'inherit',
    promptMode: 'extend',
    tools: [],
    toolsDeclared: false,
    disallowedTools: [],
    skills: [],
    ...over,
  }
}

const BUILTINS: AgentRow[] = [
  agent({ name: 'grok-build', description: '默认编码 agent', scope: 'builtin', builtin: true, isDefault: true, path: undefined }),
  agent({ name: 'explore', description: '只读探索', scope: 'builtin', builtin: true, path: undefined }),
]

function customAgent(): AgentRow {
  return agent({
    name: 'auditor',
    scope: 'project',
    isDefault: false,
    model: 'grok-4.7',
    promptMode: 'full',
    tools: ['read_file', 'grep'],
    toolsDeclared: true,
    disallowedTools: ['run_terminal_command'],
    skills: ['code-review'],
    effort: 'high',
    isolation: 'worktree',
    promptBody: '你是审计员。',
  })
}

function persona(over: Partial<PersonaRow> = {}): PersonaRow {
  return {
    name: 'researcher',
    description: '先把问题查透',
    instructions: '逐条列证据。',
    scope: 'bundled',
    path: '/home/.grok/bundled/personas/researcher.toml',
    deletable: false,
    inputs: [],
    outputs: [],
    hasInputs: false,
    hasOutputs: false,
    ...over,
  }
}

function openModal(rows: AgentRow[] = BUILTINS, personas: PersonaRow[] = []) {
  transportMock.agentsList.mockResolvedValue({ agents: rows, configuredDefault: '' })
  transportMock.personasList.mockResolvedValue(personas)
  render(<AgentsModal />)
  openAgentsModal('agents')
}

/** 点开列表里某一行（行是按钮，名字在其中的 span 里）。 */
function clickRow(name: string) {
  const row = screen.getByText(name).closest('button')
  if (!row) throw new Error(`row button for ${name} not found`)
  fireEvent.click(row)
}

beforeEach(() => {
  for (const fn of Object.values(transportMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear: () => void }).mockClear()
  }
  toastMock.mockClear()
})

describe('AgentsModal 列表行', () => {
  it('行内不摆操作按钮：设为默认/停用只在详情弹窗里', async () => {
    openModal([customAgent()])
    await waitFor(() => expect(screen.getByText('auditor')).toBeTruthy())
    expect(screen.queryByText('设为默认')).toBeNull()
    expect(screen.queryByText('停用')).toBeNull()
    clickRow('auditor')
    expect(screen.getByTestId('agent-detail')).toBeTruthy()
    expect(screen.getByText('设为默认')).toBeTruthy()
    expect(screen.getByText('停用')).toBeTruthy()
  })

  it('内置 agent 的详情同样给操作入口，且走的是同一条请求', async () => {
    openModal(BUILTINS)
    await waitFor(() => expect(screen.getByText('grok-build')).toBeTruthy())
    clickRow('explore')
    const detail = screen.getByTestId('agent-detail')
    expect(detail.textContent).toContain('explore')
    fireEvent.click(screen.getByText('停用'))
    await waitFor(() => expect(transportMock.agentsToggle).toHaveBeenCalledWith('explore', false))
  })

  it('内置 agent 已停用时给的是「启用」，取反发出去', async () => {
    openModal([agent({ name: 'plan', scope: 'builtin', builtin: true, enabled: false, path: undefined })])
    await waitFor(() => expect(screen.getByText('plan')).toBeTruthy())
    clickRow('plan')
    fireEvent.click(screen.getByText('启用'))
    await waitFor(() => expect(transportMock.agentsToggle).toHaveBeenCalledWith('plan', true))
  })

  it('内置 agent 也能设为默认', async () => {
    openModal(BUILTINS)
    await waitFor(() => expect(screen.getByText('explore')).toBeTruthy())
    clickRow('explore')
    fireEvent.click(screen.getByText('设为默认'))
    await waitFor(() => expect(transportMock.agentsSetDefault).toHaveBeenCalledWith('explore'))
  })

  it('详情弹窗展示定义字段，而不是只剩名字和描述', async () => {
    openModal([customAgent()])
    await waitFor(() => expect(screen.getByText('auditor')).toBeTruthy())
    clickRow('auditor')
    const detail = screen.getByTestId('agent-detail')
    expect(detail.textContent).toContain('grok-4.7')
    expect(detail.textContent).toContain('full')
    expect(detail.textContent).toContain('read_file、grep')
    expect(detail.textContent).toContain('run_terminal_command')
    expect(detail.textContent).toContain('code-review')
    expect(detail.textContent).toContain('worktree')
    expect(detail.textContent).toContain('你是审计员。')
  })

  it('没声明 tools 的 agent 说明继承默认工具集，不当成「没有工具」', async () => {
    openModal([agent({ name: 'plain' })])
    await waitFor(() => expect(screen.getByText('plain')).toBeTruthy())
    clickRow('plain')
    expect(screen.getByTestId('agent-detail').textContent).toContain('未声明，继承默认工具集')
  })

  it('Esc 先关详情、再关外层弹窗', async () => {
    openModal([customAgent()])
    await waitFor(() => expect(screen.getByText('auditor')).toBeTruthy())
    clickRow('auditor')
    expect(screen.getByTestId('agent-detail')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('agent-detail')).toBeNull())
    expect(screen.getByTestId('agents-modal')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('agents-modal')).toBeNull())
  })

  it('详情里改默认：写配置、提示、并关掉详情', async () => {
    openModal([customAgent()])
    await waitFor(() => expect(screen.getByText('auditor')).toBeTruthy())
    clickRow('auditor')
    fireEvent.click(screen.getByText('设为默认'))
    await waitFor(() => expect(transportMock.agentsSetDefault).toHaveBeenCalledWith('auditor'))
    await waitFor(() => expect(screen.queryByTestId('agent-detail')).toBeNull())
    expect(toastMock).toHaveBeenCalledWith('新会话将使用 auditor')
  })

  it('详情里停用：把 enabled 取反发给 host', async () => {
    openModal([customAgent()])
    await waitFor(() => expect(screen.getByText('auditor')).toBeTruthy())
    clickRow('auditor')
    fireEvent.click(screen.getByText('停用'))
    await waitFor(() => expect(transportMock.agentsToggle).toHaveBeenCalledWith('auditor', false))
  })

  it('已是默认的行给的是「取消默认」，回传空名复位', async () => {
    openModal([agent({ name: 'lead', isDefault: true })])
    await waitFor(() => expect(screen.getByText('lead')).toBeTruthy())
    clickRow('lead')
    fireEvent.click(screen.getByText('取消默认'))
    await waitFor(() => expect(transportMock.agentsSetDefault).toHaveBeenCalledWith(''))
  })
})

describe('AgentsModal 人格页', () => {
  it('打包人格不能删：详情里没有删除入口，也没有确认行', async () => {
    openModal([], [persona()])
    openAgentsModal('personas')
    await waitFor(() => expect(screen.getByText('researcher')).toBeTruthy())
    clickRow('researcher')
    const detail = screen.getByTestId('persona-detail')
    expect(detail.textContent).toContain('逐条列证据。')
    expect(screen.queryByText('删除')).toBeNull()
    expect(screen.queryByText('确认删除？')).toBeNull()
  })

  it('可删人格：删除要先确认，取消则不发送', async () => {
    openModal([], [persona({ name: 'mine', scope: 'user', path: '/home/.grok/personas/mine.toml', deletable: true })])
    openAgentsModal('personas')
    await waitFor(() => expect(screen.getByText('mine')).toBeTruthy())
    clickRow('mine')
    fireEvent.click(screen.getByText('删除'))
    expect(transportMock.personasDelete).not.toHaveBeenCalled()
    expect(screen.getByText('确认删除？')).toBeTruthy()
    fireEvent.click(screen.getByText('取消'))
    expect(screen.queryByText('确认删除？')).toBeNull()
    expect(transportMock.personasDelete).not.toHaveBeenCalled()
  })

  it('确认后才真删，删完关详情并刷新列表', async () => {
    openModal([], [persona({ name: 'mine', scope: 'user', path: '/home/.grok/personas/mine.toml', deletable: true })])
    openAgentsModal('personas')
    await waitFor(() => expect(screen.getByText('mine')).toBeTruthy())
    clickRow('mine')
    fireEvent.click(screen.getByText('删除'))
    const confirmRow = screen.getByText('确认删除？').parentElement!
    const confirmBtn = Array.from(confirmRow.querySelectorAll('button')).find(
      (b) => b.textContent === '删除',
    )!
    fireEvent.click(confirmBtn)
    await waitFor(() =>
      expect(transportMock.personasDelete).toHaveBeenCalledWith('/home/.grok/personas/mine.toml'),
    )
    await waitFor(() => expect(screen.queryByTestId('persona-detail')).toBeNull())
    expect(transportMock.personasList).toHaveBeenCalledTimes(2)
    expect(toastMock).toHaveBeenCalledWith('已删除 mine')
  })

  it('人格详情带输入输出约定（名称/类型/必填）', async () => {
    openModal([], [
      persona({
        name: 'reviewer',
        deletable: true,
        scope: 'user',
        inputs: [{ name: 'design_doc_file', type: 'file', required: true, description: '待审文档' }],
        outputs: [{ name: 'notes_file', type: 'file', required: false }],
        hasInputs: true,
        hasOutputs: true,
      }),
    ])
    openAgentsModal('personas')
    await waitFor(() => expect(screen.getByText('reviewer')).toBeTruthy())
    clickRow('reviewer')
    const detail = screen.getByTestId('persona-detail')
    expect(detail.textContent).toContain('design_doc_file (file, required)')
    expect(detail.textContent).toContain('待审文档')
    expect(detail.textContent).toContain('notes_file (file)')
  })
})
