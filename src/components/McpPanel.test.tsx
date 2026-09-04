import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { McpListServer, McpToolInfo } from '../api/transport'

// ── store / api client mock ──
const h = vi.hoisted(() => {
  const chatState: Record<string, unknown> = {}
  /**
   * 订阅者集合：让 setStore 能推动已挂载的面板重渲染（mcpVersion 自增
   * → 重取列表这类"活 store"行为必须可测）。
   */
  const listeners = new Set<() => void>()
  return {
    chatState,
    listeners,
    setStateSpy: vi.fn(),
    transport: {
      mcpCall: vi.fn(),
      mcpReadResource: vi.fn(),
    },
  }
})

vi.mock('../store/chat', async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react')
  const subscribe = (fn: () => void) => {
    h.listeners.add(fn)
    return () => {
      h.listeners.delete(fn)
    }
  }
  const useChatStore = Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      // Selectors return store fields (stable refs), so the raw field is a
      // valid getSnapshot value.
      useSyncExternalStore(subscribe, () => sel(h.chatState)),
    { getState: () => h.chatState, setState: h.setStateSpy },
  )
  return { useChatStore }
})

vi.mock('../api/client', () => ({
  transport: h.transport,
}))

import { McpPanel } from './McpPanel'

const mcpList = vi.fn()
const mcpToggle = vi.fn()
const mcpToggleTool = vi.fn()
const mcpAdd = vi.fn()
const mcpRemove = vi.fn()
const mcpAuthTrigger = vi.fn()

function setStore(patch: Record<string, unknown>) {
  act(() => {
    Object.assign(h.chatState, patch)
    for (const l of [...h.listeners]) l()
  })
}

const tools: McpToolInfo[] = [
  { name: 'read', displayName: '读取', description: '读文件', enabled: true },
  { name: 'write', enabled: false },
]

beforeEach(() => {
  for (const k of Object.keys(h.chatState)) delete h.chatState[k]
  setStore({
    mcpServers: [],
    mcpInit: undefined,
    mcpVersion: 0,
    mcpList,
    mcpToggle,
    mcpToggleTool,
    mcpAdd,
    mcpRemove,
    mcpAuthTrigger,
  })
  mcpList.mockReset().mockResolvedValue([])
  mcpToggle.mockReset().mockResolvedValue(undefined)
  mcpToggleTool.mockReset().mockResolvedValue(undefined)
  mcpAdd.mockReset().mockResolvedValue(undefined)
  mcpRemove.mockReset().mockResolvedValue(undefined)
  mcpAuthTrigger.mockReset().mockResolvedValue({})
  h.transport.mcpCall.mockReset().mockResolvedValue({ ok: true })
  h.transport.mcpReadResource.mockReset().mockResolvedValue('file body')
  h.setStateSpy.mockClear()
})

function renderPanel() {
  return render(<McpPanel open onClose={() => {}} />)
}

