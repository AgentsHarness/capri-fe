import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InterjectConfirmModal } from './InterjectConfirmModal'

describe('InterjectConfirmModal', () => {
  it('open=false 时不渲染任何内容', () => {
    const { container } = render(
      <InterjectConfirmModal
        open={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        hasQuestions={true}
        hasPermissions={false}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('仅有提问时展示提问被作废的警告', () => {
    render(
      <InterjectConfirmModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        hasQuestions={true}
        hasPermissions={false}
      />,
    )
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.getByText('中断当前回合确认')).not.toBeNull()
    expect(screen.getByText(/Agent 正在等待你的回答.*未提交的问题将被直接作废/)).not.toBeNull()
  })

  it('仅有权限时展示权限执行被取消的警告', () => {
    render(
      <InterjectConfirmModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        hasQuestions={false}
        hasPermissions={true}
      />,
    )
    expect(screen.getByText(/当前有待审批的工具权限.*取消未审批的工具执行/)).not.toBeNull()
  })

  it('两者兼有时展示综合警告', () => {
    render(
      <InterjectConfirmModal
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        hasQuestions={true}
        hasPermissions={true}
      />,
    )
    expect(screen.getByText(/当前有待回答的提问与待审批的工具权限/)).not.toBeNull()
  })

  it('点击取消按钮触发 onClose', () => {
    const onClose = vi.fn()
    render(
      <InterjectConfirmModal
        open={true}
        onClose={onClose}
        onConfirm={vi.fn()}
        hasQuestions={true}
        hasPermissions={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('按 Escape 键触发 onClose', () => {
    const onClose = vi.fn()
    render(
      <InterjectConfirmModal
        open={true}
        onClose={onClose}
        onConfirm={vi.fn()}
        hasQuestions={true}
        hasPermissions={false}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击仍要立即发送触发 onConfirm', () => {
    const onConfirm = vi.fn()
    render(
      <InterjectConfirmModal
        open={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        hasQuestions={true}
        hasPermissions={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '仍要立即发送' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
