import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useChatStore } from '../../store/chat'
import { EmptyStatePicker } from './EmptyState'

vi.mock('../DirectoryPickerModal', () => ({
  DirectoryPickerModal: ({
    open,
    initial,
    onClose,
    onPick,
  }: {
    open: boolean
    initial?: string
    onClose: () => void
    onPick: (cwd: string) => void
  }) => (
    <div data-testid="dir-modal" data-open={open} data-initial={initial ?? ''}>
      <button onClick={() => onPick('/tmp/picked')}>pick</button>
      <button onClick={onClose}>close</button>
    </div>
  ),
}))

describe('EmptyStatePicker', () => {
  beforeEach(() => {
    useChatStore.setState({ emptyCwd: undefined })
  })

  it('渲染 AGENTS / HERNESS 字符画（两段 pre）与引导文案', () => {
    const { container } = render(<EmptyStatePicker />)
    // 字符画是 figlet 风格 ASCII（非字母组块），断言两段 pre 与关键行。
    const pres = container.querySelectorAll('pre')
    expect(pres).toHaveLength(2)
    expect(pres[0].textContent).toContain('|___/')
    expect(pres[1].textContent).toContain('\\__,_|_|')
    expect(screen.getByText('for Grok Build')).toBeInTheDocument()
    // 未选目录 → 引导提示
    expect(
      screen.getByText('发送消息即可从此工作目录开始新对话'),
    ).toBeInTheDocument()
  })

  it('已选 emptyCwd → 显示目录路径', () => {
    useChatStore.setState({ emptyCwd: '~/ccwork/acp-fe' })
    const { container } = render(<EmptyStatePicker />)
    expect(container.textContent).toContain('~/ccwork/acp-fe')
  })

  it('点击「选择工作目录」→ 打开 DirectoryPickerModal；pick 写回 store', () => {
    const { container } = render(<EmptyStatePicker />)
    fireEvent.click(screen.getByText('选择工作目录'))
    const modal = container.querySelector('[data-testid="dir-modal"]')
    expect(modal?.getAttribute('data-open')).toBe('true')
    expect(modal?.getAttribute('data-initial')).toBe('')
    fireEvent.click(screen.getByText('pick'))
    expect(useChatStore.getState().emptyCwd).toBe('/tmp/picked')
    // pick 后 modal 仍开着（由 onClose 关闭）
    expect(container.querySelector('[data-testid="dir-modal"]')).not.toBeNull()
  })

  it('modal 关闭 → onClose 收起', () => {
    const { container } = render(<EmptyStatePicker />)
    fireEvent.click(screen.getByText('选择工作目录'))
    fireEvent.click(screen.getByText('close'))
    expect(
      container.querySelector('[data-testid="dir-modal"]')?.getAttribute('data-open'),
    ).toBe('false')
  })
})