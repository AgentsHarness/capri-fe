import { afterEach, describe, expect, it } from 'vitest'
import { describeUserAgent, fmtConnectedFor } from './subscriberFormat'

/**
 * 订阅者面板的展示换算。这两个函数决定面板上「设备」和「已连接」两列
 * 显示什么：UA 认错会把手机当成桌面，时长算错会把刚打开的说成几小时前。
 */
describe('describeUserAgent', () => {
  it('认出常见浏览器 + 系统组合', () => {
    const chromeMac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    expect(describeUserAgent(chromeMac)).toBe('Chrome · macOS')
    const safariIphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    expect(describeUserAgent(safariIphone)).toBe('Safari · iOS')
    const edgeWindows =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
    expect(describeUserAgent(edgeWindows)).toBe('Edge · Windows')
  })

  it('Chromium 系先认具体内核（Chrome UA 里也含 Safari 字样）', () => {
    const chromeAndroid =
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
    expect(describeUserAgent(chromeAndroid)).toBe('Chrome · Android')
  })

  it('认不出时原样截断，缺 UA 时给占位', () => {
    expect(describeUserAgent(undefined)).toBe('未知浏览器')
    expect(describeUserAgent('')).toBe('未知浏览器')
    expect(describeUserAgent('CapriTest/1.0')).toBe('Capri')
    const long = 'x'.repeat(80)
    expect(describeUserAgent(long)).toBe(`${'x'.repeat(40)}…`)
  })
})

describe('fmtConnectedFor', () => {
  afterEach(() => {})

  it('按分钟/小时分档', () => {
    expect(fmtConnectedFor(0)).toBe('刚刚')
    expect(fmtConnectedFor(59_000)).toBe('刚刚')
    expect(fmtConnectedFor(60_000)).toBe('1 分钟')
    expect(fmtConnectedFor(59 * 60_000)).toBe('59 分钟')
    expect(fmtConnectedFor(60 * 60_000)).toBe('1 小时')
    expect(fmtConnectedFor(61 * 60_000)).toBe('1 小时 1 分')
    expect(fmtConnectedFor(125 * 60_000)).toBe('2 小时 5 分')
  })

  it('未来时间戳（时钟偏差）给占位而不是负数', () => {
    expect(fmtConnectedFor(-5)).toBe('—')
    expect(fmtConnectedFor(Number.NaN)).toBe('—')
  })
})
