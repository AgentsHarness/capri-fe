import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LiteToolFill } from './LiteToolFill'

describe('LiteToolFill 按钮只在失败时出现', () => {
  it('待补全：只有省略说明，没有 [加载]', () => {
    render(<LiteToolFill bytes={4096} onFill={() => {}} />)
    expect(screen.getByText(/输出已省略/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '[加载]' })).toBeNull()
    expect(screen.queryByRole('button', { name: '[重试]' })).toBeNull()
  })

  it('加载中：spinner 文案，没有按钮', () => {
    render(<LiteToolFill bytes={4096} state="loading" onFill={() => {}} />)
    expect(screen.getByText(/正在加载工具输出/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('失败：展示 [重试]，点击触发 onFill', () => {
    const onFill = vi.fn()
    render(<LiteToolFill bytes={4096} state="error" onFill={onFill} />)
    expect(screen.getByText(/工具输出加载失败/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '[重试]' }))
    expect(onFill).toHaveBeenCalledTimes(1)
  })

  it('失败但没有 onFill：只读，不画按钮', () => {
    render(<LiteToolFill bytes={4096} state="error" />)
    expect(screen.getByText(/工具输出加载失败/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
