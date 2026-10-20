import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { InlineAction } from './InlineAction'

/**
 * 行内动作的统一约定：`[label]` 纯文本、无外边框、hover 圆角底色，
 * 点击不冒泡到行（行级 onSelect 会弹块查看器）。
 */
function renderAction(props: Parameters<typeof InlineAction>[0]) {
  render(<InlineAction {...props} />)
  return screen.getByRole('button')
}

describe('InlineAction', () => {
  it('渲染成 [label] 纯文本，无外边框，hover 圆角底色', () => {
    const btn = renderAction({ label: 'kill', onRun: () => {} })
    expect(btn.textContent).toBe('[kill]')
    expect(btn.className).not.toMatch(/border/)
    expect(btn.className).toMatch(/rounded/)
    expect(btn.className).toMatch(/hover:bg-/)
  })

  it('中文 label 同样套方括号', () => {
    expect(renderAction({ label: '暂停', onRun: () => {} }).textContent).toBe(
      '[暂停]',
    )
  })

  it('点击触发 onRun，并阻止冒泡到所在行', () => {
    const onRun = vi.fn()
    const onRowClick = vi.fn()
    render(
      <div onClick={onRowClick}>
        <InlineAction label="cancel" onRun={onRun} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('disabled 时不触发 onRun', () => {
    const onRun = vi.fn()
    const btn = renderAction({ label: '重启', onRun, disabled: true })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onRun).not.toHaveBeenCalled()
  })

  it('tone 决定配色：danger 红、neutral 常规、plan 计划色', () => {
    const clsOf = (tone?: 'danger' | 'neutral' | 'plan') => {
      const { container, unmount } = render(
        <InlineAction label="x" onRun={() => {}} tone={tone} />,
      )
      const cls = container.querySelector('button')!.className
      unmount()
      return cls
    }
    expect(clsOf()).toContain('text-gn-red/80')
    expect(clsOf('neutral')).toContain('text-gn-fg2')
    expect(clsOf('plan')).toContain('text-gn-plan')
  })
})
