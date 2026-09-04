import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { PlanApproval } from './PlanApproval'
import type { PendingReq } from '../api/types'

function setRequest(params?: Record<string, unknown>, requestId = 'r1') {
  useChatStore.setState({
    xaiRequests: [
      { requestId, method: 'x.ai/exit_plan_mode', params },
    ] as PendingReq[],
    respondXai: vi.fn(),
    dismissXai: vi.fn(),
  })
}

function actions() {
  const st = useChatStore.getState()
  return {
    respondXai: st.respondXai as ReturnType<typeof vi.fn>,
    dismissXai: st.dismissXai as ReturnType<typeof vi.fn>,
  }
}

const PLAN = '第一行\n第二行\n第三行'

beforeEach(() => {
  useChatStore.setState({ xaiRequests: [], respondXai: vi.fn(), dismissXai: vi.fn() })
})

function key(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(window, { key, ...init })
}

describe('PlanApproval', () => {
  it('无 exit_plan_mode 请求 → 不渲染', () => {
    const { container } = render(<PlanApproval />)
    expect(container.firstChild).toBeNull()
  })

  it('有请求 → 渲染计划行号 + 操作按钮', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    expect(screen.getByText('plan approval')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('第一行')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /批准并开始实施/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '请求修改' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出计划模式' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '稍后再说' })).toBeInTheDocument()
  })

  it('批准按钮 → approved；退出 → abandoned；稍后再说 → dismiss', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    fireEvent.click(screen.getByRole('button', { name: /批准并开始实施/ }))
    expect(actions().respondXai).toHaveBeenCalledWith('r1', { outcome: 'approved' })

    fireEvent.click(screen.getByRole('button', { name: '退出计划模式' }))
    expect(actions().respondXai).toHaveBeenCalledWith('r1', { outcome: 'abandoned' })

    fireEvent.click(screen.getByRole('button', { name: '稍后再说' }))
    expect(actions().dismissXai).toHaveBeenCalledWith('r1')
  })

  it('请求修改：空意见 → 聚焦输入框；有意见 → cancelled+feedback', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    fireEvent.click(screen.getByRole('button', { name: '请求修改' }))
    expect(document.activeElement).toBe(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）'))

    fireEvent.change(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）'), {
      target: { value: '重写第二行' },
    })
    fireEvent.click(screen.getByRole('button', { name: '请求修改' }))
    expect(actions().respondXai).toHaveBeenCalledWith('r1', {
      outcome: 'cancelled',
      feedback: '重写第二行',
    })
  })

  it('点击行选中 → 行级评论格式；Shift+点击扩展范围', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    fireEvent.mouseDown(screen.getByText('第二行'))
    expect(screen.getByText(/已选中第 2-2 行/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('第三行'), { shiftKey: true })
    expect(screen.getByText(/已选中第 2-3 行/)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）'), {
      target: { value: '改' },
    })
    fireEvent.click(screen.getByRole('button', { name: '请求修改' }))
    expect(actions().respondXai).toHaveBeenCalledWith('r1', {
      outcome: 'cancelled',
      feedback: 'Proposed plan lines 2-3:\n> 第二行\n> 第三行\n\nComment:\n改',
    })
  })

  it('鼠标拖动跨行 → 范围选择', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    fireEvent.mouseDown(screen.getByText('第一行'))
    fireEvent.mouseEnter(screen.getByText('第三行'))
    expect(screen.getByText(/已选中第 1-3 行/)).toBeInTheDocument()
  })

  it('收起/展开计划', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    fireEvent.click(screen.getByRole('button', { name: /▾ 收起计划/ }))
    expect(screen.queryByText('第二行')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /▸ 查看计划/ }))
    expect(screen.getByText('第二行')).toBeInTheDocument()
  })

  it('键盘：Enter 空→批准', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    key('Enter')
    expect(actions().respondXai).toHaveBeenLastCalledWith('r1', { outcome: 'approved' })
  })

  it('键盘：Enter 有文本 → cancelled；带选中 → 行级评论；Escape → dismiss', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    fireEvent.change(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）'), {
      target: { value: '意见' },
    })
    key('Enter')
    expect(actions().respondXai).toHaveBeenLastCalledWith('r1', {
      outcome: 'cancelled',
      feedback: '意见',
    })

    fireEvent.mouseDown(screen.getByText('第一行'))
    fireEvent.change(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）'), {
      target: { value: '行评论' },
    })
    key('Enter')
    expect(actions().respondXai).toHaveBeenLastCalledWith('r1', {
      outcome: 'cancelled',
      feedback: 'Proposed plan line 1:\n> 第一行\n\nComment:\n行评论',
    })

    key('Escape')
    expect(actions().dismissXai).toHaveBeenCalledWith('r1')
  })

  it('键盘：输入框内打字不拦截；meta/alt 组合放行；输入法组字放行', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    const input = screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）')
    fireEvent.keyDown(input, { key: 'a' }) // 在输入框中 → 不触发批准
    expect(actions().respondXai).not.toHaveBeenCalled()

    key('a', { metaKey: true })
    key('a', { altKey: true })
    key('a', { isComposing: true })
    expect(actions().respondXai).not.toHaveBeenCalled()
  })

  it('空白 planContent → No plan written', () => {
    setRequest({ planContent: '   ' })
    render(<PlanApproval />)
    expect(screen.getByText('No plan written — approve or request changes')).toBeInTheDocument()
  })

  it('新请求（requestId 变化）→ 重置意见与选中', () => {
    const { rerender } = render(<PlanApproval />)
    act(() => {
      setRequest({ planContent: PLAN }, 'r1')
    })
    rerender(<PlanApproval />)
    fireEvent.change(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）'), {
      target: { value: '旧意见' },
    })
    fireEvent.mouseDown(screen.getByText('第一行'))
    act(() => {
      setRequest({ planContent: PLAN }, 'r2')
    })
    rerender(<PlanApproval />)
    expect(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）')).toHaveValue('')
    expect(screen.queryByText(/已选中/)).toBeNull()
  })

  it('空行 plan 也渲染行号', () => {
    setRequest({ planContent: 'a\n\nb' })
    render(<PlanApproval />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})