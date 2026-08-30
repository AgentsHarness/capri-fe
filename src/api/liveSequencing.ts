import type { AcpEvent } from './types'

export type SequencedEvent = AcpEvent & { hostId?: string; seq?: number }

/**
 * 每个 host 的乱序等待缓冲上限。超限即认赔（推进水位放出已有事件），
 * 防止一个补不回来的缺口把 live 通道永久憋死并无界占用内存。
 */
const PENDING_SEQ_CAP = 2000

/**
 * Per-host ordered event delivery with gap recovery.
 *
 * hub 为每个 host 的事件标注单调 seq；本引擎维护每 host 的水位
 * （lastSeq = 已按序放出的最大 seq），乱序到达的事件先入 pendingSeq
 * 等待前驱，发现缺口时经 `pull` 回调向 hub 缓冲补拉（同 host 去重、
 * 并发只有一个在飞）。两道防线防止通道被永久憋死：
 * - gapPullEpoch：每次 stopGapPulls 前进，旧 epoch 的补拉响应整包作废
 *   （resync 刚退休的事件不允许再投递）；
 * - PENDING_SEQ_CAP：缺口补不回来时推水位放出已有事件（丢几条远好过
 *   全部出不来）。
 *
 * 生成守卫（isCurrentGen）由宿主 transport 注入：connect/disconnect
 * 换代后，旧代回调（onopen / 补拉 / 定时器）全部失效。
 */
export class EventSequencer {
  /** Last event seq seen per host (the highest contiguous seq emitted). */
  private lastSeq = new Map<string, number>()
  /** Sequenced live/pulled events waiting for the missing predecessor. */
  private pendingSeq = new Map<string, Map<number, SequencedEvent>>()
  /** In-flight gap pulls per host (dedupe). */
  private pulling = new Map<string, Promise<void>>()
  /**
   * Abort controllers of in-flight gap pulls. A resync must stop the
   * per-hole pulls without killing unrelated host-level requests.
   */
  private gapPullAborts = new Set<AbortController>()
  /**
   * Bumped on every resync (and sequencing reset). Gap-pull responses
   * fetched under an older epoch are discarded — an already-resolved fetch
   * must not re-deliver the very events the resync just retired.
   */
  private gapPullEpoch = 0
  /** seedFromLive 待消费的 host（见 accept 的首条事件对齐）。 */
  private liveSeedOnly = new Set<string>()

  private emit: (ev: AcpEvent) => void
  /** Fetch the hub's buffered events for `hostId` after seq `after`; null = pull failed. */
  private pull: (
    hostId: string,
    after: number,
    signal: AbortSignal,
  ) => Promise<SequencedEvent[] | null>
  private isCurrentGen: (gen: number) => boolean

  constructor(
    emit: (ev: AcpEvent) => void,
    pull: (
      hostId: string,
      after: number,
      signal: AbortSignal,
    ) => Promise<SequencedEvent[] | null>,
    isCurrentGen: (gen: number) => boolean,
  ) {
    this.emit = emit
    this.pull = pull
    this.isCurrentGen = isCurrentGen
  }

  watermark(hostId: string): number {
    return this.lastSeq.get(hostId) ?? 0
  }

  /** Abort every in-flight gap pull and invalidate their results (epoch). */
  stopGapPulls(): void {
    this.gapPullEpoch += 1
    for (const ac of this.gapPullAborts) ac.abort()
    this.gapPullAborts.clear()
  }

  /** 全量重置：作废在途补拉 + 清空全部水位/缓冲（模式切换时）。 */
  reset(): void {
    this.stopGapPulls()
    this.lastSeq.clear()
    this.pendingSeq.clear()
    this.pulling.clear()
    this.liveSeedOnly.clear()
  }

  /**
   * hub resync（慢消费者保护，见 transport handleResyncFrame）：停补拉、
   * 清乱序缓冲，选中 host 的水位前跳到 fromSeq-1——只前进不回退，回退
   * 会让已按序放出的事件重复投递。
   */
  resync(hostId: string | null, fromSeq: number): void {
    this.stopGapPulls()
    this.pendingSeq.clear()
    this.pulling.clear()
    if (hostId && fromSeq > 0) {
      const cur = this.lastSeq.get(hostId) ?? 0
      if (fromSeq - 1 > cur) this.lastSeq.set(hostId, fromSeq - 1)
    }
  }

  /** 序号回退（host 重启）：把该 host 的水位对齐到权威值并丢弃陈旧 pending。 */
  resetHost(hostId: string, seq: number): void {
    this.lastSeq.set(hostId, seq)
    const pending = this.pendingSeq.get(hostId)
    if (pending) {
      for (const k of pending.keys()) {
        if (k <= seq) pending.delete(k)
      }
      if (pending.size === 0) this.pendingSeq.delete(hostId)
    }
  }

