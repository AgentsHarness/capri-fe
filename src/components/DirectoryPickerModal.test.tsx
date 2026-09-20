import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { runShellCommand } from '../api/shell'
import { DirectoryPickerModal } from './DirectoryPickerModal'

vi.mock('../api/shell', () => ({
  runShellCommand: vi.fn(),
}))

const shellMock = vi.mocked(runShellCommand)

const onClose = vi.fn()
const onPick = vi.fn()

function okResult(stdout: string) {
  return { ok: true as const, exitCode: 0, stdout }
}

beforeEach(() => {
  shellMock.mockReset()
  onClose.mockReset()
  onPick.mockReset()
})

function renderModal(initial?: string) {
  return render(
    <DirectoryPickerModal open initial={initial} onClose={onClose} onPick={onPick} />,
  )
}

describe('DirectoryPickerModal', () => {
  it('未打开 → 不渲染', () => {
    const { container } = render(
      <DirectoryPickerModal open={false} onClose={onClose} onPick={onPick} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('打开 + initial → 列出直接子目录（./ 前缀剥离、. 过滤、排序）', async () => {
    shellMock.mockResolvedValue(okResult('./zeta\n.\n./alpha\n./mid'))
    renderModal('/home/u')
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    const rows = screen.getAllByRole('button')
    const names = rows
      .map((r) => r.textContent)
      .filter((t) => t !== undefined && t.includes('▸'))
    expect(names).toEqual(['▸alpha', '▸mid', '▸zeta'])
    expect(shellMock).toHaveBeenCalledWith('find . -maxdepth 1 -type d', '/home/u')
  })

  it('无 initial → 先 echo $PWD 再加载', async () => {
    shellMock.mockResolvedValueOnce(okResult('/echoed'))
    shellMock.mockResolvedValueOnce(okResult('./src'))
    renderModal()
    await screen.findByText('src')
    expect(shellMock).toHaveBeenNthCalledWith(1, 'echo "$PWD"')
    expect(shellMock).toHaveBeenNthCalledWith(2, 'find . -maxdepth 1 -type d', '/echoed')
  })

  it('点击目录进入子目录', async () => {
    shellMock.mockResolvedValueOnce(okResult('./src'))
    shellMock.mockResolvedValueOnce(okResult('./a\n./b'))
    renderModal('/home/u')
    fireEvent.click(await screen.findByText('src'))
    await waitFor(() =>
      expect(shellMock).toHaveBeenNthCalledWith(2, 'find . -maxdepth 1 -type d', '/home/u/src'),
    )
    expect(await screen.findByText('a')).toBeInTheDocument()
  })

  it('↑ 上级 → 返回父目录', async () => {
    shellMock.mockResolvedValueOnce(okResult('./sub'))
    shellMock.mockResolvedValueOnce(okResult('./x'))
    renderModal('/home/u')
    await screen.findByText('sub')
    fireEvent.click(screen.getByRole('button', { name: /上级/ }))
    await waitFor(() =>
      expect(shellMock).toHaveBeenNthCalledWith(2, 'find . -maxdepth 1 -type d', '/home'),
    )
    expect(await screen.findByText('x')).toBeInTheDocument()
  })

  it('根目录 → 上级按钮禁用', async () => {
    shellMock.mockResolvedValue(okResult('./etc'))
    renderModal('/')
    await screen.findByText('etc')
    expect(screen.getByRole('button', { name: /上级/ })).toBeDisabled()
  })

  it('手改路径 + Enter → 跳转；相同路径不重复跳转；输入法组字 Enter 放行', async () => {
    shellMock.mockResolvedValueOnce(okResult('./src'))
    shellMock.mockResolvedValueOnce(okResult('./lib'))
    renderModal('/home/u')
    const input = (await screen.findByPlaceholderText('路径或 ~（回车跳转）')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '/home/u/lib' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(shellMock).toHaveBeenNthCalledWith(2, 'find . -maxdepth 1 -type d', '/home/u/lib'),
    )

    // 输入法组字中的 Enter → 不跳转（真实 KeyboardEvent 才能带 isComposing）
    const ime = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })
    input.dispatchEvent(ime)
    expect(shellMock).toHaveBeenCalledTimes(2)

    // 相同路径 → 不触发
    fireEvent.change(input, { target: { value: '/home/u/lib' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(shellMock).toHaveBeenCalledTimes(2)
  })

  it('选择此目录 → onPick(当前路径) + onClose', async () => {
    shellMock.mockResolvedValue(okResult('./src'))
    renderModal('/home/u')
    await screen.findByText('src')
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }))
    expect(onPick).toHaveBeenCalledWith('/home/u')
    expect(onClose).toHaveBeenCalled()
  })

  it('手改路径后选择 → 用 draft 值', async () => {
    shellMock.mockResolvedValue(okResult('./src'))
    renderModal('/home/u')
    const input = await screen.findByPlaceholderText('路径或 ~（回车跳转）')
    fireEvent.change(input, { target: { value: '/other' } })
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }))
    expect(onPick).toHaveBeenCalledWith('/other')
  })

  it('exitCode≠0 → 错误 + 重试', async () => {
    shellMock.mockRejectedValueOnce(new Error('denied'))
    shellMock.mockResolvedValueOnce(okResult('./retry-ok'))
    renderModal('/home/u')
    expect(await screen.findByText('denied')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('retry-ok')).toBeInTheDocument()
  })

  it('ok=false 且带 error → 直接用 error 文案', async () => {
    shellMock.mockResolvedValue({ ok: false, error: '权限不足' })
    renderModal('/root/secret')
    expect(await screen.findByText('权限不足')).toBeInTheDocument()
  })

  it('ok=false 且无 error → 回落到「无法列出目录」', async () => {
    shellMock.mockResolvedValue({ ok: false })
    renderModal('/home/u')
    expect(await screen.findByText('无法列出目录')).toBeInTheDocument()
  })

  it('exitCode≠0 且有 stderr → 用 stderr 文案', async () => {
    shellMock.mockResolvedValue({
      ok: true,
      exitCode: 1,
      stdout: '',
      stderr: 'No such file or directory\n',
    })
    renderModal('/nope')
    expect(await screen.findByText('No such file or directory')).toBeInTheDocument()
  })

  it('exitCode≠0 且 stderr 为空 → 回落到「无法读取目录：<路径>」', async () => {
    shellMock.mockResolvedValue({ ok: true, exitCode: 2, stdout: '', stderr: '   ' })
    renderModal('/nope')
    expect(await screen.findByText('无法读取目录：/nope')).toBeInTheDocument()
  })

  it('失败后子目录列表被清空（不留上一次的残留）', async () => {
    shellMock.mockResolvedValueOnce(okResult('./kept'))
    renderModal('/home/u')
    await screen.findByText('kept')
    // 手改进一个不存在的路径 → 报错，旧列表必须消失
    shellMock.mockResolvedValueOnce({ ok: true, exitCode: 1, stdout: '', stderr: 'boom' })
    const input = screen.getByPlaceholderText('路径或 ~（回车跳转）')
    fireEvent.change(input, { target: { value: '/gone' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.queryByText('kept')).toBeNull()
  })

  it('echo $PWD 失败（ok=false）→ 起始目录回落到 /', async () => {
    shellMock.mockResolvedValueOnce({ ok: false })
    shellMock.mockResolvedValueOnce(okResult('./from-root'))
    renderModal()
    expect(await screen.findByText('from-root')).toBeInTheDocument()
    expect(shellMock.mock.calls[1][1]).toBe('/')
  })

  it('echo $PWD 成功但 stdout 为空 → 同样回落到 /', async () => {
    shellMock.mockResolvedValueOnce({ ok: true, exitCode: 0, stdout: '   ' })
    shellMock.mockResolvedValueOnce(okResult('./from-root'))
    renderModal()
    await screen.findByText('from-root')
    expect(shellMock.mock.calls[1][1]).toBe('/')
  })

  it('echo $PWD 本身抛错 → 显示该错误', async () => {
    shellMock.mockRejectedValueOnce(new Error('shell unavailable'))
    renderModal()
    expect(await screen.findByText('shell unavailable')).toBeInTheDocument()
  })

  it('非 Error 抛出物转成字符串展示', async () => {
    shellMock.mockRejectedValueOnce('plain failure')
    renderModal('/home/u')
    expect(await screen.findByText('plain failure')).toBeInTheDocument()
  })

  it('打开时 initial 为纯空白 → 走 echo $PWD 分支', async () => {
    shellMock.mockResolvedValueOnce(okResult('/detected'))
    shellMock.mockResolvedValueOnce(okResult('./sub'))
    renderModal('   ')
    await screen.findByText('sub')
    expect(shellMock.mock.calls[0][0]).toContain('$PWD')
  })

  it('文件项（不以 ./ 开头）也被列成条目', async () => {
    shellMock.mockResolvedValue(okResult('bare-entry\n./prefixed'))
    renderModal('/home/u')
    expect(await screen.findByText('bare-entry')).toBeInTheDocument()
    expect(screen.getByText('prefixed')).toBeInTheDocument()
  })

  it('根目录下进入子目录仍能拼出 // 之外的合法路径不重复父级', async () => {
    shellMock.mockResolvedValue(okResult('./a'))
    renderModal('/')
    await screen.findByText('a')
    fireEvent.click(screen.getByText('a'))
    expect(shellMock).toHaveBeenLastCalledWith('find . -maxdepth 1 -type d', '/a')
  })

  it('无子目录 → 空提示', async () => {
    shellMock.mockResolvedValue(okResult('.'))
    renderModal('/home/u')
    expect(await screen.findByText('此目录没有子目录')).toBeInTheDocument()
  })

  it('Esc / 背景点击 / esc 按钮 → onClose', async () => {
    shellMock.mockResolvedValue(okResult('./src'))
    renderModal('/home/u')
    await screen.findByText('src')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const dialog = screen.getByRole('dialog', { name: '选择工作目录' })
    fireEvent.mouseDown(dialog)
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})