describe('McpPanel — 打开/关闭与状态区', () => {
  it('open=false → null', () => {
    const { container } = render(<McpPanel open={false} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('打开时拉取列表；事件流服务器行渲染', async () => {
    setStore({
      mcpServers: [
        { name: 'fs', status: 'ready' },
        { name: 'db', status: 'needs_auth', reason: 'oauth' },
      ],
    })
    renderPanel()
    // 统一卡片渲染该名字
    expect((await screen.findAllByText('fs')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('2 个服务器')).not.toBeNull()
    expect(screen.getAllByText('db').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('oauth').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/尚未收到服务器状态通知/)).toBeNull()
    expect(mcpList).toHaveBeenCalled()
  })

  it('没有任何服务器 → 只留一处准确空态（不再甩锅状态推送）', async () => {
    renderPanel()
    expect(await screen.findByText('没有已配置的服务器')).not.toBeNull()
    expect(screen.queryByText(/尚未收到服务器状态通知/)).toBeNull()
    // 上半区无内容时整块（含标题）不渲染，不与下半区重复空态
    expect(screen.queryByText('服务器状态')).toBeNull()
  })

  it('仅 list 有数据（事件流没推过状态）→ 计数与状态区都有内容', async () => {
    mcpList.mockResolvedValue([
      { name: 'fs', source: 'local', status: 'ready', tools: [] },
      { name: 'gh', source: 'managed', authRequired: true },
    ] as McpListServer[])
    const { container } = renderPanel()
    expect(await screen.findByText('2 个服务器')).not.toBeNull()
    expect(screen.queryByText(/尚未收到服务器状态通知/)).toBeNull()
    // 统一卡片渲染
    expect((await screen.findAllByText('gh')).length).toBeGreaterThanOrEqual(1)
    // 事件流没有 status 时，list 的 authRequired 推导出行状态
    expect(container.textContent).toContain('needs_auth · managed')
    expect(container.textContent).toContain('ready · local')
  })

  it('authRequired / setupRequired → 行上有可见标识', async () => {
    mcpList.mockResolvedValue([
      { name: 'gh', authRequired: true },
      { name: 'linear', setupRequired: true },
      { name: 'fs', status: 'ready' },
    ] as McpListServer[])
    const { container } = renderPanel()
    expect((await screen.findAllByText('gh')).length).toBeGreaterThan(0)
    // 统一卡片上的一枚徽标（fs 行无 flag）
    expect(screen.getAllByText('需要认证')).toHaveLength(1)
    expect(screen.getAllByText('需要配置')).toHaveLength(1)
    // 「为什么看不到工具」在工具区也有解释
    expect(container.textContent).toContain('无工具信息（需要认证后才会拉取工具）')
    expect(container.textContent).toContain('无工具信息（需要配置后才会拉取工具）')
  })

  it('工具数为 0 与「无工具信息」区分；后者退回 agent toolCount', async () => {
    mcpList.mockResolvedValue([
      { name: 'empty', enabled: true, tools: [] },
      { name: 'counted', enabled: true, toolCount: 3 },
      { name: 'silent', enabled: true },
    ] as McpListServer[])
    const { container } = renderPanel()
    expect((await screen.findAllByText('empty')).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('工具 (0)')
    expect(container.textContent).toContain('该服务器没有工具')
    expect(container.textContent).toContain('工具 (3)')
    expect(container.textContent).toContain('无工具信息')
  })

  it('mcpInit 连接中显示进度条；连接完成隐藏', async () => {
    setStore({
      mcpInit: { total: 2, connected: 1, startedAt: 0 },
      mcpServers: [{ name: 'fs', status: 'ready' }],
    })
    const { container } = renderPanel()
    expect(await screen.findByText('MCP 初始化中 · 1/2 已连接')).not.toBeNull()
    expect(container.querySelector('[style*="width"]')).not.toBeNull()

    setStore({
      mcpInit: { total: 2, connected: 2, startedAt: 0 },
    })
    const { container: c2 } = renderPanel()
    await screen.findAllByText('fs')
    expect(c2.textContent).not.toContain('MCP 初始化中')
  })

  it('列表拉取失败 → 错误行；失败后重试成功恢复', async () => {
    mcpList.mockRejectedValueOnce(new Error('host dead'))
    renderPanel()
    expect(await screen.findByText('host dead')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
    expect(await screen.findByText('没有已配置的服务器')).not.toBeNull()
  })

  it('Esc 关闭', async () => {
    const onClose = vi.fn()
    render(<McpPanel open onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('McpPanel — mcpVersion 重取列表', () => {
  it('mcpVersion 自增（tools_changed / servers_updated）→ 重取', async () => {
    renderPanel()
    await waitFor(() => expect(mcpList).toHaveBeenCalledTimes(1))
    setStore({ mcpVersion: 1 })
    await waitFor(() => expect(mcpList).toHaveBeenCalledTimes(2))
  })

  it('重取后列表内容真的更新', async () => {
    mcpList.mockResolvedValueOnce([{ name: 'one' }] as McpListServer[])
    renderPanel()
    expect((await screen.findAllByText('one')).length).toBeGreaterThan(0)
    mcpList.mockResolvedValueOnce([{ name: 'two', status: 'ready' }] as McpListServer[])
    setStore({ mcpVersion: 2 })
    expect((await screen.findAllByText('two')).length).toBeGreaterThan(0)
    expect(screen.queryByText('one')).toBeNull()
  })

  it('mcpVersion 不变 → 其它 store 更新不会触发多余请求', async () => {
    renderPanel()
    await waitFor(() => expect(mcpList).toHaveBeenCalledTimes(1))
    setStore({ mcpServers: [{ name: 'fs', status: 'ready' }] })
    await new Promise((r) => setTimeout(r, 20))
    expect(mcpList).toHaveBeenCalledTimes(1)
  })

  it('迟到的旧响应不覆盖新结果（reqSeq 守卫）', async () => {
    setStore({ mcpVersion: 0 })
    let releaseFirst: (v: McpListServer[]) => void = () => {}
    mcpList
      .mockImplementationOnce(
        () =>
          new Promise<McpListServer[]>((res) => {
            releaseFirst = res
          }),
      )
      .mockResolvedValueOnce([{ name: 'fresh', status: 'ready' }] as McpListServer[])
    const { container } = renderPanel()
    await waitFor(() => expect(mcpList).toHaveBeenCalledTimes(1))
    setStore({ mcpVersion: 1 })
    expect((await screen.findAllByText('fresh')).length).toBeGreaterThan(0)
    releaseFirst([{ name: 'stale', status: 'error' }] as McpListServer[])
    await waitFor(() => expect(mcpList).toHaveBeenCalledTimes(2))
    expect(container.textContent).not.toContain('stale')
  })
})

describe('McpPanel — 管理操作', () => {
  it('列表行合并：事件流优先 status，list 补充 source/enabled/tools', async () => {
    setStore({
      mcpServers: [{ name: 'fs', status: 'ready' }],
    })
    mcpList.mockResolvedValue([
      {
        name: 'fs',
        status: 'ready',
        source: 'config',
        command: 'npx fs',
        enabled: false,
        tools,
      },
      { name: 'multi', command: 'npx mcp', enabled: true },
    ] as McpListServer[])
    const { container } = renderPanel()
    expect((await screen.findAllByText('agent-list')).length).toBeGreaterThanOrEqual(2)
    expect(container.textContent).toContain('npx fs')
    expect(container.textContent).toContain('工具 (2)')
    expect(screen.getAllByRole('button', { name: '启用' }).length).toBeGreaterThan(0)
    // 多行合并后事件流行也在
    expect(container.textContent).toContain('multi')
  })

  it('事件流 status 优先于 list status（状态区与管理区都用事件流的）', async () => {
    setStore({
      mcpServers: [{ name: 'fs', status: 'error', reason: 'spawn failed' }],
    })
    mcpList.mockResolvedValue([
      { name: 'fs', status: 'ready', source: 'local', toolCount: 4, authRequired: true },
    ] as McpListServer[])
    const { container } = renderPanel()
    expect((await screen.findAllByText('fs')).length).toBeGreaterThanOrEqual(1)
    // 事件流的 error 覆盖 list 的 ready（连 authRequired 推导也不越权）
    expect(container.textContent).toContain('error · local')
    expect(container.textContent).not.toContain('ready')
    expect(screen.getAllByText('spawn failed')).toHaveLength(1)
    // 列表侧补充字段仍然合并进来
    expect(container.textContent).toContain('需要认证')
    expect(container.textContent).toContain('工具 (4)')
  })

  it('无工具信息降级文案', async () => {
    mcpList.mockResolvedValue([{ name: 'fs', enabled: true }] as McpListServer[])
    const { container } = renderPanel()
    expect((await screen.findAllByText('fs')).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('无工具信息')
  })

  it('服务器启用/禁用 → mcpToggle + statusText', async () => {
    setStore({ mcpServers: [{ name: 'fs', status: 'ready' }] })
    mcpList.mockResolvedValue([{ name: 'fs', enabled: false } as McpListServer])
    renderPanel()
    const btn = await screen.findByRole('button', { name: '启用' })
    fireEvent.click(btn)
    await waitFor(() => expect(mcpToggle).toHaveBeenCalledWith('fs', true))
    await waitFor(() =>
      expect(h.setStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ statusText: '已启用 MCP 服务器 fs' }),
      ),
    )
  })

  it('工具启停 → mcpToggleTool 传目标状态（非当前状态）+ 乐观翻转', async () => {
    setStore({ mcpServers: [{ name: 'fs', status: 'ready' }] })
    mcpList.mockResolvedValue([{ name: 'fs', enabled: true, tools } as McpListServer])
    renderPanel()
    // 按 title 定位（「禁用」这个文案在服务器级按钮上同名）
    const disableRead = await screen.findByTitle('禁用工具 read（/api/mcp/toggle-tool）')
    // 已启用的 read：按钮文案「禁用」→ 必须传 false（曾经的 bug 是传当前
    // 状态 true，点一下等于没点，还回显「已启用」）。
    fireEvent.click(disableRead)
    await waitFor(() => expect(mcpToggleTool).toHaveBeenCalledWith('fs', 'read', false))
    await waitFor(() =>
      expect(h.setStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ statusText: '已禁用工具 read（fs）' }),
      ),
    )
    // 已禁用的 write：按钮文案「启用」→ 传 true。
    fireEvent.click(await screen.findByTitle('启用工具 write（/api/mcp/toggle-tool）'))
    await waitFor(() => expect(mcpToggleTool).toHaveBeenCalledWith('fs', 'write', true))
    await waitFor(() =>
      expect(h.setStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ statusText: '已启用工具 write（fs）' }),
      ),
    )
  })

  it('删除服务器：confirm 取消不调用；确认后调用 mcpRemove', async () => {
    window.confirm = vi.fn(() => false)
    setStore({ mcpServers: [{ name: 'fs', status: 'ready' }] })
    mcpList.mockResolvedValue([{ name: 'fs', enabled: true } as McpListServer])
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(mcpRemove).not.toHaveBeenCalled()

    window.confirm = vi.fn(() => true)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(mcpRemove).toHaveBeenCalledWith('fs'))
    await waitFor(() =>
      expect(h.setStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ statusText: '已删除 MCP 服务器 fs' }),
      ),
    )
  })

  it('认证触发 → 渲染 url/code/message', async () => {
    mcpAuthTrigger.mockResolvedValue({ url: 'https://auth.dev', code: 'ABC123' })
    setStore({ mcpServers: [{ name: 'fs', status: 'needs_auth' }] })
    mcpList.mockResolvedValue([{ name: 'fs', enabled: true } as McpListServer])
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: '认证' }))
    const link = await screen.findByRole('link', { name: 'https://auth.dev' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByText(/认证码: ABC123/)).not.toBeNull()
  })

  it('认证链接协议白名单：javascript: / data: 不落成可点链接', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>']) {
      mcpAuthTrigger.mockResolvedValue({ url: bad })
      setStore({ mcpServers: [{ name: 'fs', status: 'needs_auth' }] })
      mcpList.mockResolvedValue([{ name: 'fs', enabled: true } as McpListServer])
      const { container, unmount } = renderPanel()
      fireEvent.click(await screen.findByRole('button', { name: '认证' }))
      await waitFor(() => expect(container.textContent).toContain('已触发认证流程'))
      expect(container.querySelector('a[href]')).toBeNull()
      expect(container.textContent).not.toContain('javascript:alert')
      unmount()
    }
  })

  it('操作失败 → actionError 行', async () => {
    mcpToggle.mockRejectedValue(new Error('denied'))
    setStore({ mcpServers: [{ name: 'fs', status: 'ready' }] })
    mcpList.mockResolvedValue([{ name: 'fs', enabled: false } as McpListServer])
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: '启用' }))
    expect(await screen.findByText(/启停「fs」失败: denied/)).not.toBeNull()
  })
})

