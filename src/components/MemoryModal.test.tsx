import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { MemoryModal } from './MemoryModal'

beforeEach(() => {
  useChatStore.setState({
    memoryOpen: true,
    memoryFiles: undefined,
    closeMemory: vi.fn(),
  })
})

describe('MemoryModal', () => {
  it('未打开 → 不渲染', () => {
    useChatStore.setState({ memoryOpen: false })
    const { container } = render(<MemoryModal />)
    expect(container.firstChild).toBeNull()
  })

  it('打开且无文件 → 未启用提示', () => {
    render(<MemoryModal />)
    expect(screen.getByText('暂无记忆文件（记忆可能未启用）')).toBeInTheDocument()
    expect(screen.getByText(/会话保存或 \/flush 后/)).toBeInTheDocument()
  })

  it('有文件 → 记忆已启用 + 文件计数', () => {
    useChatStore.setState({ memoryFiles: [{ name: 'a.md' }] })
    render(<MemoryModal />)
    expect(screen.getByText('记忆已启用')).toBeInTheDocument()
    expect(screen.getByText(/1 个文件/)).toBeInTheDocument()
  })

  it('按 source 分组：Global / Workspace / Sessions 排序与大小格式化', () => {
    useChatStore.setState({
      memoryFiles: [
        { name: 'workspace.md', source: 'workspace', size: 2000 },
        { name: 'global.md', source: 'global', size: 512, updatedAt: 1000 },
        { name: 'session.md', source: 'session', size: 4 * 1024 * 1024, updatedAt: 1_700_000_000_000 },
        // 无 source → 路径嗅探
        { name: 'sniffed.md', path: '/x/y/MEMORY.md' },
        { name: 'ws.md', path: '/root/workspace/zzz' },
      ],
    })
    render(<MemoryModal />)
    expect(screen.getByText('Global')).toBeInTheDocument()
    expect(screen.getByText('Workspace')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('512 B')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByText('4.0 MB')).toBeInTheDocument()
    // 会话日志显示时间而非 '—'
    expect(screen.getByText('11/15/2023', { exact: false })).toBeInTheDocument()
  })

  it('无 source 且路径不可分类 → 扁平 A-Z 列表', () => {
    useChatStore.setState({
      memoryFiles: [
        { name: 'zeta.md' },
        { name: 'alpha.md' },
        { name: 'mid.md' },
      ],
    })
    const { container } = render(<MemoryModal />)
    const names = [...container.querySelectorAll('ul li')].map(
      (li) => li.querySelector('.truncate')?.textContent,
    )
    expect(names).toEqual(['alpha.md', 'mid.md', 'zeta.md'])
    // 无分组标题
    expect(screen.queryByText('Global')).toBeNull()
  })

  it('查看/删除按钮 → 行内提示面板', () => {
    useChatStore.setState({ memoryFiles: [{ name: 'm.md', path: '/mem/m.md', size: 10 }] })
    render(<MemoryModal />)
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    // 文本被 <b> 元素拆开 → 用 textContent 匹配（父子节点都会命中）
    const viewHints = screen.getAllByText((_, el) => el?.textContent?.includes('请在 TUI / 终端 中查看该记忆文件') ?? false)
    expect(viewHints.length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    const delHints = screen.getAllByText((_, el) => el?.textContent?.includes('请在 TUI / 终端 中手动删除该记忆文件') ?? false)
    expect(delHints.length).toBeGreaterThan(0)
  })

  it('行内提示显示文件路径', () => {
    useChatStore.setState({ memoryFiles: [{ name: 'm.md', path: '/mem/m.md' }] })
    render(<MemoryModal />)
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    // 路径同时出现在行内与提示面板
    expect(screen.getAllByText('/mem/m.md').length).toBe(2)
  })

  it('Esc → closeMemory；背景点击 → closeMemory', () => {
    render(<MemoryModal />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useChatStore.getState().closeMemory).toHaveBeenCalledTimes(1)

    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog)
    expect(useChatStore.getState().closeMemory).toHaveBeenCalledTimes(2)
  })

  it('关闭按钮 → closeMemory', () => {
    render(<MemoryModal />)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(useChatStore.getState().closeMemory).toHaveBeenCalled()
  })

  it('无路径文件用 name 兜底展示', () => {
    useChatStore.setState({ memoryFiles: [{ name: 'only-name.md' }] })
    render(<MemoryModal />)
    // path 行回退为 name（出现两次：标题 + 路径行）
    expect(screen.getAllByText('only-name.md').length).toBeGreaterThan(1)
  })
})