import { describe, expect, it, vi } from 'vitest'
import { EventSequencer, type SequencedEvent } from './liveSequencing'

const GEN = 1

function makeSeq(
  pullImpl: (hostId: string, after: number) => Promise<SequencedEvent[] | null> = async () => [],
) {
  const emitted: SequencedEvent[] = []
  const pull = vi.fn(async (hostId: string, after: number) => pullImpl(hostId, after))
  const seq = new EventSequencer(
    (ev) => emitted.push(ev),
    pull,
    (gen) => gen === GEN,
  )
  return { seq, emitted, pull }
}

const ev = (seq: number, hostId = 'h'): SequencedEvent =>
  ({ type: 'chunk', hostId, seq }) as SequencedEvent

/** 等待 gapPull 的 fire-and-forget 微任务链走完。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('EventSequencer', () => {
  it('无 hostId/seq（含 seq≤0）的事件原样透传', () => {
    const { seq, emitted } = makeSeq()
    const flat = { type: 'hosts_changed' } as SequencedEvent
    seq.accept(flat, GEN)
    const zero = ev(0)
    seq.accept(zero, GEN)
    expect(emitted).toEqual([flat, zero])
  })

  it('乱序缓冲：前驱到达后按序放出', () => {
    const { seq, emitted } = makeSeq()
    seq.accept(ev(3), GEN)
    seq.accept(ev(2), GEN)
    expect(emitted).toEqual([])
    seq.accept(ev(1), GEN)
    expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('重复 seq 事件丢弃', () => {
    const { seq, emitted } = makeSeq()
    seq.accept(ev(1), GEN)
    seq.accept(ev(1), GEN)
    expect(emitted.map((e) => e.seq)).toEqual([1])
  })

  it('缺口触发补拉，补拉结果按序合并', async () => {
    // seq 2 缺失：收到 3 时触发 after=1 的补拉？不——水位 0，缺口是 1..2，
    // 补拉 after=0。补拉返回 [2]（1 仍缺）→ 放不出；live 送达 1 后 1..3 全出。
    const { seq, emitted, pull } = makeSeq(async () => [ev(2)])
    seq.accept(ev(3), GEN)
    await flush()
    expect(pull).toHaveBeenCalledWith('h', 0, expect.any(AbortSignal))
    expect(emitted).toEqual([])
    seq.accept(ev(1), GEN)
    expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('同 host 并发补拉去重', async () => {
    let release!: (v: SequencedEvent[]) => void
    const { seq, pull } = makeSeq(
      () => new Promise<SequencedEvent[]>((r) => (release = r)),
    )
    seq.accept(ev(3), GEN)
    await flush()
    seq.accept(ev(4), GEN)
    await flush()
    expect(pull).toHaveBeenCalledTimes(1)
    release([ev(1), ev(2)])
    await flush()
  })

  it('stopGapPulls 作废在途补拉的响应', async () => {
    let release!: (v: SequencedEvent[]) => void
    const { seq, emitted } = makeSeq(
      () => new Promise<SequencedEvent[]>((r) => (release = r)),
    )
    seq.accept(ev(2), GEN)
    await flush()
    seq.stopGapPulls()
    release([ev(1)])
    await flush()
    expect(emitted).toEqual([])
  })

  it('生成守卫：换代后 accept 与补拉结果全部失效', async () => {
    let gen = GEN
    let release!: (v: SequencedEvent[]) => void
    const emitted: SequencedEvent[] = []
    const pull = vi.fn(
      async () => new Promise<SequencedEvent[]>((r) => (release = r)),
    )
    const seq = new EventSequencer(
      (ev) => emitted.push(ev),
      pull,
      (g) => g === gen,
    )
    seq.accept(ev(2), gen + 1) // 旧代事件
    expect(emitted).toEqual([])
    seq.accept(ev(2), gen) // 当前代：触发补拉
    await flush()
    expect(pull).toHaveBeenCalledTimes(1)
    gen = gen + 1 // 换代（connect/disconnect）
    release([ev(1)])
    await flush()
    expect(emitted).toEqual([]) // 响应作废
  })

  it('resync：停补拉 + 水位只前进不回退', () => {
    const { seq, emitted } = makeSeq()
    seq.accept(ev(2), GEN)
    seq.resync('h', 5)
    expect(seq.watermark('h')).toBe(4)
    seq.resync('h', 3) // 回退请求被忽略
    expect(seq.watermark('h')).toBe(4)
    // resync 后 accept(5) 直接放出（水位已到 4）
    seq.accept(ev(5), GEN)
    expect(emitted.map((e) => e.seq)).toEqual([5])
  })

  it('resetHost：水位对齐权威值并清除陈旧 pending', () => {
    const { seq, emitted } = makeSeq()
    seq.accept(ev(7), GEN)
    seq.accept(ev(9), GEN)
    seq.resetHost('h', 8) // host 重启，权威水位 8
    expect(seq.watermark('h')).toBe(8)
    seq.accept(ev(9), GEN) // 陈旧 pending 已清，重新送达
    expect(emitted.map((e) => e.seq)).toEqual([9])
  })

  it('pending 超上限：推水位放出已有事件（认赔不憋死）', () => {
    const { seq, emitted } = makeSeq()
    // 缺 seq 1，灌入 2..2002（2001 条 > 上限 2000）
    for (let s = 2; s <= 2002; s++) seq.accept(ev(s), GEN)
    expect(emitted.map((e) => e.seq)).toEqual(
      Array.from({ length: 2001 }, (_, i) => i + 2),
    )
  })
})
