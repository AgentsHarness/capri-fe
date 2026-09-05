import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { UsageInfoTabs } from './UsageInfoTabs'

beforeEach(() => {
  useChatStore.setState({
    contextOpen: false,
    sessionInfoOpen: false,
    sessionUsageOpen: false,
    usageOpen: false,
  })
})

describe('UsageInfoTabs', () => {
  it('渲染三个 tab，当前 tab 为选中态', () => {
    render(<UsageInfoTabs active="context" />)
    expect(screen.getByRole('tab', { name: 'Context usage' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: 'Session usage' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    expect(screen.getByRole('tab', { name: 'Session info' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  it('切 tab 互斥：只开目标弹窗，不动宿主聚合 usageOpen', () => {
    useChatStore.setState({ contextOpen: true, usageOpen: true })
    render(<UsageInfoTabs active="context" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Session usage' }))
    const s = useChatStore.getState()
    expect(s.sessionUsageOpen).toBe(true)
    expect(s.contextOpen).toBe(false)
    expect(s.sessionInfoOpen).toBe(false)
    expect(s.usageOpen).toBe(true)
  })

  it('点当前 tab 不重复打开', () => {
    useChatStore.setState({ sessionInfoOpen: true })
    render(<UsageInfoTabs active="session-info" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Session info' }))
    expect(useChatStore.getState().sessionInfoOpen).toBe(true)
    expect(useChatStore.getState().contextOpen).toBe(false)
    expect(useChatStore.getState().sessionUsageOpen).toBe(false)
  })
})
