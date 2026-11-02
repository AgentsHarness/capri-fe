import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ScrollEntry } from '../../../api/types'
import type { EntryChrome } from '../chrome'
import { UserEntry } from './UserEntry'

function makeChrome(
  e: ScrollEntry,
  selected = false,
  hovered = false,
): EntryChrome {
  return {
    shell: {
      e,
      selected,
      hovered,
      onHover: () => {},
      onSelect: () => {},
      pendingFreeze: false,
      now: 0,
      dense: false,
      denseNext: false,
      densePrev: false,
      inGroup: false,
    },
    bullet: { color: '#000' },
    caret: null,
    bulletGlyph: undefined,
    rowBtn: '',
    openViewer: vi.fn(),
    toggleTool: () => {},
    toggleThought: () => {},
    toggleUser: () => {},
    toggleBtw: () => {},
    cancelSubagent: () => {},
    killTask: () => {},
    liveText: undefined,
    thoughtText: undefined,
    bodyRef: { current: null },
    inMini: false,
  }
}

describe('UserEntry', () => {
  it('渲染标准用户消息', () => {
    const e: Extract<ScrollEntry, { kind: 'user' }> = {
      id: 'u1',
      kind: 'user',
      text: '普通问题',
    }
    render(<UserEntry e={e} chrome={makeChrome(e)} />)
    expect(screen.getByText('普通问题')).toBeTruthy()
    expect(screen.queryByText('引导')).toBeNull()
  })

  it('渲染带 isInterjection: true 的插话消息（显示引导徽标）', () => {
    const e: Extract<ScrollEntry, { kind: 'user' }> = {
      id: 'u2',
      kind: 'user',
      text: '提交完了就部署fe',
      isInterjection: true,
    }
    render(<UserEntry e={e} chrome={makeChrome(e)} />)
    expect(screen.getByText('提交完了就部署fe')).toBeTruthy()
    expect(screen.getByText('引导')).toBeTruthy()
    const button = screen.getByRole('button')
    expect(button.getAttribute('title')).toContain('引导 (steer)')
  })

  it('未送达的用户行带重试按钮，普通行没有', () => {
    const undelivered: Extract<ScrollEntry, { kind: 'user' }> = {
      id: 'u3',
      kind: 'user',
      text: '没发出去的那条',
      undelivered: true,
    }
    const { unmount } = render(
      <UserEntry e={undelivered} chrome={makeChrome(undelivered)} />,
    )
    expect(screen.getByText('[重试]')).toBeTruthy()
    unmount()

    const normal: Extract<ScrollEntry, { kind: 'user' }> = {
      id: 'u4',
      kind: 'user',
      text: '正常的那条',
    }
    render(<UserEntry e={normal} chrome={makeChrome(normal)} />)
    expect(screen.queryByText('[重试]')).toBeNull()
  })

  it('访客只读视图不渲染重试按钮', () => {
    const e: Extract<ScrollEntry, { kind: 'user' }> = {
      id: 'u5',
      kind: 'user',
      text: '只读会话',
      undelivered: true,
    }
    render(
      <UserEntry e={e} chrome={{ ...makeChrome(e), readonly: true }} />,
    )
    expect(screen.queryByText('[重试]')).toBeNull()
  })
})
