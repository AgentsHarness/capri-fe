import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useModeMenu } from './useModeMenu'
import { useChatStore } from '../../store/chat'

beforeEach(() => {
  useChatStore.setState({
    planMode: false,
    permissionMode: undefined,
    yoloMode: false,
    autoMode: false,
  })
})

/**
 * 底栏要两种写法：完整名（宽裕时显示，与 TUI 的 always-approve 一致）和
 * 短名（实测放不下时退回）。两者的选取归 composer/useFittedModeLabel.ts，
 * 这里只管名字本身对得上。
 */
describe('useModeMenu 模式标签', () => {
  const labels = () => {
    const { currentModeLabel, currentModeShortLabel } = renderHook(() =>
      useModeMenu(),
    ).result.current
    return `${currentModeLabel}|${currentModeShortLabel}`
  }

  it('always-approve（permissionMode 声明）', () => {
    useChatStore.setState({ permissionMode: 'always-approve' })
    expect(labels()).toBe('always-approve|always')
  })

  it('always-approve（仅 yoloMode 置位）同样给两种写法', () => {
    useChatStore.setState({ yoloMode: true })
    expect(labels()).toBe('always-approve|always')
  })

  it('auto / normal 两种写法相同，不会被缩写', () => {
    useChatStore.setState({ permissionMode: 'auto' })
    expect(labels()).toBe('auto|auto')
    useChatStore.setState({ permissionMode: undefined, autoMode: false })
    expect(labels()).toBe('normal|normal')
  })

  it('plan 叠加：完整名 plan·always-approve，短名 plan·always', () => {
    useChatStore.setState({ planMode: true, permissionMode: 'always-approve' })
    expect(labels()).toBe('plan·always-approve|plan·always')
    useChatStore.setState({ planMode: true, permissionMode: 'auto' })
    expect(labels()).toBe('plan·auto|plan·auto')
  })

  it('plan + 无附加权限：两种写法都是 plan', () => {
    useChatStore.setState({ planMode: true, permissionMode: undefined })
    expect(labels()).toBe('plan|plan')
  })
})
