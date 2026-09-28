import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore } from '../store/chat'
import { BlockViewer, SubagentComposer } from './BlockViewer'
import type { ScrollEntry } from '../api/types'

/**
 * 子代理弹窗不渲染 composer：x.ai/subagent/message 被 agent 的
 * Feature::ActiveAgentMessages 门控（默认关，二进制不注册 → Method not
 * found），且它要的是 coordinator 铸的 agentAddress，客户端拿不到。
 * 组件本体保留（下面单独测），接回时删掉「不渲染」那条断言即可。
 */
describe('BlockViewer Subagent Composer', () => {
  const sendSubagentMessageMock = vi.fn().mockResolvedValue({ ok: true })

  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sendSubagentMessage: sendSubagentMessageMock,
      viewerEntryId: 'sub-1',
      entries: [
        {
          id: 'sub-1',
          kind: 'subagent',
          title: 'Code Reviewer',
          status: 'started',
          running: true,
          subagentId: 'sa-456',
          childSessionId: 'child-sess-1',
        } as Extract<ScrollEntry, { kind: 'subagent' }>,
      ],
    })
  })

  it('运行中的子代理弹窗不再渲染 composer（agent 侧方法不存在）', () => {
    render(<BlockViewer />)
    expect(screen.queryByPlaceholderText('向子代理发送消息… (Enter 发送)')).toBeNull()
    expect(screen.queryByPlaceholderText('子代理已结束')).toBeNull()
  })

  it('已结束的子代理弹窗同样不渲染 composer', () => {
    useChatStore.setState({
      entries: [
        {
          id: 'sub-1',
          kind: 'subagent',
          title: 'Code Reviewer',
          status: 'completed',
          running: false,
          subagentId: 'sa-456',
          childSessionId: 'child-sess-1',
        } as Extract<ScrollEntry, { kind: 'subagent' }>,
      ],
    })

    render(<BlockViewer />)
    expect(screen.queryByPlaceholderText('向子代理发送消息… (Enter 发送)')).toBeNull()
    expect(screen.queryByPlaceholderText('子代理已结束')).toBeNull()
  })

  // ── 以下为保留组件的自测：接回时保证它仍然可用 ──────────────────

  it('组件保留：运行中即可输入，chrome 与主 prompt 同款', () => {
    render(<SubagentComposer agentAddress="sa-456" disabled={false} />)
    const input = screen.getByPlaceholderText('向子代理发送消息… (Enter 发送)')
    expect(input).not.toBeDisabled()
    // 圆角 1px 边框的 prompt chrome（非裸输入框）。
    const chrome = input.closest('.rounded-\\[6px\\]')
    expect(chrome).not.toBeNull()
    expect(chrome).toHaveClass('border')
  })

  it('组件保留：按 Enter 调用 sendSubagentMessage', async () => {
    render(<SubagentComposer agentAddress="sa-456" disabled={false} />)
    const input = screen.getByPlaceholderText('向子代理发送消息… (Enter 发送)')
    fireEvent.change(input, { target: { value: '请加快速度' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    expect(sendSubagentMessageMock).toHaveBeenCalledWith('sa-456', '请加快速度')
  })

  it('组件保留：已结束（disabled）时输入框禁用', () => {
    render(<SubagentComposer agentAddress="sa-456" disabled />)
    const input = screen.getByPlaceholderText('子代理已结束')
    expect(input).toBeDisabled()
  })
})

describe('BlockViewer 子代理顶部信息汇总与去重', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('运行中且有上下文窗口时：展示进度条与最后工具，抑制重复的独立 token 项、detail 摘要、general-purpose 与 subagentId', () => {
    useChatStore.setState({
      viewerEntryId: 'sub-run',
      entries: [
        {
          id: 'sub-run',
          kind: 'subagent',
          title: '检查渲染管线',
          status: 'started',
          running: true,
          subagentId: '01a0e812-30d4-7613-88d6-10058b44657d',
          childSessionId: 'child-1',
          subagentType: 'general-purpose',
          model: 'grok-4.7',
          reasoningEffort: 'high',
          turns: 3,
          toolCalls: 7,
          tokensUsed: 50_000,
          contextWindowTokens: 128_000,
          contextUsagePct: 42,
          errorCount: 1,
          toolsUsed: ['read_file', 'grep'],
          detail: 'turns=3 tools=7 42% · 12s',
          durationMs: 12_000,
        } as Extract<ScrollEntry, { kind: 'subagent' }>,
      ],
    })

    const { container } = render(<BlockViewer />)
    const headerText = container.querySelector('header')?.textContent ?? ''

    expect(headerText).toContain('检查渲染管线')
    expect(headerText).toContain('grok-4.7(high)')
    expect(headerText).not.toContain('(grok-4.7(high))')
    expect(headerText).toContain('3 turns')
    expect(headerText).toContain('7 tools')
    expect(headerText).toContain('1 error')
    expect(headerText).toContain('Running: grep')
    expect(headerText).toContain('50K / 128K tok')
    expect(headerText).not.toContain('general-purpose')
    expect(headerText).not.toContain('turns=3')
    expect(headerText).not.toContain('01a0e812-30d4-7613-88d6-10058b44657d')
    // 50K 已在上下文窗口 "50K / 128K tok" 中展示，不再重复渲染独立的 "50K tok" 段
    expect(headerText.match(/50K/g)).toHaveLength(1)
  })

  it('已结束时：不展示上下文进度条与 Running 工具，保留独立 token 段，且 title 等于 subagentId 时不把原始 ID 当标题渲染', () => {
    useChatStore.setState({
      viewerEntryId: 'sub-done',
      entries: [
        {
          id: 'sub-done',
          kind: 'subagent',
          title: 'sa-raw-uuid-999',
          status: 'completed',
          running: false,
          subagentId: 'sa-raw-uuid-999',
          childSessionId: 'child-2',
          subagentType: 'code-reviewer',
          model: 'grok-4.7',
          turns: 1,
          toolCalls: 1,
          tokensUsed: 18_000,
          contextWindowTokens: 128_000,
          contextUsagePct: 14,
          toolsUsed: ['read_file'],
          durationMs: 45_000,
        } as Extract<ScrollEntry, { kind: 'subagent' }>,
      ],
    })

    const { container } = render(<BlockViewer />)
    const headerText = container.querySelector('header')?.textContent ?? ''

    expect(headerText).toContain('Agent done')
    expect(headerText).not.toContain('sa-raw-uuid-999')
    expect(headerText).toContain('code-reviewer · grok-4.7')
    expect(headerText).toContain('1 turn')
    expect(headerText).toContain('1 tool')
    expect(headerText).toContain('18K tok')
    expect(headerText).not.toContain('Running:')
    expect(headerText).not.toContain('128K tok')
  })
})
