import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createLocalDir, listLocalDirs, type ListLocalDirsResult } from '../api/localFs'
import { DirectoryPickerModal } from './DirectoryPickerModal'

vi.mock('../api/localFs', () => ({
  listLocalDirs: vi.fn(),
  createLocalDir: vi.fn(),
}))

const listMock = vi.mocked(listLocalDirs)
const createMock = vi.mocked(createLocalDir)

const onClose = vi.fn()
const onPick = vi.fn()

/** host 成功应答：path 是归一化后的宿主原生路径，dirs 是绝对路径的条目。 */
function listed(path: string, dirs: Record<string, string> = {}, home = '/home/u') {
  return {
    ok: true as const,
    path,
    home,
    dirs: Object.entries(dirs).map(([name, p]) => ({ name, path: p })),
  }
}

function failed(error: string, path?: string) {
  return { ok: false as const, error, ...(path ? { path } : {}) }
}

beforeEach(() => {
  listMock.mockReset()
  createMock.mockReset()
  onClose.mockReset()
  onPick.mockReset()
})

function renderModal(initial?: string) {
  return render(
    <DirectoryPickerModal open initial={initial} onClose={onClose} onPick={onPick} />,
  )
}

function draftInput(): HTMLInputElement {
  return screen.getByPlaceholderText('路径或 ~（回车跳转）') as HTMLInputElement
}

