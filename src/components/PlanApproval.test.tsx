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
    fireEvent.click(screen.getByRole('button', { name: /收起计划/ }))
    expect(screen.queryByText('第二行')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /查看计划/ }))
    expect(screen.getByText('第二行')).toBeInTheDocument()
  })

  it('键盘：Enter 空→批准', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    key('Enter')
    expect(actions().respondXai).toHaveBeenLastCalledWith('r1', { outcome: 'approved' })
  })

  it('键盘：无选区 Enter 有文本 → cancelled；选中行 Enter 先保存批注，再按 Enter 提交请求修改；Escape 阶梯', () => {
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

    actions().respondXai.mockClear()
    fireEvent.mouseDown(screen.getByText('第一行'))
    fireEvent.change(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）'), {
      target: { value: '行评论' },
    })
    // 第一次 Enter：保存第 1 行批注，清空选区与输入框，不直接提交请求修改
    key('Enter')
    expect(actions().respondXai).not.toHaveBeenCalled()
    expect(screen.getByText('已添加 1 条行批注')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）')).toHaveValue('')

    // 无选区时再按 Enter：把已保存的行批注作为请求修改发出
    key('Enter')
    expect(actions().respondXai).toHaveBeenLastCalledWith('r1', {
      outcome: 'cancelled',
      feedback: 'Proposed plan line 1:\n> 第一行\n\nComment:\n行评论',
    })

    // 选中行时第一次 Escape 只取消选区，第二次 Escape 才关闭卡片
    fireEvent.mouseDown(screen.getByText('第二行'))
    expect(screen.getByText(/已选中第 2-2 行/)).toBeInTheDocument()
    key('Escape')
    expect(screen.queryByText(/已选中/)).toBeNull()
    expect(actions().dismissXai).not.toHaveBeenCalled()

    key('Escape')
    expect(actions().dismissXai).toHaveBeenCalledWith('r1')
  })

  it('针对多行分别添加批注、编辑与删除批注，并可附带整体修改意见一并提交', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    const input = screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）')

    // 1) 对第 1 行添加批注（Enter 保存）
    fireEvent.mouseDown(screen.getByText('第一行'))
    fireEvent.change(input, { target: { value: '改第一行' } })
    key('Enter')
    expect(screen.getByText('已添加 1 条行批注')).toBeInTheDocument()

    // 2) 对第 2-3 行添加批注（点击「保存批注」按钮保存）
    fireEvent.mouseDown(screen.getByText('第二行'))
    fireEvent.click(screen.getByText('第三行'), { shiftKey: true })
    fireEvent.change(input, { target: { value: '改二三行' } })
    fireEvent.click(screen.getByRole('button', { name: '保存批注' }))
    expect(screen.getByText('已添加 2 条行批注')).toBeInTheDocument()

    // 3) 点击已保存的第 1 行批注进行编辑，按 Enter 更新
    fireEvent.click(screen.getByText('改第一行'))
    expect(input).toHaveValue('改第一行')
    fireEvent.change(input, { target: { value: '改第一行（已更新）' } })
    fireEvent.click(screen.getByRole('button', { name: '更新批注' }))
    expect(screen.getByText('改第一行（已更新）')).toBeInTheDocument()

    // 4) 再给第 3 行加一条批注后删除它
    fireEvent.mouseDown(screen.getByText('第三行'))
    fireEvent.change(input, { target: { value: '待删除批注' } })
    key('Enter')
    expect(screen.getByText('已添加 3 条行批注')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '删除 L3 批注' }))
    expect(screen.queryByText('待删除批注')).toBeNull()
    expect(screen.getByText('已添加 2 条行批注')).toBeInTheDocument()

    // 5) 在无选区状态下补充整体意见，点击「请求修改」一并提交
    fireEvent.change(input, { target: { value: '补充整体说明' } })
    fireEvent.click(screen.getByRole('button', { name: '请求修改' }))
    expect(actions().respondXai).toHaveBeenLastCalledWith('r1', {
      outcome: 'cancelled',
      feedback:
        'Proposed plan line 1:\n> 第一行\n\nComment:\n改第一行（已更新）\n\n' +
        'Proposed plan lines 2-3:\n> 第二行\n> 第三行\n\nComment:\n改二三行\n\n' +
        'Additional feedback:\n补充整体说明',
    })
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

  it('顶栏关闭按钮 → dismissXai', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(actions().dismissXai).toHaveBeenCalledWith('r1')
  })

  it('清除选区按钮与再次点击已选单行均可取消行选区，window mouseup 结束拖拽', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)

    // 拖拽后在 window 释放鼠标 → 后续 mouseEnter 不再扩展范围
    fireEvent.mouseDown(screen.getByText('第一行'))
    fireEvent.mouseUp(window)
    fireEvent.mouseEnter(screen.getByText('第三行'))
    expect(screen.getByText(/已选中第 1-1 行/)).toBeInTheDocument()
    expect(screen.getByText('L1')).toBeInTheDocument()

    // 再次点击同一单行 → 取消选中
    fireEvent.mouseDown(screen.getByText('第一行'))
    expect(screen.queryByText(/已选中/)).toBeNull()

    // 选中范围后点「清除选区」→ 恢复为整份计划评论（不带 Proposed plan lines 前缀）
    fireEvent.mouseDown(screen.getByText('第一行'))
    fireEvent.click(screen.getByText('第二行'), { shiftKey: true })
    expect(screen.getByText('L1-2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除选区' }))
    expect(screen.queryByText(/已选中/)).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('修改意见（留空时 Enter 直接批准）'), {
      target: { value: '整体意见' },
    })
    fireEvent.click(screen.getByRole('button', { name: '请求修改' }))
    expect(actions().respondXai).toHaveBeenLastCalledWith('r1', {
      outcome: 'cancelled',
      feedback: '整体意见',
    })
  })

  it('切换 Markdown 渲染预览与行号视图', () => {
    setRequest({ planContent: '# 计划标题\n正文行' })
    render(<PlanApproval />)
    expect(screen.getByText('# 计划标题')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(screen.getByRole('heading', { name: '计划标题' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '行号' }))
    expect(screen.getByText('# 计划标题')).toBeInTheDocument()
  })

  it('焦点在卡片按钮上按 Enter 不被全局批准拦截；全屏查看器打开时让出键盘', () => {
    setRequest({ planContent: PLAN })
    render(<PlanApproval />)
    const quitBtn = screen.getByRole('button', { name: '退出计划模式' })
    fireEvent.keyDown(quitBtn, { key: 'Enter' })
    expect(actions().respondXai).not.toHaveBeenCalled()

    act(() => {
      useChatStore.setState({ viewerEntryId: 'e1' })
    })
    key('Enter')
    key('Escape')
    expect(actions().respondXai).not.toHaveBeenCalled()
    expect(actions().dismissXai).not.toHaveBeenCalled()
    act(() => {
      useChatStore.setState({ viewerEntryId: undefined })
    })
  })
})