import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccessTokenGate } from './AccessTokenGate'

describe('AccessTokenGate', () => {
  it('挂载后聚焦输入框并渲染标题', () => {
    render(<AccessTokenGate onSubmit={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '输入访问密钥' })).toBeInTheDocument()
    expect(screen.getByLabelText('访问密钥')).toHaveFocus()
  })

  it('空输入 → 按钮禁用，Enter 不提交', () => {
    const onSubmit = vi.fn()
    render(<AccessTokenGate onSubmit={onSubmit} />)
    const input = screen.getByLabelText('访问密钥')
    const btn = screen.getByRole('button', { name: '进入' })
    expect(btn).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('输入后点击按钮 → 提交 trim 后的值', () => {
    const onSubmit = vi.fn()
    render(<AccessTokenGate onSubmit={onSubmit} />)
    const input = screen.getByLabelText('访问密钥')
    fireEvent.change(input, { target: { value: '  abc123  ' } })
    fireEvent.click(screen.getByRole('button', { name: '进入' }))
    expect(onSubmit).toHaveBeenCalledWith('abc123')
  })

  it('Enter 键提交（preventDefault）', () => {
    const onSubmit = vi.fn()
    render(<AccessTokenGate onSubmit={onSubmit} />)
    const input = screen.getByLabelText('访问密钥')
    fireEvent.change(input, { target: { value: 'tok' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('tok')
  })

  it('submitting → 禁用输入与按钮、文案变“验证中…”且不重复提交', () => {
    const onSubmit = vi.fn()
    render(<AccessTokenGate onSubmit={onSubmit} submitting />)
    const input = screen.getByLabelText('访问密钥')
    fireEvent.change(input, { target: { value: 'tok' } })
    const btn = screen.getByRole('button', { name: '验证中…' })
    expect(btn).toBeDisabled()
    expect(input).toBeDisabled()
    fireEvent.click(btn)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('有 error → role=alert 展示错误', () => {
    render(<AccessTokenGate onSubmit={vi.fn()} error="密钥无效" />)
    expect(screen.getByRole('alert')).toHaveTextContent('密钥无效')
    // 无 error 时不渲染 alert
    const { container } = render(<AccessTokenGate onSubmit={vi.fn()} />)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})