describe('DirectoryPickerModal', () => {
  it('未打开 → 不渲染、不发请求', () => {
    const { container } = render(
      <DirectoryPickerModal open={false} initial="/home/u" onClose={onClose} onPick={onPick} />,
    )
    expect(container.firstChild).toBeNull()
    expect(listMock).not.toHaveBeenCalled()
  })

  it('打开 + initial → 用 host 返回的绝对路径列子目录（前端不拼路径）', async () => {
    listMock.mockResolvedValue(
      listed('/home/u', { src: '/home/u/src', docs: '/home/u/docs' }),
    )
    const { container } = renderModal('/home/u')

    expect(await screen.findByRole('button', { name: 'src' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'docs' })).toBeInTheDocument()
    expect(listMock).toHaveBeenCalledWith('/home/u')
    expect(container.textContent).toContain('当前：/home/u')
  })

  it('无 initial → 请求空路径让 host 落主目录，并在「当前」里显示它', async () => {
    listMock.mockResolvedValue(listed('/Users/ben', {}, '/Users/ben'))
    const { container } = renderModal()

    await waitFor(() => expect(listMock).toHaveBeenCalledWith(''))
    await waitFor(() => expect(container.textContent).toContain('当前：/Users/ben'))
    expect(draftInput().value).toBe('/Users/ben')
  })

  it('点目录行 → 用该行返回的 path 继续列（不拼接）', async () => {
    listMock
      .mockResolvedValueOnce(listed('/home/u', { src: '/home/u/src' }))
      .mockResolvedValueOnce(listed('/home/u/src', { deep: '/home/u/src/deep' }))
    renderModal('/home/u')

    fireEvent.click(await screen.findByRole('button', { name: 'src' }))

    await waitFor(() => expect(listMock).toHaveBeenNthCalledWith(2, '/home/u/src'))
    expect(await screen.findByRole('button', { name: 'deep' })).toBeInTheDocument()
  })

  it('上级 → 按输入框里的字面路径爬一级', async () => {
    listMock
      .mockResolvedValueOnce(listed('/home/u/src'))
      .mockResolvedValueOnce(listed('/home/u', { docs: '/home/u/docs' }))
    renderModal('/home/u/src')

    fireEvent.click(await screen.findByRole('button', { name: '上级' }))

    await waitFor(() => expect(listMock).toHaveBeenNthCalledWith(2, '/home/u'))
    expect(await screen.findByRole('button', { name: 'docs' })).toBeInTheDocument()
  })

  it('根目录 → 上级禁用', async () => {
    listMock.mockResolvedValue(listed('/'))
    renderModal('/')
    expect(await screen.findByRole('button', { name: '上级' })).toBeDisabled()
  })

  it('Windows：/d/aiwork 打开后显示宿主归一化的 D:\\aiwork，上级按盘符爬', async () => {
    listMock
      .mockResolvedValueOnce(listed('D:\\aiwork', { src: 'D:\\aiwork\\src' }))
      .mockResolvedValueOnce(listed('D:\\'))
    const { container } = renderModal('/d/aiwork')

    expect(await screen.findByRole('button', { name: 'src' })).toBeInTheDocument()
    expect(listMock).toHaveBeenCalledWith('/d/aiwork')
    expect(draftInput().value).toBe('D:\\aiwork')
    expect(container.textContent).toContain('当前：D:\\aiwork')

    fireEvent.click(screen.getByRole('button', { name: '上级' }))
    // 上级按盘符取（D:\），请求原样发出去、由 host 归一化
    await waitFor(() => expect(listMock).toHaveBeenNthCalledWith(2, 'D:\\'))
  })

  it('Windows：盘根 D:\\ 没有上级', async () => {
    listMock.mockResolvedValue(listed('D:\\', { aiwork: 'D:\\aiwork' }))
    renderModal('D:\\')

    expect(await screen.findByRole('button', { name: 'aiwork' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上级' })).toBeDisabled()
  })

  it('手改路径 + Enter → 先归一化：/d/work 请求出去、D:\\work 显示回来；同路径不重复请求', async () => {
    listMock
      .mockResolvedValueOnce(listed('/home/u'))
      .mockResolvedValueOnce(listed('D:\\work'))
    renderModal('/home/u')
    const input = draftInput()
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    fireEvent.change(input, { target: { value: '/d/work' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(listMock).toHaveBeenNthCalledWith(2, '/d/work'))
    await waitFor(() => expect(input.value).toBe('D:\\work'))

    // 输入法组字中的 Enter → 不跳转（真实 KeyboardEvent 才能带 isComposing）
    const ime = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })
    input.dispatchEvent(ime)
    expect(listMock).toHaveBeenCalledTimes(2)

    // 相同路径 → 不触发
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('相对路径 + Enter → 拼到当前目录上', async () => {
    listMock.mockResolvedValueOnce(listed('/home/u')).mockResolvedValueOnce(listed('/home/u/src'))
    renderModal('/home/u')
    const input = draftInput()
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    fireEvent.change(input, { target: { value: 'src' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(listMock).toHaveBeenNthCalledWith(2, '/home/u/src'))
  })

  it('不存在的路径：报错、「选择此目录」禁用，点也不选（不能拿不存在的路径继续）', async () => {
    listMock
      .mockResolvedValue(failed('目录不存在：/nope', '/nope'))
      .mockResolvedValueOnce(listed('/home/u', { src: '/home/u/src' }))
    renderModal('/home/u')
    const input = draftInput()
    await screen.findByRole('button', { name: 'src' })

    fireEvent.change(input, { target: { value: '/nope' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('目录不存在：/nope')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'src' })).toBeNull() // 旧列表清空
    const pick = screen.getByRole('button', { name: '选择此目录' })
    expect(pick).toBeDisabled()
    fireEvent.click(pick)
    expect(onPick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    // 重试按钮按当前草稿重发
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(listMock).toHaveBeenNthCalledWith(3, '/nope'))
  })

  it('手改路径后直接点「选择此目录」→ 先验一遍，成功用归一化后的路径选中', async () => {
    listMock.mockResolvedValueOnce(listed('/home/u')).mockResolvedValueOnce(listed('D:\\proj'))
    renderModal('/home/u')
    const input = draftInput()
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    fireEvent.change(input, { target: { value: '/d/proj' } })
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }))

    await waitFor(() => expect(onPick).toHaveBeenCalledWith('D:\\proj'))
    expect(listMock).toHaveBeenNthCalledWith(2, '/d/proj')
    expect(onClose).toHaveBeenCalled()
  })

  it('手改路径后直接点选但路径不存在 → 不选、不关，只报错', async () => {
    listMock
      .mockResolvedValueOnce(listed('/home/u'))
      .mockResolvedValueOnce(failed('目录不存在：/gone', '/gone'))
    renderModal('/home/u')
    const input = draftInput()
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    fireEvent.change(input, { target: { value: '/gone' } })
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }))

    expect(await screen.findByText('目录不存在：/gone')).toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('已确认的目录直接点选 → onPick(该目录) 且不额外发包', async () => {
    listMock.mockResolvedValue(listed('/home/u', { src: '/home/u/src' }))
    renderModal('/home/u')
    await screen.findByRole('button', { name: 'src' })

    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }))

    expect(onPick).toHaveBeenCalledWith('/home/u')
    expect(onClose).toHaveBeenCalled()
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('新建文件夹：按当前目录建、建好直接进入新目录', async () => {
    listMock
      .mockResolvedValueOnce(listed('/home/u'))
      .mockResolvedValueOnce(listed('/home/u/proj', {}, '/home/u'))
    createMock.mockResolvedValue({ ok: true, path: '/home/u/proj' })
    const { container } = renderModal('/home/u')
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    const nameBox = screen.getByPlaceholderText('新文件夹名称')
    fireEvent.change(nameBox, { target: { value: 'proj' } })
    fireEvent.keyDown(nameBox, { key: 'Enter' })

    await waitFor(() => expect(createMock).toHaveBeenCalledWith('/home/u', 'proj'))
    await waitFor(() => expect(listMock).toHaveBeenNthCalledWith(2, '/home/u/proj'))
    expect(container.textContent).toContain('当前：/home/u/proj')
    expect(screen.queryByPlaceholderText('新文件夹名称')).toBeNull() // 建完收起
  })

  it('新建文件夹：名称带分隔符本地拦下（不发请求），host 报错原样显示', async () => {
    listMock.mockResolvedValueOnce(listed('/home/u'))
    createMock.mockResolvedValue({ ok: false, error: '同名目录或文件已存在：/home/u/proj' })
    renderModal('/home/u')
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    const nameBox = screen.getByPlaceholderText('新文件夹名称')

    fireEvent.change(nameBox, { target: { value: 'a/b' } })
    fireEvent.keyDown(nameBox, { key: 'Enter' })
    expect(await screen.findByText('文件夹名称不能包含路径分隔符')).toBeInTheDocument()
    expect(createMock).not.toHaveBeenCalled()

    fireEvent.change(nameBox, { target: { value: 'proj' } })
    fireEvent.keyDown(nameBox, { key: 'Enter' })
    expect(await screen.findByText(/已存在/)).toBeInTheDocument()
    expect(createMock).toHaveBeenCalledWith('/home/u', 'proj')
    // 失败不进新目录、输入行留着让用户改名
    expect(screen.getByPlaceholderText('新文件夹名称')).toBeInTheDocument()
  })

  it('目录未确认（初始加载失败）→ 不能在其下新建文件夹', async () => {
    listMock.mockResolvedValue(failed('目录不存在：/home/gone', '/home/gone'))
    renderModal('/home/gone')

    expect(await screen.findByText('目录不存在：/home/gone')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建文件夹' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '选择此目录' })).toBeDisabled()
  })

  it('新建输入行展开时 Esc 只收起这一行，不关弹窗', async () => {
    listMock.mockResolvedValue(listed('/home/u', { src: '/home/u/src' }))
    renderModal('/home/u')
    await screen.findByRole('button', { name: 'src' })

    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    expect(screen.getByPlaceholderText('新文件夹名称')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('新文件夹名称')).toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('背景点击 / 取消 / 关闭按钮 → onClose', async () => {
    listMock.mockResolvedValue(listed('/home/u', { src: '/home/u/src' }))
    renderModal('/home/u')
    await screen.findByRole('button', { name: 'src' })

    const dialog = screen.getByRole('dialog', { name: '选择工作目录' })
    fireEvent.mouseDown(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('空目录 / 读取中 各自的状态文案', async () => {
    let resolveList: ((v: ListLocalDirsResult) => void) | undefined
    listMock.mockImplementation(
      () => new Promise<ListLocalDirsResult>((resolve) => { resolveList = resolve }),
    )
    renderModal('/home/u')
    expect(await screen.findByText('读取目录…')).toBeInTheDocument()

    resolveList?.(listed('/home/u'))
    expect(await screen.findByText('此目录没有子目录')).toBeInTheDocument()
  })

  it('非 Error 抛出物也显示成人话', async () => {
    listMock.mockResolvedValue(failed('宿主不支持目录浏览（/api/local/dirs 缺失）—— 需要升级 host'))
    renderModal('/home/u')
    expect(await screen.findByText(/需要升级 host/)).toBeInTheDocument()
  })
})
