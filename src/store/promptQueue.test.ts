import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '../api/types'
import { transport } from '../api/client'
import { applyQueueChanged, usePromptQueue, type QueuedPrompt } from './promptQueue'

vi.mock('../api/client', () => ({
  transport: {
    prompt: vi.fn(async () => undefined),
    queueRemove: vi.fn(async () => undefined),
    queueReleaseEdit: vi.fn(async () => undefined),
    queueEdit: vi.fn(async () => undefined),
    queueReorder: vi.fn(async () => undefined),
    queueClear: vi.fn(async () => undefined),
    queueHoldEdit: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => {}),
  },
}))

const row = (id: string, text: string, over: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id,
  text,
  blocks: [{ type: 'text', text }],
  ts: 0,
  ...over,
})

beforeEach(() => {
  usePromptQueue.setState({
    queues: {},
    queue: [],
    sending: false,
    drainedIds: new Set(),
    editIndex: null,
    editDraft: '',
    sessionId: undefined,
  })
  vi.clearAllMocks()
})

describe('队列基础操作', () => {
  it('enqueue 插入乐观回显行并 fire-and-forget 发 prompt RPC', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hi' }]
    usePromptQueue.getState().enqueue({ text: 'hi', blocks }, 'sess-1')
    const st = usePromptQueue.getState()
    expect(st.queue).toHaveLength(1)
    expect(st.queue[0]).toMatchObject({ text: 'hi', optimistic: true })
    expect(st.sessionId).toBe('sess-1')
    // prompt RPC 本身就是入队：带上行 id（= promptId）供 agent 侧对齐
    expect(transport.prompt).toHaveBeenCalledWith(blocks, {
      sessionId: 'sess-1',
      promptId: st.queue[0]?.id,
    })
  })

  it('dequeue 弹出队首、记入 drainedIds、通知 host 删除', () => {
    usePromptQueue.setState({ queue: [row('p1', 'a'), row('p2', 'b')], sessionId: 'sess-1' })
    const head = usePromptQueue.getState().dequeue()
    expect(head?.id).toBe('p1')
    const st = usePromptQueue.getState()
    expect(st.queue.map((q) => q.id)).toEqual(['p2'])
    expect(st.drainedIds.has('p1')).toBe(true)
    expect(transport.queueRemove).toHaveBeenCalledWith({ id: 'p1' }, 'sess-1')
  })

  it('dequeue 空队列返回 undefined', () => {
    expect(usePromptQueue.getState().dequeue()).toBeUndefined()
  })

  it('removeAt 删除指定行并 drain（stale 广播不得复活）', () => {
    usePromptQueue.setState({ queue: [row('p1', 'a'), row('p2', 'b')], sessionId: 's' })
    usePromptQueue.getState().removeAt('p1')
    const st = usePromptQueue.getState()
    expect(st.queue.map((q) => q.id)).toEqual(['p2'])
    expect(st.drainedIds.has('p1')).toBe(true)
    expect(transport.queueRemove).toHaveBeenCalledWith({ id: 'p1' }, 's')
  })

  it('clear 清空全部行、全部 drain、保留会话标签并通知 host', () => {
    usePromptQueue.setState({ queue: [row('p1', 'a'), row('p2', 'b')], sessionId: 's' })
    usePromptQueue.getState().clear()
    const st = usePromptQueue.getState()
    expect(st.queue).toEqual([])
    expect([...st.drainedIds].sort()).toEqual(['p1', 'p2'])
    expect(st.sessionId).toBe('s')
    expect(transport.queueClear).toHaveBeenCalledWith('s')
  })

  it('requeueFront 放回队首并解除 drain（发送被拒回滚）', () => {
    usePromptQueue.setState({
      queue: [row('a', '1')],
      sessionId: 's1',
      drainedIds: new Set(['r']),
    })
    usePromptQueue.getState().requeueFront('s1', row('r', 'again'))
    const st = usePromptQueue.getState()
    expect(st.queue.map((q) => q.id)).toEqual(['r', 'a'])
    expect(st.drainedIds.has('r')).toBe(false)
  })
})

