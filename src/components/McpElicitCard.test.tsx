import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { McpElicitCard } from './McpElicitCard'
import { clearUrlWait } from './mcpElicitWait'

const respondXai = vi.fn(async () => {
  useChatStore.setState({ xaiRequests: [] })
})

beforeEach(() => {
  respondXai.mockClear()
  clearUrlWait()
  useChatStore.setState({
    xaiRequests: [
      {
        requestId: 'el-1',
        method: 'x.ai/mcp/elicit',
        params: {
          mode: 'form',
          serverName: 'github',
          message: 'Need an email',
          sessionId: 's1',
          toolCallId: 't1',
          requestedSchema: {
            type: 'object',
            required: ['email'],
            properties: { email: { type: 'string', title: '邮箱' } },
          },
        },
      },
    ],
    respondXai,
  } as never)
})

describe('McpElicitCard', () => {
  it('uses the same card chrome as the question and permission cards', () => {
    const { container } = render(<McpElicitCard />)
    const card = container.querySelector('.gn-card-rise')
    expect(card).toBeTruthy()
    expect(card?.className).toContain('max-w-[640px]')
    expect(card?.className).toContain('bg-gn-bg-base')
    expect(card?.className).toContain('border-gn-cyan/50')
    expect(container.querySelector('header')?.className).toContain('bg-gn-bg-dark/60')
  })

  it('accepts a form and sends the content', () => {
    render(<McpElicitCard />)
    expect(screen.getByText('github 需要你确认')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a@b.c' } })
    fireEvent.click(screen.getByRole('button', { name: '接受' }))
    expect(respondXai).toHaveBeenCalledWith('el-1', {
      outcome: 'accept',
      content: { email: 'a@b.c' },
    })
  })

  it('declines without content', () => {
    render(<McpElicitCard />)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(respondXai).toHaveBeenCalledWith('el-1', { outcome: 'decline' })
  })
})
