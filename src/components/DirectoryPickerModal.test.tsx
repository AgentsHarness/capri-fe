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