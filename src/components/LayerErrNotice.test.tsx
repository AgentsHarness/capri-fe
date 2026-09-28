import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { LayerErr } from '../store/chat/types'

// LayerErrNotice 只读 chat store 的 dismissNotice / restartAgent。
const mockState = {
  dismissNotice: vi.fn(),
  restartAgent: vi.fn(() => Promise.resolve(true)),
}
vi.mock('../store/chat', () => ({
  useChatStore: (selector: (s: typeof mockState) => unknown) => selector(mockState),
}))

import { LayerErrNotice } from './LayerErrNotice'

afterEach(() => {
  mockState.restartAgent.mockReset()
  mockState.restartAgent.mockImplementation(() => Promise.resolve(true))
})

function err(over: Partial<LayerErr> = {}): LayerErr {
  return { level: 'warning', message: 'm', at: 1, ...over }
}

describe('LayerErrNotice', () => {
  it('渲染层级徽标与消息文本', () => {
    render(<LayerErrNotice layer="hub" err={err({ message: 'hub 断了', at: 100 })} />)
    expect(screen.getByText('hub 断了')).not.toBeNull()
    expect(screen.getByText('hub')).not.toBeNull()
  })

  it('action=restart-agent → 显示重启按钮、调用 restartAgent，在飞期间禁用', async () => {
    let resolveRestart: (v: boolean) => void = () => {}
    mockState.restartAgent.mockImplementation(
      () => new Promise<boolean>((r) => (resolveRestart = r)),
    )
    render(
      <LayerErrNotice
        layer="host"
        err={err({ level: 'error', message: 'boom', at: 1, action: 'restart-agent' })}
      />,
    )
    const btn = screen.getByRole('button', { name: '重启' })
    fireEvent.click(btn)
    expect(mockState.restartAgent).toHaveBeenCalledTimes(1)
    // 重启在飞：按钮禁用且改文案，再点不会重复触发。
    const busy = screen.getByRole('button', { name: '重启中…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    fireEvent.click(busy)
    expect(mockState.restartAgent).toHaveBeenCalledTimes(1)
    // 收口后恢复可点（agent 未必重启成功，按钮要能再试）。
    resolveRestart(true)
    await vi.waitFor(() => {
      expect((screen.getByRole('button', { name: '重启' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('无 action 时不出现重启按钮', () => {
    render(<LayerErrNotice layer="hub" err={err({ message: '慢', at: 3 })} />)
    expect(screen.queryByRole('button', { name: '重启' })).toBeNull()
  })

  it('手动关闭调用 dismissNotice', () => {
    mockState.dismissNotice.mockClear()
    render(<LayerErrNotice layer="hub" err={err({ level: 'error', message: 'x', at: 1 })} />)
    fireEvent.click(screen.getByLabelText('关闭提示'))
    expect(mockState.dismissNotice).toHaveBeenCalled()
  })

  it('error / warning 分别用红、黄配色', () => {
    const { container, rerender } = render(
      <LayerErrNotice layer="host" err={err({ level: 'error', message: 'e', at: 1 })} />,
    )
    expect(container.firstElementChild?.className).toContain('text-gn-red')
    rerender(<LayerErrNotice layer="host" err={err({ level: 'warning', message: 'w', at: 2 })} />)
    expect(container.firstElementChild?.className).toContain('text-gn-warning')
  })
})
