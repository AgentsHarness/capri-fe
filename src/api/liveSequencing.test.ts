import { describe, expect, it, vi } from 'vitest'
import { EventSequencer, LIVE_INTERRUPT_GAP, type SequencedEvent } from './liveSequencing'

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

  it('seedFromLive：全新订阅者以首条事件为起点，不 after=0 回补整段缓冲', async () => {
    const { seq, emitted, pull } = makeSeq()
    seq.seedFromLive('h')
    seq.accept(ev(114020), GEN)
    await flush()
    expect(emitted.map((e) => e.seq)).toEqual([114020])
    expect(pull).not.toHaveBeenCalled()
    // 水位已对齐：之前的历史事件不再冒出来
    seq.accept(ev(5), GEN)
    expect(emitted.map((e) => e.seq)).toEqual([114020])
  })

  it('seedFromLive 是一次性的：对齐后真缺口照常补拉', async () => {
    const { seq, emitted, pull } = makeSeq(async () => [ev(114022)])
    seq.seedFromLive('h')
    seq.accept(ev(114021), GEN)
    expect(emitted.map((e) => e.seq)).toEqual([114021])
    // 跳过 114022 → 下一帧 114023 造成真缺口
    seq.accept(ev(114023), GEN)
    await flush()
    expect(pull).toHaveBeenCalledWith('h', 114021, expect.any(AbortSignal))
    expect(emitted.map((e) => e.seq)).toEqual([114021, 114022, 114023])
  })

  it('reset 清掉未消费的 seedFromLive 标记', async () => {
    const { seq, emitted, pull } = makeSeq()
    seq.seedFromLive('h')
    seq.reset()
    // 小洞仍走补拉（大 seq 会当直播中断直接放行，测不出标记被清）
    seq.accept(ev(2), GEN)
    await flush()
    expect(emitted).toEqual([])
    expect(pull).toHaveBeenCalledWith('h', 0, expect.any(AbortSignal))
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
    // 缺 seq 1，灌入 2..130（129 条 > 上限 128）
    for (let s = 2; s <= 130; s++) seq.accept(ev(s), GEN)
    expect(emitted[0]).toMatchObject({ type: 'live_gap', fromSeq: 1, toSeq: 1 })
    expect(emitted.filter((e) => e.type !== 'live_gap').map((e) => e.seq)).toEqual(
      Array.from({ length: 129 }, (_, i) => i + 2),
    )
  })

  it('直播中断（大洞）：先放出正在到来的连续段，不补拉已压掉的前驱', async () => {
    const { seq, emitted, pull } = makeSeq()
    seq.resetHost('h', 100)
    const start = 100 + LIVE_INTERRUPT_GAP + 1
    seq.accept(ev(start), GEN)
    await flush()
    expect(emitted[0]).toMatchObject({
      type: 'live_gap',
      hostId: 'h',
      fromSeq: 101,
      toSeq: start - 1,
    })
    expect(emitted.map((e) => e.seq).filter((s) => s != null)).toEqual([start])
    expect(pull).not.toHaveBeenCalled()
    expect(seq.watermark('h')).toBe(start)
  })

  it('直播中断后后续序号连续放出，洞里的旧事件不再插入 live', async () => {
    const { seq, emitted } = makeSeq()
    seq.resetHost('h', 100)
    const start = 100 + LIVE_INTERRUPT_GAP + 1
    seq.accept(ev(start), GEN)
    seq.accept(ev(start + 1), GEN)
    seq.accept(ev(start + 2), GEN)
    expect(emitted.filter((e) => e.type !== 'live_gap').map((e) => e.seq)).toEqual([
      start,
      start + 1,
      start + 2,
    ])
    seq.accept(ev(101), GEN)
    expect(emitted.filter((e) => e.type !== 'live_gap').map((e) => e.seq)).toEqual([
      start,
      start + 1,
      start + 2,
    ])
  })

  it('小洞仍补拉，不提前放行', async () => {
    const { seq, emitted, pull } = makeSeq(async () => [ev(101)])
    seq.resetHost('h', 100)
    seq.accept(ev(102), GEN)
    await flush()
    expect(pull).toHaveBeenCalledWith('h', 100, expect.any(AbortSignal))
    expect(emitted.map((e) => e.seq)).toEqual([101, 102])
  })

  it('补拉未带回前驱且洞仍小：继续等，不误跳', async () => {
    const { seq, emitted, pull } = makeSeq(async () => [ev(105)])
    seq.resetHost('h', 100)
    seq.accept(ev(102), GEN)
    await flush()
    expect(pull).toHaveBeenCalledWith('h', 100, expect.any(AbortSignal))
    expect(emitted).toEqual([])
    seq.accept(ev(101), GEN)
    expect(emitted.map((e) => e.seq)).toEqual([101, 102])
  })
})