describe('McpPanel — 添加服务器表单', () => {
  it('必填校验：name/command 缺失', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }))
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText('name 和 command 为必填项')).not.toBeNull()
  })

  it('args 空格分割 / JSON 数组 / env 解析后提交', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }))
    const inputs = screen.getAllByRole('textbox')
    fireEvent.change(inputs[0], { target: { value: 'fs' } })
    fireEvent.change(inputs[1], { target: { value: 'npx' } })
    fireEvent.change(inputs[2], { target: { value: '["-y","pkg"]' } })
    fireEvent.change(inputs[3], { target: { value: 'TOKEN=abc\nPORT=8080' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() =>
      expect(mcpAdd).toHaveBeenCalledWith({
        name: 'fs',
        command: 'npx',
        args: ['-y', 'pkg'],
        env: { TOKEN: 'abc', PORT: '8080' },
      }),
    )
    await waitFor(() =>
      expect(h.setStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ statusText: '已添加 MCP 服务器 fs' }),
      ),
    )
    // 表单关闭
    expect(screen.queryByPlaceholderText('filesystem')).toBeNull()
  })

  it('env 格式错误 / args JSON 非字符串数组 → formError', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }))
    const inputs = screen.getAllByRole('textbox')
    fireEvent.change(inputs[0], { target: { value: 'fs' } })
    fireEvent.change(inputs[1], { target: { value: 'npx' } })
    fireEvent.change(inputs[2], { target: { value: '[1,2]' } })
    fireEvent.change(inputs[3], { target: { value: 'BADLINE' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText(/环境变量行格式错误/)).not.toBeNull()
    expect(mcpAdd).not.toHaveBeenCalled()
  })

  it('添加失败 → formError', async () => {
    mcpAdd.mockRejectedValueOnce(new Error('spawn failed'))
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }))
    const inputs = screen.getAllByRole('textbox')
    fireEvent.change(inputs[0], { target: { value: 'fs' } })
    fireEvent.change(inputs[1], { target: { value: 'npx' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText(/添加失败: spawn failed/)).not.toBeNull()
  })
})

