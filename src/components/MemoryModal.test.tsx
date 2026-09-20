import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { memoryContentHash, type MemoryListing } from '../lib/memory'
import { MemoryModal } from './MemoryModal'

vi.mock('../api/client', () => ({
  transport: {
    // The store registers an event subscriber at module load.
    onEvent: vi.fn(),
    memoryList: vi.fn(),
    memoryToggle: vi.fn(),
    memoryForget: vi.fn(),
    memoryDream: vi.fn(),
    fsReadFile: vi.fn(),
  },
}))

const listMock = vi.mocked(transport.memoryList)
const toggleMock = vi.mocked(transport.memoryToggle)
const forgetMock = vi.mocked(transport.memoryForget)
const readMock = vi.mocked(transport.fsReadFile)

const TOPIC = '/ws/.grok/memory/topics/deploy-conventions.md'
const INDEX = '/ws/.grok/memory/MEMORY.md'
const SESSION_LOG = '/home/.grok/memory/sessions/2026-09-18.md'
const TOPIC_BODY = '# 部署约定\n\n- 生产环境固定使用 eu-west 集群\n'

function listing(over: Partial<MemoryListing> = {}): MemoryListing {
  return {
    files: [
      { path: INDEX, source: 'workspace', sizeBytes: 40, modifiedEpochSecs: 1_700_000_000, generated: true },
      { path: TOPIC, source: 'workspace', sizeBytes: TOPIC_BODY.length, modifiedEpochSecs: 1_700_000_000, generated: false, title: '部署约定' },
      { path: SESSION_LOG, source: 'session', sizeBytes: 20, modifiedEpochSecs: 1_700_000_000, generated: false },
    ],
    enabled: true,
    captureEnabled: true,
    dreamEnabled: true,
    ...over,
  }
}

beforeEach(() => {
  listMock.mockReset()
  toggleMock.mockReset()
  forgetMock.mockReset()
  readMock.mockReset()
  listMock.mockResolvedValue(listing())
  readMock.mockResolvedValue({ content: TOPIC_BODY })
  useChatStore.setState({
    sessionId: 'sess-1',
    memoryOpen: true,
    memoryListing: undefined,
    memoryStatus: undefined,
    memoryError: undefined,
    memoryNotice: undefined,
  })
})