describe('行编辑（TUI queue_edit 对齐）', () => {
  it('startEdit 锁行、saveEdit 保存文本与首块并通知 host', () => {
    usePromptQueue.setState({ queue: [row('p1', 'old')], sessionId: 's' })
    const q = usePromptQueue.getState()
    q.startEdit(0)
    expect(usePromptQueue.getState().editIndex).toBe(0)
    expect(usePromptQueue.getState().editDraft).toBe('old')
    expect(transport.queueHoldEdit).toHaveBeenCalledWith({ id: 'p1' }, 's')
    q.setEditDraft('new')
    q.saveEdit()
    const st = usePromptQueue.getState()
    expect(st.editIndex).toBeNull()
    expect(st.queue[0]).toMatchObject({ text: 'new' })
    expect(st.queue[0]?.blocks[0]).toEqual({ type: 'text', text: 'new' })
    expect(transport.queueEdit).toHaveBeenCalledWith({ id: 'p1', newText: 'new' }, 's')
    expect(transport.queueReleaseEdit).toHaveBeenCalledWith({ id: 'p1' }, 's')
  })

  it('saveEdit 空白草稿不得清空行（保留原文）', () => {
    usePromptQueue.setState({ queue: [row('p1', 'keep')], sessionId: 's' })
    const q = usePromptQueue.getState()
    q.startEdit(0)
    q.setEditDraft('   ')
    q.saveEdit()
    expect(usePromptQueue.getState().queue[0]?.text).toBe('keep')
  })

  it('cancelEdit 丢弃草稿并释放编辑锁', () => {
    usePromptQueue.setState({ queue: [row('p1', 'a')], sessionId: 's' })
    const q = usePromptQueue.getState()
    q.startEdit(0)
    q.cancelEdit()
    const st = usePromptQueue.getState()
    expect(st.editIndex).toBeNull()
    expect(st.editDraft).toBe('')
    expect(transport.queueReleaseEdit).toHaveBeenCalledWith({ id: 'p1' }, 's')
  })

  it('删除正在编辑的行会释放编辑锁', () => {
    usePromptQueue.setState({ queue: [row('p1', 'a'), row('p2', 'b')], sessionId: 's' })
    const q = usePromptQueue.getState()
    q.startEdit(0)
    q.removeAt('p1')
    expect(usePromptQueue.getState().editIndex).toBeNull()
    expect(transport.queueReleaseEdit).toHaveBeenCalledWith({ id: 'p1' }, 's')
    expect(transport.queueRemove).toHaveBeenCalledWith({ id: 'p1' }, 's')
  })
})