describe('McpPanel — 调用工具 / 读取资源', () => {
  async function openCallForm() {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '＋ 调用工具' }))
    // 等 refreshList 先把 fs 选项渲染出来（jsdom select 值需要对应 option）
    await waitFor(() => expect(screen.getByRole('option', { name: 'fs' })).not.toBeNull())
    // server select + tool input（input[list] 也是 combobox role）
    const boxes = screen.getAllByRole('combobox')
    fireEvent.change(boxes[0], { target: { value: 'fs' } })
    fireEvent.change(boxes[1], { target: { value: 'read' } })
    return screen.getByPlaceholderText('{"path": "/tmp/x"}')
  }

  it('调用工具成功 → transport.mcpCall + 结果预览', async () => {
    setStore({
      mcpServers: [{ name: 'fs', status: 'ready' }],
    })
    mcpList.mockResolvedValue([{ name: 'fs', enabled: true, tools } as McpListServer])
    const args = await openCallForm()
    fireEvent.change(args, { target: { value: '{"path":"/tmp/x"}' } })
    fireEvent.click(screen.getByRole('button', { name: /^调用$/ }))
    await waitFor(() =>
      expect(h.transport.mcpCall).toHaveBeenCalledWith({
        server: 'fs',
        tool: 'read',
        args: { path: '/tmp/x' },
      }),
    )
    expect(await screen.findByText(/\{\s*"ok": true\s*\}/)).not.toBeNull()
  })

  it('调用工具：非法 JSON / 缺字段校验', async () => {
    mcpList.mockResolvedValue([{ name: 'fs', enabled: true } as McpListServer])
    const args = await openCallForm()
    fireEvent.change(args, { target: { value: '{bad' } })
    fireEvent.click(screen.getByRole('button', { name: /^调用$/ }))
    expect(await screen.findByText('arguments 不是合法 JSON')).not.toBeNull()
    expect(h.transport.mcpCall).not.toHaveBeenCalled()

    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^调用$/ }))
    expect(await screen.findByText('server 和 tool 为必填项')).not.toBeNull()
  })

  it('调用失败 → callError', async () => {
    h.transport.mcpCall.mockRejectedValue(new Error('rpc err'))
    mcpList.mockResolvedValue([{ name: 'fs', enabled: true } as McpListServer])
    await openCallForm()
    fireEvent.click(screen.getByRole('button', { name: /^调用$/ }))
    expect(await screen.findByText(/调用失败: rpc err/)).not.toBeNull()
  })

  it('读取资源成功/校验', async () => {
    setStore({ mcpServers: [{ name: 'fs', status: 'ready' }] })
    mcpList.mockResolvedValue([{ name: 'fs', enabled: true } as McpListServer])
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '＋ 读取资源' }))
    await waitFor(() => expect(screen.getByRole('option', { name: 'fs' })).not.toBeNull())
    // 读取表单只有 server select 是 combobox（uri input 无 list）
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'fs' } })
    const uri = screen.getByPlaceholderText('file:///… 或 mcp://… 等资源 URI') as HTMLInputElement
    fireEvent.change(uri, { target: { value: 'file:///a' } })
    fireEvent.click(screen.getByRole('button', { name: /^读取$/ }))
    await waitFor(() =>
      expect(h.transport.mcpReadResource).toHaveBeenCalledWith({
        server: 'fs',
        uri: 'file:///a',
      }),
    )
    expect(await screen.findByText('file body')).not.toBeNull()

    fireEvent.change(uri, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^读取$/ }))
    expect(await screen.findByText('server 和 uri 为必填项')).not.toBeNull()
  })
})