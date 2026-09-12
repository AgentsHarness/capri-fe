import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore } from '../store/chat'
import { BlockViewer } from './BlockViewer'
import type { ScrollEntry } from '../api/types'

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

  it('运行中的子代理在弹窗底部展示简易 composer（仅输入框）', () => {
    render(<BlockViewer />)
    const input = screen.getByPlaceholderText('向子代理发送消息… (Enter 发送)')
    expect(input).toBeInTheDocument()
    expect(input).not.toBeDisabled()
  })

  it('按 Enter 发送消息并调用 sendSubagentMessage', async () => {
    render(<BlockViewer />)
    const input = screen.getByPlaceholderText('向子代理发送消息… (Enter 发送)')
    fireEvent.change(input, { target: { value: '请加快速度' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    expect(sendSubagentMessageMock).toHaveBeenCalledWith('sa-456', '请加快速度')
  })

  it('已结束的子代理输入框被禁用', () => {
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
    const input = screen.getByPlaceholderText('子代理已结束')
    expect(input).toBeInTheDocument()
    expect(input).toBeDisabled()
  })
})
