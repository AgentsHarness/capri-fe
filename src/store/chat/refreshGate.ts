/**
 * 列表类资源的刷新闸门：单飞 + 尾随合并 + 每调用各自收尾。
 *
 * 并发触发（hello、`sessions_changed`、mutation、切 host 恢复）会挤在同一
 * 段时间里；闸门保证同一份列表最多一个请求在飞，且重复触发不放大请求量。
 *
 *  - 有请求在飞 → 该调用排队，等当前请求结束（单飞：永不并发）后执行；
 *  - 距上次完成不足 `minGapMs` → 合并成一次尾随刷新（最新闭包胜出）；
 *  - 否则立即跑。
 *
 * 返回的 promise 一律代表**这个调用自己那次执行**已经结束：在飞期间排队
 * 的调用在自己的闭包跑完后才 resolve；尾随窗口里被更新闭包合并掉的调用，
 * 等那次合并后的执行结束再 resolve（两者拉的是同一份数据）。调用方
 * `await` 之后可以认为数据已落地——mutation（fork / delete）不再被后来的
 * 并发刷新顶掉。
 *
 * 闭包由调用方捕获自己的 async scope（会话代际 / host）；拿旧闭包会在切换
 * 后被 `isAsyncScopeCurrent` 整批丢掉，表现成「刷了但没生效」。
 *
 * 首次调用总是立即执行，挂载时的首屏不受影响。
 */

export type RefreshGateOptions = {
  /**
   * 跳过节流窗口，立刻发。
   *
   * 只给用户显式动作（刷新按钮）用：那时他们要看的是加载指示和最新数据，
   * 把这次点击排到 400ms 后既让转圈迟到、也没有合并任何东西。在飞期间
   * 也照样插队（排在已排队调用之前），而不是被合并进它们的闭包。
   */
  immediate?: boolean
}

export type RefreshGate = ((
  run: () => Promise<void>,
  opts?: RefreshGateOptions,
) => Promise<void>) & {
  /**
   * 忘掉节流历史并丢弃排队中的刷新：新 host 的首轮刷新要立刻发出。
   *
   * 不会中止在飞的请求——那是 transport `setHost` → `abortInflight` 的
   * 职责；这里只是在它的结果被 async-scope 守卫丢弃前不再往上叠新调用。
   * 因此旧请求仍会占住单飞到 transport 中止为止，但它的 `.finally` 不会
   * 再补跑 reset 之前排队的闭包（代际不同），新 host 的刷新只等这场
   * 中止，不再等旧队列。
   */
  reset: () => void
}

type Job = {
  run: () => Promise<void>
  resolve: () => void
  /** 入队时的代际；`reset` 之后旧代际的排队闭包一律不跑。 */
  generation: number
}

export function createRefreshGate(minGapMs = 400): RefreshGate {
  /** 在飞的请求；非 null 期间的新调用进入 queued / pending。 */
  let inflight: Promise<void> | null = null
  /** 等在飞请求结束后执行的一串调用（FIFO；immediate 插到队首）。 */
  const queued: Job[] = []
  /** 尾随合并窗口里的调用：最新闭包胜出，所有 waiter 共享它的结果。 */
  let pending: { run: () => Promise<void>; waiters: (() => void)[] } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastDoneAt = 0
  /** 每次 reset 加一；在飞请求收尾时据此拒绝补跑旧代际的排队闭包。 */
  let generation = 0

  function start(job: Job): Promise<void> {
    lastDoneAt = Date.now()
    const p = job
      .run()
      .catch(() => {
        // 具体错误由被闸的 action 自己处理（重试 / 降级）；闸门只保证
        // 一个失败不会把队头堵死。
      })
      .finally(() => {
        lastDoneAt = Date.now()
        job.resolve()
        if (inflight === p) inflight = null
        // 在飞期间排队的调用依次补跑，仍然只串行一个。reset 之后旧代际的
        // 闭包属于上一台 host：放行 waiter 但不执行。
        let next = queued.shift()
        while (next && next.generation !== generation) {
          next.resolve()
          next = queued.shift()
        }
        if (next) void start(next)
      })
    inflight = p
    return p
  }

  /** 尾随窗口结束：跑合并后的闭包，等它的 waiter 一起放行。 */
  function flushPending(): void {
    const job = pending
    pending = null
    if (!job) return
    void start({
      run: job.run,
      resolve: () => job.waiters.forEach((resolve) => resolve()),
      generation,
    })
  }

  const gate = (run: () => Promise<void>, opts?: RefreshGateOptions): Promise<void> => {
    if (inflight) {
      // 在飞期间的调用各自排队、各自执行：闸门的返回值必须代表调用方
      // 自己的那次刷新，否则 mutation 的收尾会落在一个更早的请求上。
      return new Promise<void>((resolve) => {
        const job: Job = { run, resolve, generation }
        if (opts?.immediate) queued.unshift(job)
        else queued.push(job)
      })
    }
    if (opts?.immediate) {
      // 用户显式刷新：现在就发。已排队的尾随调用并入这次（它的闭包已被
      // 更晚的这次覆盖，waiter 共享本次结果），不另起一轮。
      let waiters: (() => void)[] = []
      if (timer != null) {
        clearTimeout(timer)
        timer = null
        waiters = pending?.waiters ?? []
        pending = null
      }
      return new Promise<void>((resolve) => {
        void start({
          run,
          resolve: () => {
            waiters.forEach((w) => w())
            resolve()
          },
          generation,
        })
      })
    }
    if (lastDoneAt === 0 || Date.now() - lastDoneAt >= minGapMs) {
      return new Promise<void>((resolve) => {
        void start({ run, resolve, generation })
      })
    }
    // 尾随窗口：只保留最新闭包；同一窗口的调用等它跑完一起放行。
    const promise = new Promise<void>((resolve) => {
      if (pending) {
        pending.run = run
        pending.waiters.push(resolve)
      } else {
        pending = { run, waiters: [resolve] }
      }
    })
    if (timer == null) {
      timer = setTimeout(() => {
        timer = null
        flushPending()
      }, minGapMs - (Date.now() - lastDoneAt))
    }
    return promise
  }

  gate.reset = () => {
    lastDoneAt = 0
    generation += 1
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
    // 排队中的那次属于上一个 host / 上一个节流窗口：丢掉，并把它的 waiter
    // 放行。复位后调用方（switchHost）会立刻发新的一轮，重放旧的只会多一条
    // 同数据的请求。
    pending?.waiters.forEach((resolve) => resolve())
    pending = null
    // 在飞期间排队、尚未开始的调用同样属于旧 scope（切 host 后它们的
    // 结果会被 isAsyncScopeCurrent 丢弃）：一并放行，别让调用方挂住。
    queued.splice(0).forEach((job) => job.resolve())
  }
  return gate
}