describe('moveUp / moveDown', () => {
  it('重排相邻行并同步 host；头/尾越界 no-op', () => {
    usePromptQueue.setState({
      queue: [row('a', '1'), row('b', '2'), row('c', '3')],
      sessionId: 's',
    })
    const q = usePromptQueue.getState()
    q.moveUp(0) // 头部越界
    q.moveDown(2) // 尾部越界
    expect(usePromptQueue.getState().queue.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    q.moveUp(2)
    expect(usePromptQueue.getState().queue.map((x) => x.id)).toEqual(['a', 'c', 'b'])
    q.moveDown(0)
    expect(usePromptQueue.getState().queue.map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(transport.queueReorder).toHaveBeenCalledWith({ ids: ['c', 'a', 'b'] }, 's')
  })
})

describe('switchSession（per-session stash）', () => {
  it('暂存当前会话队列、恢复目标会话队列；重复切换幂等', () => {
    usePromptQueue.setState({ queue: [row('a', '1')], sessionId: 's1' })
    usePromptQueue.getState().switchSession('s2')
    let st = usePromptQueue.getState()
    expect(st.sessionId).toBe('s2')
    expect(st.queue).toEqual([]) // s2 无历史队列
    expect(st.queues['s1']?.map((q) => q.id)).toEqual(['a'])
    usePromptQueue.getState().switchSession('s1')
    st = usePromptQueue.getState()
    expect(st.queue.map((q) => q.id)).toEqual(['a'])
    usePromptQueue.getState().switchSession('s1') // 幂等
    expect(usePromptQueue.getState().queue.map((q) => q.id)).toEqual(['a'])
  })

  it('切换会话清空编辑态', () => {
    usePromptQueue.setState({
      queue: [row('a', '1')],
      sessionId: 's1',
      editIndex: 0,
      editDraft: 'x',
    })
    usePromptQueue.getState().switchSession('s2')
    const st = usePromptQueue.getState()
    expect(st.editIndex).toBeNull()
    expect(st.editDraft).toBe('')
  })
})

describe('applyQueueChanged（权威快照广播）', () => {
  it('形状不符返回 null 且不动镜像', () => {
    usePromptQueue.setState({ queue: [row('a', '1')] })
    expect(applyQueueChanged({ foo: 1 })).toBeNull()
    expect(usePromptQueue.getState().queue).toHaveLength(1)
  })

  it('权威快照整体替换镜像：乐观行确认（去 optimistic、补 version）', () => {
    usePromptQueue.setState({
      queue: [row('p1', 'hello', { optimistic: true })],
      sessionId: 's1',
    })
    expect(applyQueueChanged({ entries: [{ id: 'p1', text: 'hello', version: 3 }] }, 's1')).toBeNull()
    const q = usePromptQueue.getState().queue
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ id: 'p1', optimistic: false, version: 3 })
  })

  it('已 drain 的行不被 stale 广播复活', () => {
    usePromptQueue.setState({ queue: [], sessionId: 's1', drainedIds: new Set(['p1']) })
    applyQueueChanged({ entries: [{ id: 'p1', text: 'zombie' }] }, 's1')
    expect(usePromptQueue.getState().queue).toEqual([])
  })

  it('running_prompt_id 命中本地行 → 返回收养并从镜像移除', () => {
    usePromptQueue.setState({
      queue: [row('p1', 'run me', { optimistic: true })],
      sessionId: 's1',
    })
    const adoption = applyQueueChanged({ runningPromptId: 'p1' }, 's1')
    expect(adoption).toMatchObject({ id: 'p1', text: 'run me', fromOptimistic: true })
    expect(usePromptQueue.getState().queue).toEqual([])
  })

  it('id 未命中时按 text 认领乐观行（host 丢 promptId 兜底），不产生重复行', () => {
    usePromptQueue.setState({
      queue: [row('local-1', 'same text', { optimistic: true })],
      sessionId: 's1',
    })
    applyQueueChanged({ entries: [{ id: 'server-9', text: 'same text', version: 1 }] }, 's1')
    const q = usePromptQueue.getState().queue
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ id: 'server-9', optimistic: false, version: 1 })
  })

  it('RPC 失败的降级行不在快照里时保留显示（FE-owned，手动重发）', () => {
    usePromptQueue.setState({
      queue: [row('d1', 'failed send', { degraded: true, errorText: 'net' })],
      sessionId: 's1',
    })
    applyQueueChanged({ entries: [{ id: 'other', text: 'server row' }] }, 's1')
    const ids = usePromptQueue.getState().queue.map((q) => q.id)
    expect(ids).toContain('d1')
    expect(ids).toContain('other')
  })

  it('非活跃会话的广播走 stash：更新目标会话镜像、不动活跃队列、不返回收养', () => {
    usePromptQueue.setState({ queue: [row('a', 'active row')], sessionId: 's1' })
    const adoption = applyQueueChanged(
      { entries: [{ id: 'x1', text: 'other session' }] },
      's2',
    )
    expect(adoption).toBeNull()
    const st = usePromptQueue.getState()
    expect(st.queue.map((q) => q.id)).toEqual(['a'])
    expect(st.queues['s2']?.map((q) => q.id)).toEqual(['x1'])
  })
})
