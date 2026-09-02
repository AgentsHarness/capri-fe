import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { usePins } from '../store/historyPins'
import { useHistoryView } from '../store/historyView'
import { SessionHistoryList } from './SessionHistoryList'

/**
 * 会话行的呈现规则：
 * - 只有「当前」选中行有底色（bg-gn-bg-highlight）；非空闲会话靠行内
 *   字样/图标区分（处理中 = 自转的加载图标 / 待处理 = 蓝色实心菱形 /
 *   后台任务 = bg 徽标 / 完成待查看 = ✓）。
 * - 空闲行不画空心菱形；置顶 / 待办徽标占掉空出来的行首一格，
 *   状态图标要占那一格时徽标退回标题前。
 * - 标记视角的分组标题不带图标。
 */

// 时间戳必须落在「6 小时内活跃」窗口里，否则 workspace 组默认收起、行不渲染
const T_OLD = new Date(Date.now() - 60_000).toISOString()
const T_NEW = new Date(Date.now() - 1_000).toISOString()

function seed() {
  usePins.setState({ pinnedSessions: new Set(['pinned-idle', 'pinned-run']), todos: {} })
  useChatStore.setState({
    sessionId: undefined,
    cwd: '/x',
    historyLoading: false,
    workspaceLoading: false,
    completedNotices: {},
    continueSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    newSession: vi.fn(),
    workspaceLoadMore: vi.fn(),
    switchWorkspaceListMode: vi.fn(),
    workspaces: [
      {
        cwd: '/x',
        label: '/x',
        sessions: [
          { sessionId: 'idle', cwd: '/x', title: '空闲会话', updatedAt: T_OLD },
          { sessionId: 'run', cwd: '/x', title: '处理中会话', updatedAt: T_NEW },
          { sessionId: 'ask', cwd: '/x', title: '待处理会话', updatedAt: T_NEW },
          { sessionId: 'pinned-idle', cwd: '/x', title: '置顶空闲会话', updatedAt: T_OLD },
          { sessionId: 'pinned-run', cwd: '/x', title: '置顶处理中会话', updatedAt: T_OLD },
        ],
      },
    ],
    sessions: [
      { sessionId: 'idle', cwd: '/x', status: { state: 'idle' } },
      { sessionId: 'run', cwd: '/x', status: { state: 'active', busy: true } },
      { sessionId: 'ask', cwd: '/x', status: { state: 'awaiting', busy: true, awaitingInput: true } },
      { sessionId: 'pinned-idle', cwd: '/x', status: { state: 'idle' } },
      { sessionId: 'pinned-run', cwd: '/x', status: { state: 'active', busy: true } },
    ],
  } as never)
}

function row(title: string): HTMLElement {
  const el = screen.getByText(title).closest('div[role="button"]')
  if (!el) throw new Error(`row not found: ${title}`)
  return el as HTMLElement
}

/** 行上的实际 class 集合（避免把 hover: 变体误当成底色）。 */
function rowClasses(title: string): string[] {
  return row(title).className.split(/\s+/)
}

function leading(rowEl: HTMLElement): Element | null {
  return rowEl.firstElementChild
}

beforeEach(() => {
  localStorage.clear()
  useHistoryView.setState({ mode: 'workspace' })
  seed()
})

afterEach(() => {
  cleanup()
})

describe('行底色只留给「当前」', () => {
  it('非空闲行不铺底色，选中行才铺', () => {
    render(<SessionHistoryList />)
    for (const title of ['处理中会话', '待处理会话', '空闲会话']) {
      expect(rowClasses(title)).not.toContain('bg-gn-bg-highlight')
    }
    cleanup()
    useChatStore.setState({ sessionId: 'run' } as never)
    render(<SessionHistoryList />)
    expect(rowClasses('处理中会话')).toContain('bg-gn-bg-highlight')
  })
})

describe('行首状态列', () => {
  it('空闲行不画菱形，置顶徽标占掉这一格', () => {
    render(<SessionHistoryList />)
    const plain = row('空闲会话')
    expect(plain.querySelector('svg')).toBeNull()
    expect(leading(plain)?.textContent).toBe('')

    const pinned = row('置顶空闲会话')
    expect(leading(pinned)?.querySelector('[aria-label="已置顶"]')).not.toBeNull()
  })

  it('状态占了行首时，置顶徽标退回标题前', () => {
    render(<SessionHistoryList />)
    const r = row('置顶处理中会话')
    const loader = leading(r)?.querySelector('svg')
    expect(loader).not.toBeNull()
    expect(loader?.classList.contains('animate-spin')).toBe(true)
    expect(leading(r)?.querySelector('[aria-label="已置顶"]')).toBeNull()
    expect(r.querySelectorAll('[aria-label="已置顶"]')).toHaveLength(1)
  })

  it('待处理行行首是实心菱形', () => {
    render(<SessionHistoryList />)
    expect(leading(row('待处理会话'))?.querySelector('svg')).not.toBeNull()
  })
})

describe('标记视角', () => {
  it('不铺底色，分组标题不带图标', () => {
    useHistoryView.setState({ mode: 'marked' })
    render(<SessionHistoryList />)
    expect(rowClasses('处理中会话')).not.toContain('bg-gn-bg-highlight')
    for (const label of ['思考中', '置顶']) {
      // 组名被包在 truncate 用的内层 span 里，图标（若有）会是它的兄弟节点
      const labelBox = screen.getByText(label).parentElement
      expect(labelBox?.querySelector('svg')).toBeNull()
    }
  })

  it('行首规则同样生效（空闲的置顶行把徽标提到行首）', () => {
    useHistoryView.setState({ mode: 'marked' })
    render(<SessionHistoryList />)
    const section = row('置顶空闲会话')
    expect(leading(section)?.querySelector('[aria-label="已置顶"]')).not.toBeNull()
  })
})

describe('组头图标与文字同轴', () => {
  it('折叠箭头按 flex 项排（不再被行盒基线抬高）', () => {
    render(<SessionHistoryList />)
    // 组名是 repoNameFromCwd('/x') = 'x'
    const head = screen.getByText('x').closest('button')
    const chevronBox = head?.firstElementChild
    expect(chevronBox?.className).toContain('flex')
    expect(chevronBox?.className).toContain('items-center')
    // 组名容器自己是 flex，置顶图标与文字同轴
    expect(screen.getByText('x').parentElement?.className).toContain('items-center')
  })
})

describe('当前标记字号', () => {
  it('当前行的「当前」字样比 bg 徽标大', () => {
    useChatStore.setState({ sessionId: 'idle' } as never)
    render(<SessionHistoryList />)
    const chip = screen.getByText('当前')
    expect(chip.className).toContain('text-[11px]')
  })
})
