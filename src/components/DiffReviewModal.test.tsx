import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { DiffReviewModal } from './DiffReviewModal'

const respondXaiMock = vi.fn(async () => {})
const dismissXaiMock = vi.fn(async () => {})
const closeDiffReviewMock = vi.fn(async () => {})

function setup(overrides: Record<string, unknown> = {}) {
  useChatStore.setState({
    xaiRequests: [],
    respondXai: respondXaiMock,
    dismissXai: dismissXaiMock,
    diffReview: [],
    diffReviewOpen: false,
    closeDiffReview: closeDiffReviewMock,
    ...overrides,
  })
}

/** 一个统一 diff 字符串请求。 */
function reqWith(content: Array<Record<string, unknown>>, requestId = 'r1') {
  return setup({
    xaiRequests: [{ requestId, method: 'x.ai/diff_review', params: { content } }],
  })
}

function dialogText(): string {
  return screen.getByRole('dialog', { name: 'diff review' }).textContent ?? ''
}

describe('DiffReviewModal', () => {
  beforeEach(() => {
    respondXaiMock.mockReset()
    dismissXaiMock.mockReset()
    closeDiffReviewMock.mockReset()
    setup()
  })

  it('无请求且通知未开 → null', () => {
    const { container } = render(<DiffReviewModal />)
    expect(container.firstChild).toBeNull()
  })

  it('request 路径：渲染文件列表 + diff 行统计 + 批准提交', async () => {
    reqWith([
      {
        path: '/a.ts',
        status: 'modified',
        diff: '@@ -1,2 +1,3 @@\n keep\n+added\n-removed\n rest',
      },
    ])
    render(<DiffReviewModal />)
    // 路径出现两处：文件列表 tab + 正在查看的 diff 头
    expect(screen.getAllByText('/a.ts')).toHaveLength(2)
    expect(screen.getAllByText('modified')).toHaveLength(2)
    // ins/del 计数：+1 −1
    expect(dialogText()).toContain('+1')
    expect(dialogText()).toContain('−1')
    expect(dialogText()).toContain('added')
    expect(dialogText()).toContain('removed')
    // 批准后提交
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    expect(respondXaiMock).toHaveBeenCalledWith('r1', { approved: true })
  })

  it('带审查意见提交 → comments 随请求发出', () => {
    reqWith([{ path: '/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }])
    render(<DiffReviewModal />)
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.change(screen.getByPlaceholderText('审查意见（拒绝时填写）…'), {
      target: { value: '需要改注释' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    expect(respondXaiMock).toHaveBeenCalledWith('r1', {
      approved: true,
      comments: '需要改注释',
    })
  })

  it('任一文件拒绝 → approved: false', () => {
    reqWith([
      { path: '/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
      { path: '/b.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
    ])
    render(<DiffReviewModal />)
    // 拒绝第一个文件
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    // 切到第二个文件并批准
    const bTab = screen.getByText('/b.ts').closest('button') as HTMLElement
    fireEvent.click(bTab)
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    expect(respondXaiMock).toHaveBeenCalledWith('r1', { approved: false })
  })

  it('全部批准 / 全部拒绝', () => {
    reqWith([
      { path: '/a.ts', status: 'M', diff: '+x' },
      { path: '/b.ts', status: 'A', diff: '+y' },
    ])
    render(<DiffReviewModal />)
    fireEvent.click(screen.getByRole('button', { name: '全部拒绝' }))
    fireEvent.click(screen.getByRole('button', { name: '提交审查' }))
    expect(respondXaiMock).toHaveBeenCalledWith('r1', { approved: false })
  })

  it('无内容 → 未解析到 diff 内容提示', () => {
    reqWith([])
    render(<DiffReviewModal />)
    expect(screen.getByText('未解析到 diff 内容（请求为空或字段不识别）')).not.toBeNull()
  })

  it('old/new 文本对 → LCS diff 行', () => {
    reqWith([{ path: '/a.txt', diff: { old_text: 'a\nb', new_text: 'a\nc' } }])
    render(<DiffReviewModal />)
    expect(dialogText()).toContain('b')
    expect(dialogText()).toContain('c')
    expect(dialogText()).toContain('+1')
    expect(dialogText()).toContain('−1')
  })

  it('纯 content → 按上下文行渲染', () => {
    reqWith([{ path: '/plain.md', content: 'hello\nworld' }])
    render(<DiffReviewModal />)
    expect(dialogText()).toContain('hello')
    expect(dialogText()).toContain('world')
  })

  it('snake_case / 无路径字段防御解析（未知文件）+ 空行提示', () => {
    reqWith([
      { file_path: '/z/m.ts', change_type: 'M', diff_text: '@@ -1 +1 @@\n-old\n+new' },
      { status: 'modified' },
      { path: '/empty.ts' },
    ])
    render(<DiffReviewModal />)
    // 路径 + 状态都出现两处（tab + 头）
    expect(screen.getAllByText('/z/m.ts')).toHaveLength(2)
    expect(screen.getAllByText('M')).toHaveLength(2)
    expect(screen.getByText('未知文件')).not.toBeNull()
    // 无 diff 内容的文件 → 提示
    const emptyTab = screen.getByText('/empty.ts').closest('button') as HTMLElement
    fireEvent.click(emptyTab)
    expect(screen.getByText('该文件无 diff 内容')).not.toBeNull()
  })

  it('request 路径 Esc / 取消 → dismissXai；通知路径 Esc / 关闭 → closeDiffReview', () => {
    reqWith([{ path: '/a.ts', diff: '+x' }])
    const first = render(<DiffReviewModal />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dismissXaiMock).toHaveBeenCalledWith('r1')
    first.unmount()
    // 通知路径（无 requestId）
    setup({
      diffReview: [{ path: '/n.ts', content: 'notice' }],
      diffReviewOpen: true,
    })
    render(<DiffReviewModal />)
    expect(screen.getByText('通知态 · 无法回执')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closeDiffReviewMock).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(closeDiffReviewMock).toHaveBeenCalledTimes(2)
  })

  it('通知路径无批准/拒绝按钮（只读）', () => {
    setup({ diffReview: [{ path: '/n.ts', diff: '+x' }], diffReviewOpen: true })
    render(<DiffReviewModal />)
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull()
    expect(screen.queryByRole('button', { name: '提交审查' })).toBeNull()
  })

  it('request 路径优先于通知（两者同时存在时）', () => {
    setup({
      xaiRequests: [{ requestId: 'r1', method: 'x.ai/diff_review', params: { content: [{ path: '/req.ts', diff: '+r' }] } }],
      diffReview: [{ path: '/notif.ts', content: 'n' }],
      diffReviewOpen: true,
    })
    render(<DiffReviewModal />)
    expect(screen.getAllByText('/req.ts')).toHaveLength(2)
    expect(screen.queryByText('/notif.ts')).toBeNull()
    expect(screen.getByText('待 Agent 回执')).not.toBeNull()
  })

  it('背景点击关闭（request 路径走 dismissXai）', () => {
    reqWith([{ path: '/a.ts', diff: '+x' }])
    render(<DiffReviewModal />)
    const overlay = screen.getByRole('dialog', { name: 'diff review' })
    fireEvent.mouseDown(overlay)
    expect(dismissXaiMock).toHaveBeenCalledWith('r1')
  })
})