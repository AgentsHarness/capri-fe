import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SessionStateIcon } from './SessionStateIcon'
import { SPINNER_FRAMES } from '../theme/glyphs'

describe('SessionStateIcon', () => {
  it('active + 非 pending → braille spinner 帧', () => {
    const { container } = render(<SessionStateIcon state="active" pending={false} spinnerFrame={0} />)
    expect(container.textContent).toBe(SPINNER_FRAMES[0])
  })

  it('pending → 实心菱形（主动画图标）', () => {
    const { container } = render(<SessionStateIcon state="idle" pending spinnerFrame={0} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('idle → 空心菱形', () => {
    const { container } = render(<SessionStateIcon state="idle" pending={false} spinnerFrame={1} />)
    expect(container.querySelector('svg path')).not.toBeNull()
  })
})