
/**
 * x.ai/billing config (xai-grok-shell extensions/billing.rs BillingConfig,
 * camelCase). Only the fields the credits chip consumes are typed; the
 * rest passes through the wire untouched.
 */
export type BillingConfig = {
  /** Included credit usage as a percentage of the allowance (0–100). */
  creditUsagePercent?: number
  /** Remaining prepaid balance in USD cents (positive = bought credits). */
  prepaidBalance?: { val: number }
  /** Deprecated: included monthly credit budget in cents. */
  monthlyLimit?: { val: number }
  /** Deprecated: credits used this period in cents. */
  used?: { val: number }
  currentPeriod?: { start?: string; end?: string }
  [k: string]: unknown
}

/** x.ai/billing top-level response (BillingConfigResponse). */


/** x.ai/billing top-level response (BillingConfigResponse). */
export type BillingConfigResponse = {
  config?: BillingConfig | null
  onDemandEnabled?: boolean
  subscriptionTier?: string
  [k: string]: unknown
}

/**
 * 宿主侧 /api/usage-report 的单个统计行（总计或一个模型）。字段与 agent
 * 的 usage 对象一一对应；cacheHitRate 为派生命中率（cachedRead/input，
 * 0–1）。全部 optional —— 旧宿主没有该端点时前端防御性降级。
 */


/**
 * 宿主侧 /api/usage-report 的单个统计行（总计或一个模型）。字段与 agent
 * 的 usage 对象一一对应；cacheHitRate 为派生命中率（cachedRead/input，
 * 0–1）。全部 optional —— 旧宿主没有该端点时前端防御性降级。
 */
export type TokenUsageStat = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  modelCalls?: number
  /** 统计到的回合终态事件数。 */
  turns?: number
  /** 命中率 0–1（cachedReadTokens / inputTokens）。 */
  cacheHitRate?: number
}

/**
 * POST /api/usage-report 响应（宿主侧聚合，非 x.ai 直通）。from/to 为
 * 归一化后的 unix 秒窗口；total 为总计，byModel 按模型分组（无分组数据
 * 归 "unknown"）。
 */


/**
 * POST /api/usage-report 响应（宿主侧聚合，非 x.ai 直通）。from/to 为
 * 归一化后的 unix 秒窗口；total 为总计，byModel 按模型分组（无分组数据
 * 归 "unknown"）。
 */
export type UsageReportData = {
  from?: number
  to?: number
  /** 覆盖的会话数（有窗口内事件的 updates.jsonl 文件数）。 */
  sessions?: number
  total?: TokenUsageStat
  byModel?: Record<string, TokenUsageStat>
}

/** GET /api/extensions — one hook row. */
