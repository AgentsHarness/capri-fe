import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// ErrorBanner 只读 chat store 的 layerErrors / dismissNotice / restartAgent。
const mockState = {
  layerErrors: {},
  dismissNotice: vi.fn(),
  restartAgent: vi.fn(() => Promise.resolve()),
}
vi.mock('../store/chat', () => ({
  useChatStore: (selector: (s: typeof mockState) => unknown) => selector(mockState),
}))

import { ErrorBanner } from './ErrorBanner'

describe('ErrorBanner', () => {
  it('无错误 → null', () => {
    mockState.layerErrors = {}
    const { container } = render(<ErrorBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('error 优先于 warning；同级取较新', () => {
    mockState.layerErrors = {
      hub: { level: 'warning', message: 'hub 警告', at: 100 },
      host: { level: 'error', message: 'host 挂了', at: 200 },
    }
    render(<ErrorBanner />)
    expect(screen.getByText('host 挂了')).not.toBeNull()
    expect(screen.getByText('host')).not.toBeNull()
  })

  it('仅 warning → 渲染 warning', () => {
    mockState.layerErrors = { hub: { level: 'warning', message: 'derp', at: 100 } }
    render(<ErrorBanner />)
    expect(screen.getByText('derp')).not.toBeNull()
  })

  it('action=restart-agent → 显示重启按钮并调用 restartAgent', async () => {
    mockState.layerErrors = {
      host: { level: 'error', message: 'boom', at: 1, action: 'restart-agent' },
    }
    render(<ErrorBanner />)
    const btn = screen.getByRole('button', { name: '重启 Agent' })
    fireEvent.click(btn)
    expect(mockState.restartAgent).toHaveBeenCalled()
  })

  it('手动关闭调用 dismissNotice', () => {
    mockState.layerErrors = { hub: { level: 'error', message: 'x', at: 1 } }
    render(<ErrorBanner />)
    fireEvent.click(screen.getByLabelText('关闭提示'))
    expect(mockState.dismissNotice).toHaveBeenCalled()
  })
})