describe('MemoryModal', () => {
  it('未打开 → 不渲染', () => {
    useChatStore.setState({ memoryOpen: false })
    const { container } = render(<MemoryModal />)
    expect(container.firstChild).toBeNull()
  })

  it('打开 → 拉取 listing 并分组展示，索引行带「索引」标记', async () => {
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
    expect(screen.getByText('Workspace')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('索引')).toBeInTheDocument()
    expect(screen.getByText('3/3')).toBeInTheDocument()
  })

  it('选中行 → 读取正文并展示；哈希即 BLAKE3(正文)', async () => {
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
    fireEvent.click(screen.getByText('部署约定'))
    await waitFor(() => expect(screen.getByText(/eu-west 集群/)).toBeInTheDocument())
    expect(readMock).toHaveBeenCalledWith(TOPIC)
  })

  it('删除需二次确认，并把预览正文的 BLAKE3 当凭据传出', async () => {
    forgetMock.mockResolvedValue({ outcome: 'forgotten', wasAlreadyForgotten: false })
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
    fireEvent.click(screen.getByText('部署约定'))
    await waitFor(() => expect(screen.getByLabelText('删除记忆文件')).toBeEnabled())

    fireEvent.click(screen.getByLabelText('删除记忆文件'))
    // 未确认前不删
    expect(forgetMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(forgetMock).toHaveBeenCalledTimes(1))
    expect(forgetMock.mock.calls[0][0]).toBe('sess-1')
    expect(forgetMock.mock.calls[0][1]).toBe(TOPIC)
    expect(forgetMock.mock.calls[0][2]).toBe(memoryContentHash(TOPIC_BODY))
    await waitFor(() => expect(screen.getByText('已删除该记忆文件')).toBeInTheDocument())
  })

  it('store 拒绝删除（笔记已变更）→ 原样展示 agent 的说法', async () => {
    forgetMock.mockResolvedValue({
      outcome: 'rejected',
      reason: 'changed',
      message: 'This note changed since you opened it.',
    })
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
    fireEvent.click(screen.getByText('部署约定'))
    await waitFor(() => expect(screen.getByLabelText('删除记忆文件')).toBeEnabled())
    fireEvent.click(screen.getByLabelText('删除记忆文件'))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() =>
      expect(screen.getByText('This note changed since you opened it.')).toBeInTheDocument(),
    )
    // 笔记仍在列表里
    expect(screen.getByText('部署约定')).toBeInTheDocument()
  })

  it('索引文件与会话日志的删除资格按 store 规则区分', async () => {
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('索引')).toBeInTheDocument())
    // 索引：不可删
    fireEvent.click(screen.getByText('索引'))
    await waitFor(() => expect(screen.getByLabelText('删除记忆文件')).toBeDisabled())
    // 会话日志：可删（store 允许删 legacy 会话日志）
    fireEvent.click(screen.getAllByText('2026-09-18.md')[0])
    await waitFor(() => expect(screen.getByLabelText('删除记忆文件')).toBeEnabled())
  })

  it('文件过大（未完整读取）→ 无可删凭据，按钮禁用', async () => {
    readMock.mockRejectedValue(new Error('File exceeds the read limit'))
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
    fireEvent.click(screen.getByText('部署约定'))
    await waitFor(() => expect(screen.getByText(/File exceeds the read limit/)).toBeInTheDocument())
    expect(screen.getByLabelText('删除记忆文件')).toBeDisabled()
  })

  it('开关记忆：按 t 或点按钮 → memoryToggle，并用响应回写状态', async () => {
    toggleMock.mockResolvedValue({ message: '记忆已关闭', enabled: false, disabledReason: 'session_toggle' })
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('已启用')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '关闭记忆' }))
    await waitFor(() => expect(toggleMock).toHaveBeenCalledWith('sess-1', false))
    await waitFor(() => expect(screen.getByText('本会话已关闭')).toBeInTheDocument())
    expect(screen.getByText('记忆已关闭')).toBeInTheDocument()
  })

  it('记忆关闭且不可开启（进程级）→ 只渲染通告，开关禁用', async () => {
    listMock.mockResolvedValue(
      listing({ enabled: false, disabledReason: 'process_disabled' }),
    )
    render(<MemoryModal />)
    await waitFor(() =>
      expect(screen.getByText(/记忆在本进程中已关闭/)).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: '开启记忆' })).toBeDisabled()
    expect(screen.queryByText('部署约定')).toBeNull()
    expect(screen.getByText(/这里无法开启/)).toBeInTheDocument()
  })

  it('记忆关闭但可开启（config.toml）→ 通告 + 可点开启', async () => {
    listMock.mockResolvedValue(listing({ enabled: false, disabledReason: 'config_opt_out' }))
    toggleMock.mockResolvedValue({ message: '记忆已开启', enabled: true })
    render(<MemoryModal />)
    await waitFor(() =>
      expect(screen.getAllByText(/config\.toml/).length).toBeGreaterThan(0),
    )
    fireEvent.click(screen.getByRole('button', { name: '开启记忆' }))
    await waitFor(() => expect(toggleMock).toHaveBeenCalledWith('sess-1', true))
  })

  it('只有索引、没有笔记 → 空状态通告（并宣传 /dream）', async () => {
    listMock.mockResolvedValue(
      listing({ files: [{ path: INDEX, source: 'workspace', sizeBytes: 40, generated: true }] }),
    )
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('还没有任何记忆。')).toBeInTheDocument())
    expect(screen.getByText(/\/dream/)).toBeInTheDocument()
  })

  it('搜索：按标签/路径过滤，命中数为 0 时提示', async () => {
    const { container } = render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
    const input = screen.getByLabelText('搜索记忆文件')
    fireEvent.change(input, { target: { value: '2026-09-18' } })
    await waitFor(() => expect(screen.queryByText('部署约定')).toBeNull())
    expect(screen.getAllByText('2026-09-18.md').length).toBeGreaterThan(0)
    fireEvent.change(input, { target: { value: 'nothing-matches' } })
    await waitFor(() => expect(container.textContent).toContain('没有匹配'))
    expect(screen.getByText('0/3')).toBeInTheDocument()
  })

  it('Esc 先撤确认、再清搜索、最后关闭', async () => {
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
    fireEvent.click(screen.getByText('部署约定'))
    await waitFor(() => expect(screen.getByLabelText('删除记忆文件')).toBeEnabled())
    fireEvent.click(screen.getByLabelText('删除记忆文件'))
    expect(screen.getByRole('button', { name: '确认删除' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull()
    expect(useChatStore.getState().memoryOpen).toBe(true)
    // 第二次退出窄屏详情、第三次才关闭（TUI 的 Esc 逐层退出）
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().memoryOpen).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().memoryOpen).toBe(false)
  })

  it('列表读取失败（无活动会话）→ 明确提示', async () => {
    listMock.mockRejectedValue(new Error('暂无活动会话'))
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText(/暂无活动会话/)).toBeInTheDocument())
  })

  it('搜索框清空按钮交互与 Esc 清空', async () => {
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
    const input = screen.getByLabelText('搜索记忆文件')
    expect(screen.queryByLabelText('清空搜索')).toBeNull()

    // 输入内容出现清空按钮
    fireEvent.change(input, { target: { value: '部署' } })
    const clearBtn = screen.getByLabelText('清空搜索')
    expect(clearBtn).toBeInTheDocument()

    // 点击清空按钮
    fireEvent.click(clearBtn)
    expect(input).toHaveValue('')
    expect(screen.queryByLabelText('清空搜索')).toBeNull()

    // 再次输入，按 Esc 清空
    fireEvent.change(input, { target: { value: '2026' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
  })

  it('键盘上下箭头切换选中文件并触发滚动可见', async () => {
    const scrollIntoViewMock = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoViewMock

    try {
      render(<MemoryModal />)
      await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())
      ;(document.activeElement as HTMLElement | null)?.blur?.()

      // 默认选中第一个文件（INDEX）
      const initialSelected = screen.getByText('索引').closest('button')
      expect(initialSelected).toHaveAttribute('aria-current', 'true')

      // 按下向下箭头切换到下一个
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      await waitFor(() => {
        const topicBtn = screen.getByText('部署约定').closest('button')
        expect(topicBtn).toHaveAttribute('aria-current', 'true')
      })
      expect(scrollIntoViewMock).toHaveBeenCalled()

      // 按下向上箭头切回
      fireEvent.keyDown(window, { key: 'ArrowUp' })
      await waitFor(() => {
        expect(screen.getByText('索引').closest('button')).toHaveAttribute('aria-current', 'true')
      })
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('右侧预览卡片包含行数信息，且切换文件重置滚动位置', async () => {
    render(<MemoryModal />)
    await waitFor(() => expect(screen.getByText('部署约定')).toBeInTheDocument())

    // 点击包含多行的 TOPIC
    fireEvent.click(screen.getByText('部署约定'))
    await waitFor(() => expect(screen.getByText(/3 行/)).toBeInTheDocument())
  })
})
