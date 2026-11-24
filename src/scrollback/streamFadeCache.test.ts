// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearStreamFade,
  peekStreamFade,
  rememberStreamFade,
  resetStreamFadeCache,
  STREAM_FADE_CACHE_TTL_MS,
} from './streamFadeCache'
import { EMPTY_STREAM_TEXT_VIEW, type StreamTextView } from './streamTextFade'

const view = (source: string): StreamTextView => ({
  ...EMPTY_STREAM_TEXT_VIEW,
  source,
})

beforeEach(() => resetStreamFadeCache())

describe('streamFadeCache', () => {
  it('同 key 读取最近一次视图；过期后不再接手', () => {
    rememberStreamFade('a', view('one'), 1000)
    expect(peekStreamFade('a', 1100)?.source).toBe('one')

    expect(peekStreamFade('a', 1000 + STREAM_FADE_CACHE_TTL_MS + 1)).toBe(
      undefined,
    )
    // 过期条目已被清掉。
    expect(peekStreamFade('a', 1100)).toBe(undefined)
  })

  it('clear 只影响指定 key', () => {
    rememberStreamFade('a', view('one'), 1000)
    rememberStreamFade('b', view('two'), 1000)
    clearStreamFade('a')
    expect(peekStreamFade('a', 1000)).toBe(undefined)
    expect(peekStreamFade('b', 1000)?.source).toBe('two')
  })

  it('容量上限：最旧条目先被淘汰', () => {
    for (let i = 0; i < 9; i++) {
      rememberStreamFade(`k${i}`, view(`v${i}`), 1000 + i)
    }
    expect(peekStreamFade('k0', 1100)).toBe(undefined)
    expect(peekStreamFade('k8', 1100)?.source).toBe('v8')
  })
})