  /**
   * 声明"这是全新订阅者"：第一条 live 事件就是起点，之前的历史不补。
   * 用于 transcript 另有来源（loadHistory 从 host 持久化历史重建）的场合
   * ——水位为 0 时按 after=0 补拉会把 hub 缓冲整段当新事件追加到末尾。
   * 一次性标记，被第一条事件消费掉。
   */
  seedFromLive(hostId: string): void {
    this.liveSeedOnly.add(hostId)
  }

  accept(ev: SequencedEvent, gen = 0): void {
    const host = ev.hostId
    const seq = ev.seq
    if (!host || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) {
      this.emit(ev)
      return
    }
    if (!this.isCurrentGen(gen)) return

    const last = this.lastSeq.get(host) ?? 0
    if (seq <= last) return

    if (last === 0 && this.liveSeedOnly.delete(host)) {
      this.lastSeq.set(host, seq - 1)
    }

    let pending = this.pendingSeq.get(host)
    if (!pending) {
      pending = new Map<number, SequencedEvent>()
      this.pendingSeq.set(host, pending)
    }
    // A future event must wait for every predecessor. In particular, seq=8
    // must not advance lastSeq and make the later gap pull discard seq=6/7.
    if (!pending.has(seq)) pending.set(seq, ev)
    // 缺口补不回来时（前驱在 hub 缓冲里已过期 / host 侧永久丢失）pending
    // 会无界增长，最终把整条 live 通道憋死。超过上限就认赔：把水位推到
    // 最小待决序号之前，让 drainSequenced 立刻按序放出已有事件（丢几条
    // 事件远好过之后所有事件都出不来）。
    if (pending.size > PENDING_SEQ_CAP) {
      let firstPending = Infinity
      for (const k of pending.keys()) {
        if (k < firstPending) firstPending = k
      }
      if (Number.isFinite(firstPending)) this.lastSeq.set(host, firstPending - 1)
    }
    this.drainSequenced(host, gen)
    this.ensureGapPull(host, gen)
  }

  async gapPull(hostId: string, after: number, gen = 0): Promise<void> {
    const active = this.pulling.get(hostId)
    if (active) return active
    if (!this.isCurrentGen(gen)) return

    const epoch = this.gapPullEpoch
    const ac = new AbortController()
    this.gapPullAborts.add(ac)
    const pull = this.performGapPull(hostId, after, gen, epoch, ac.signal)
    this.pulling.set(hostId, pull)
    void pull.finally(() => {
      this.gapPullAborts.delete(ac)
      if (this.pulling.get(hostId) !== pull) return
      this.pulling.delete(hostId)
      // Stale (resynced / re-sequenced) pulls never re-arm: the resync's
      // full rebuild supersedes the hole they were chasing.
      if (
        this.isCurrentGen(gen) &&
        epoch === this.gapPullEpoch &&
        (this.lastSeq.get(hostId) ?? 0) > after
      ) {
        this.ensureGapPull(hostId, gen)
      }
    }).catch(() => {
      /* performGapPull handles transport failures; keep cleanup defensive. */
    })
    return pull
  }

  private async performGapPull(
    hostId: string,
    after: number,
    gen: number,
    epoch: number,
    signal: AbortSignal,
  ) {
    try {
      const events = await this.pull(hostId, after, signal)
      if (events === null) return
      if (!this.isCurrentGen(gen) || epoch !== this.gapPullEpoch) return
      for (const ev of events) {
        if (!this.isCurrentGen(gen) || epoch !== this.gapPullEpoch) return
        this.accept(ev, gen)
      }
      // A response may contain a later event without the beginning of the
      // requested range. Keep it buffered; a subsequent live event retries
      // from the still-missing contiguous sequence.
      this.drainSequenced(hostId, gen)
    } catch {
      /* offline; the next live event or hello re-triggers the pull */
    }
  }

  private ensureGapPull(host: string, gen: number): void {
    if (!this.isCurrentGen(gen)) return
    const pending = this.pendingSeq.get(host)
    if (!pending || pending.size === 0) return
    const last = this.lastSeq.get(host) ?? 0
    // O(n) 循环而不是 Math.min(...pending.keys())：pendingSeq 由缺口大小
    // 决定，长时间缺前驱时条目可以很多，展开成实参会触碰引擎的实参上限
    // 直接抛 RangeError。
    let firstPending = Infinity
    for (const k of pending.keys()) {
      if (k < firstPending) firstPending = k
    }
    if (firstPending > last + 1) {
      void this.gapPull(host, last, gen)
    }
  }

  private drainSequenced(host: string, gen: number): void {
    if (!this.isCurrentGen(gen)) return
    const pending = this.pendingSeq.get(host)
    if (!pending) return
    let last = this.lastSeq.get(host) ?? 0
    while (pending.has(last + 1)) {
      const ev = pending.get(last + 1)!
      pending.delete(last + 1)
      last += 1
      this.lastSeq.set(host, last)
      this.emit(ev)
    }
    if (pending.size === 0) this.pendingSeq.delete(host)
  }
}
