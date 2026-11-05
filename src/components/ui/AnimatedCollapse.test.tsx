import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { usePins } from '../../store/historyPins'
import { AnimatedCollapse } from './AnimatedCollapse'

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = window.ResizeObserver ?? (ROStub as unknown as typeof ResizeObserver)

describe('AnimatedCollapse', () => {
  it('高度过渡结束后立刻卸载正文', () => {
    const r = render(
      <AnimatedCollapse open>
        <div>body</div>
      </AnimatedCollapse>,
    )
    expect(screen.getByText('body')).toBeInTheDocument()

    r.rerender(
      <AnimatedCollapse open={false}>
        <div>body</div>
      </AnimatedCollapse>,
    )
    expect(screen.getByText('body')).toBeInTheDocument()

    fireEvent.transitionEnd(r.container.querySelector('.gn-collapse')!, {
      propertyName: 'height',
    })
    expect(screen.queryByText('body')).not.toBeInTheDocument()
  })

  it('uiMotion 关闭时收起立即卸载正文', () => {
    const prev = usePins.getState().fePrefs
    usePins.setState({ fePrefs: { ...prev, uiMotion: false } })
    try {
      const r = render(
        <AnimatedCollapse open>
          <div>body</div>
        </AnimatedCollapse>,
      )
      expect(screen.getByText('body')).toBeInTheDocument()

      r.rerender(
        <AnimatedCollapse open={false}>
          <div>body</div>
        </AnimatedCollapse>,
      )
      expect(screen.queryByText('body')).not.toBeInTheDocument()
    } finally {
      usePins.setState({ fePrefs: prev })
    }
  })

  it('收起态不挂载正文，展开后才出现', () => {
    const r = render(
      <AnimatedCollapse open={false}>
        <div>body</div>
      </AnimatedCollapse>,
    )
    expect(screen.queryByText('body')).not.toBeInTheDocument()

    r.rerender(
      <AnimatedCollapse open>
        <div>body</div>
      </AnimatedCollapse>,
    )
    expect(screen.getByText('body')).toBeInTheDocument()
  })
})
