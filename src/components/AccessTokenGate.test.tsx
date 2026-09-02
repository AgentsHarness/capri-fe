import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccessTokenGate } from './AccessTokenGate'

describe('AccessTokenGate', () => {
  /**
   * 纯 local（Host 没配 HUB_URL）时门后根本没有 Hub：文案不能再让用户去输
   * 「Hub 的密钥」，否则他会拿 Hub 那把来敲本机的门，或反过来以为自己配错了。
   */
  it('local 模式 → 文案说这台 Host，不提 Hub', () => {
    render(<AccessTokenGate local hostName="Office PC" onSubmit={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '输入本机访问密钥' })).toBeInTheDocument()
    expect(screen.getByText(/Office PC/)).toBeInTheDocument()
    expect(screen.queryByText(/此 Hub 已启用访问控制/)).toBeNull()
  })

  it('hub 模式（默认）→ 仍是 Hub 文案', () => {
    render(<AccessTokenGate onSubmit={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '输入访问密钥' })).toBeInTheDocument()
    expect(screen.getByText(/此 Hub 已启用访问控制/)).toBeInTheDocument()
  })

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