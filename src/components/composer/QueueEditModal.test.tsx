import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { QueueEditModal } from './QueueEditModal'
import { QueueStrip } from './QueueStrip'
import { usePromptQueue, type QueuedPrompt } from '../../store/promptQueue'
import type { useQueueNav } from './useQueueNav'

vi.mock('../../api/client', () => ({
  transport: {
    prompt: vi.fn(async () => undefined),
    queueEdit: vi.fn(async () => undefined),
    queueHoldEdit: vi.fn(async () => undefined),
    queueReleaseEdit: vi.fn(async () => undefined),
    queueRemove: vi.fn(async () => undefined),
    queueReorder: vi.fn(async () => undefined),
    queueClear: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => {}),
  },
}))

import { transport } from '../../api/client'

const row = (
  id: string,
  text: string,
  over: Partial<QueuedPrompt> = {},
): QueuedPrompt => ({
  id,
  text,
  blocks: [{ type: 'text', text }],
  ts: 0,
  ...over,
})

/** useQueueNav() 的最小替身（QueueStrip 只消费这些字段）。 */
function makeNav(overrides: Record<string, unknown> = {}) {
  return {
    queue: usePromptQueue.getState().queue,
    queuePanelOpen: true,
    queueEditIndex: null,
    queueSel: 0,
    setQueueSel: vi.fn(),
    queueFocus: false,
    setQueueFocus: vi.fn(),
    queueDrag: null,
    queuePanelRef: { current: null },
    onQueueGripPointerDown: vi.fn(),
    onQueueGripPointerMove: vi.fn(),
    onQueueGripPointerUp: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useQueueNav>
}

const ta = () => screen.getByRole('textbox') as HTMLTextAreaElement

/** store 直调（非用户手势）要过 act，否则弹窗不会重渲染。 */
const q = () => usePromptQueue.getState()
const edit = (i: number) => act(() => q().startEdit(i))
const stopEdit = () => act(() => q().cancelEdit())

beforeEach(() => {
  usePromptQueue.setState({
    queues: {},
    queue: [row('q1', '第一条'), row('q2', '第二条很长很长')],
    sessionId: 'sess-1',
    sending: false,
    drainedIds: new Set(),
    deletedRows: new Map(),
    editIndex: null,
    editDraft: '',
    editImages: [],
  })
  vi.clearAllMocks()
})

describe('QueueEditModal', () => {
  it('未在编辑（editIndex null）→ 不渲染', () => {
    const { container } = render(<QueueEditModal />)
    expect(container.firstChild).toBeNull()
  })

  it('点行上「编辑」打开弹窗：整段正文进 textarea，行内不再有输入框', () => {
    const { container } = render(
      <>
        <QueueStrip nav={makeNav()} sendQueuedItem={vi.fn()} headSteer={false} />
        <QueueEditModal />
      </>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]!)
    // 编辑锁随 startEdit 通知 host
    expect(transport.queueHoldEdit).toHaveBeenCalledWith({ id: 'q2' }, 'sess-1')
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(ta().value).toBe('第二条很长很长')
    expect(screen.getByText('2/2')).not.toBeNull()
    // 队列条不再走行内编辑：整个容器只有弹窗那一个输入框
    expect(container.querySelectorAll('textarea')).toHaveLength(1)
  })

  it('改正文后保存 → queueEdit + 释放编辑锁，行文本与 blocks 更新', () => {
    usePromptQueue.getState().startEdit(0)
    render(<QueueEditModal />)
    fireEvent.change(ta(), { target: { value: ' 改成这样 ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(usePromptQueue.getState().editIndex).toBeNull()
    expect(usePromptQueue.getState().queue[0]?.text).toBe('改成这样')
    expect(usePromptQueue.getState().queue[0]?.blocks).toEqual([
      { type: 'text', text: '改成这样' },
    ])
    expect(transport.queueEdit).toHaveBeenCalledWith(
      { id: 'q1', newText: '改成这样' },
      'sess-1',
    )
    expect(transport.queueReleaseEdit).toHaveBeenCalledWith({ id: 'q1' }, 'sess-1')
  })

  it('Enter 保存；Shift+Enter 换行不保存', () => {
    usePromptQueue.getState().startEdit(0)
    render(<QueueEditModal />)
    fireEvent.change(ta(), { target: { value: 'a\nb' } })
    fireEvent.keyDown(ta(), { key: 'Enter', shiftKey: true })
    expect(usePromptQueue.getState().editIndex).toBe(0)
    expect(transport.queueEdit).not.toHaveBeenCalled()
    fireEvent.keyDown(ta(), { key: 'Enter' })
    expect(usePromptQueue.getState().editIndex).toBeNull()
    expect(transport.queueEdit).toHaveBeenCalledTimes(1)
  })

  it('Esc 取消：丢弃草稿并释放编辑锁，行文本不变', () => {
    usePromptQueue.getState().startEdit(1)
    render(<QueueEditModal />)
    fireEvent.change(ta(), { target: { value: '不该被保存' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePromptQueue.getState().editIndex).toBeNull()
    expect(usePromptQueue.getState().editDraft).toBe('')
    expect(usePromptQueue.getState().queue[1]?.text).toBe('第二条很长很长')
    expect(transport.queueEdit).not.toHaveBeenCalled()
    expect(transport.queueReleaseEdit).toHaveBeenCalledWith({ id: 'q2' }, 'sess-1')
  })

  it('正文与附图都清空：禁用保存并提示；取消按钮与 backdrop 点击走 cancelEdit', () => {
    edit(0)
    render(<QueueEditModal />)
    fireEvent.change(ta(), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(screen.getByText(/正文与附图都为空/)).not.toBeNull()
    // Enter 在空正文下也不提交
    fireEvent.keyDown(ta(), { key: 'Enter' })
    expect(q().editIndex).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(q().editIndex).toBeNull()
    // backdrop 点击同样取消
    edit(0)
    const { container } = render(<QueueEditModal />)
    fireEvent.mouseDown(container.firstChild as Element)
    expect(q().editIndex).toBeNull()
  })

  it('含附图 / 发送失败的行：composer 式缩略图与提示如实标出', () => {
    usePromptQueue.setState({
      queue: [
        row('q1', '带图文本', {
          blocks: [
            { type: 'text', text: '带图文本' },
            { type: 'image', data: 'AA', mimeType: 'image/png' },
          ],
        }),
        row('q2', '失败行', { degraded: true, errorText: 'boom' }),
      ],
    })
    edit(0)
    const { container } = render(<QueueEditModal />)
    // agent-owned 行：改附图的后果写在提示里（保存会重新入队）。
    expect(screen.getByText(/改附图会把这条重新排队/)).not.toBeNull()
    const thumb = container.querySelector('img') as HTMLImageElement
    expect(thumb?.src).toBe('data:image/png;base64,AA')
    // 单张图不带序号，与队列条上的标记一致。
    expect(screen.getByText('[image]')).not.toBeNull()
    stopEdit()
    edit(1)
    expect(screen.getByText('发送失败')).not.toBeNull()
    expect(screen.getByTitle('boom')).not.toBeNull()
  })

  it('纯图片行：缩略图可点开全屏预览，保存不被空正文禁用', () => {
    usePromptQueue.setState({
      queue: [
        row('q1', '', {
          blocks: [
            { type: 'text', text: '' },
            { type: 'image', data: 'AA', mimeType: 'image/png' },
            { type: 'image', data: 'BB', mimeType: 'image/jpeg' },
          ],
        }),
      ],
    })
    edit(0)
    const { container } = render(<QueueEditModal />)
    expect(screen.getByText('[image 1]')).not.toBeNull()
    expect(screen.getByText('[image 2]')).not.toBeNull()
    // 消息本体是完整的（图在 blocks 里）：别把「保存」锁死。
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    expect(screen.queryByText(/不保存这条改动/)).toBeNull()

    const thumbs = container.querySelectorAll('button img')
    fireEvent.click(thumbs[1] as Element)
    expect(screen.getByRole('dialog', { name: '图片预览 2/2' })).not.toBeNull()
    // Esc 只关预览：编辑窗留在原位（下次 Esc 才 cancelEdit）。
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /图片预览/ })).toBeNull()
    expect(screen.getByRole('dialog', { name: '编辑排队消息' })).not.toBeNull()
    expect(q().editIndex).toBe(0)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(q().editIndex).toBeNull()
  })

  it('被编辑的行从镜像消失（删除/收养）→ 弹窗随之关闭', () => {
    edit(0)
    render(<QueueEditModal />)
    expect(screen.getByRole('dialog')).not.toBeNull()
    act(() => q().removeAt('q1'))
    expect(usePromptQueue.getState().editIndex).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // ── 附图编辑 ─────────────────────────────────────────────────────
  const imgRow = (
    id: string,
    text: string,
    data: string[],
    over: Partial<QueuedPrompt> = {},
  ): QueuedPrompt =>
    row(id, text, {
      blocks: [
        { type: 'text', text },
        ...data.map((d) => ({ type: 'image' as const, data: d, mimeType: 'image/png' })),
      ],
      ...over,
    })

  it('缩略图固定宽高；agent-owned 行改图后保存 = 删旧行 + 新 blocks 重新入队', () => {
    usePromptQueue.setState({ queue: [imgRow('q1', '带图', ['AA', 'BB'], { version: 2 })] })
    edit(0)
    const { container } = render(<QueueEditModal />)
    const thumb = container.querySelector('img') as HTMLImageElement
    expect(thumb.className).toContain('h-20')
    expect(thumb.className).toContain('w-20')
    // 缩略图铺满整格（裁切），不留 letterbox 黑边。
    expect(thumb.className).toContain('object-cover')

    fireEvent.click(screen.getByRole('button', { name: '移除 [image 2]' }))
    expect(container.querySelectorAll('img')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    // agent 手里那份删掉（带 version），换新的 promptId 重新排队。
    expect(transport.queueRemove).toHaveBeenCalledWith(
      { id: 'q1', expectedVersion: 2 },
      'sess-1',
    )
    const st = usePromptQueue.getState()
    expect(st.queue).toHaveLength(1)
    expect(st.queue[0]?.id).not.toBe('q1')
    expect(st.queue[0]?.blocks.filter((b) => b.type === 'image')).toHaveLength(1)
    expect(transport.prompt).toHaveBeenCalledWith(
      st.queue[0]?.blocks,
      expect.objectContaining({ sessionId: 'sess-1' }),
    )
    expect(st.editIndex).toBeNull()
    expect(st.editImages).toEqual([])
  })

  it('degraded 行改附图：就地更新 blocks，不重新入队', () => {
    usePromptQueue.setState({
      queue: [imgRow('q1', '带图', ['AA', 'BB'], { degraded: true, errorText: 'boom' })],
    })
    edit(0)
    render(<QueueEditModal />)
    fireEvent.click(screen.getByRole('button', { name: '移除 [image 1]' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    const st = usePromptQueue.getState()
    expect(st.queue[0]?.id).toBe('q1')
    expect(st.queue[0]?.blocks.filter((b) => b.type === 'image')).toHaveLength(1)
    expect(transport.queueRemove).not.toHaveBeenCalled()
    expect(transport.prompt).not.toHaveBeenCalled()
    expect(st.editImages).toEqual([])
  })

  it('粘贴图片进弹窗 = 追加一张附图（进草稿，保存才落地）', async () => {
    usePromptQueue.setState({ queue: [imgRow('q1', '带图', ['AA'], { degraded: true })] })
    edit(0)
    const { container } = render(<QueueEditModal />)
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    fireEvent.paste(container.querySelector('[role="dialog"]') as Element, {
      clipboardData: { files: [file] },
    })
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2))
    expect(screen.getByText('[image 2]')).not.toBeNull()
    // 草稿阶段行本体没动
    expect(usePromptQueue.getState().queue[0]?.blocks.filter((b) => b.type === 'image')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(usePromptQueue.getState().queue[0]?.blocks.filter((b) => b.type === 'image')).toHaveLength(2)
  })

  it('点「添加」选图 → 追加一张缩略图进草稿', async () => {
    usePromptQueue.setState({ queue: [imgRow('q1', '带图', ['AA'], { degraded: true })] })
    edit(0)
    const { container } = render(<QueueEditModal />)
    const file = new File([new Uint8Array([9, 8, 7])], 'pick.png', { type: 'image/png' })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2))
    expect(screen.getByText('[image 2]')).not.toBeNull()
    // 草稿未落地前，行本体仍是 1 张
    expect(q().queue[0]?.blocks.filter((b) => b.type === 'image')).toHaveLength(1)
  })

  it('乐观回显行（prompt RPC 在飞）：不给改附图的控件，提示等它进队', () => {    usePromptQueue.setState({ queue: [imgRow('q1', '带图', ['AA'], { optimistic: true })] })
    edit(0)
    const { container } = render(<QueueEditModal />)
    // 缩略图照常展示（能看不能改）
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^移除 / })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加' })).toBeNull()
    expect(screen.getByText(/这条正在发送，进队后即可增删附图/)).not.toBeNull()
  })
})
