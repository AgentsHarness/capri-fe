/**
 * localStorage key 注册表——浏览器持久化命名的唯一来源。
 *
 * 约定：一律 `capri-fe.<camelCase>`。历史上并存过四种写法
 * （`acpfe.<x>`、`capri-fe-<x>`、`acp-fe-<x>`、`acp-fe.<x>`），
 * 现已全部收敛，旧名进 LEGACY_KEYS / DEAD_KEYS 由启动时的一次性迁移处理。
 *
 * 改名规则：新增 key 只认本表；要改已有 key 的名字，必须同时往
 * LEGACY_KEYS 加一条「旧 → 新」，否则用户本地数据当场蒸发
 * （主题被重置、host 选择丢失、被踢回令牌门）。
 */

/** storage.ts 用到的最小存储句柄形状（与 lib/storage 的 KVStore 一致）。 */
type KVHandle = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const KEY = {
  // ── 连接与凭据 ────────────────────────────────────────────────
  /** 公网 hub 的门禁密钥。 */
  hubToken: 'capri-fe.token',
  /** hostId → 该机 FE_TOKEN（仅浏览器直连本机端口时出示）。 */
  hostTokens: 'capri-fe.hostTokens',
  /** hostId → 'direct' | 'relay' 通路覆盖。 */
  routeChoice: 'capri-fe.routeChoice',
  /** 最近一次连过的 hub 地址。 */
  hubUrl: 'capri-fe.hubUrl',
  /** 上次选中的 host。 */
  host: 'capri-fe.host',

  // ── 界面偏好 ─────────────────────────────────────────────────
  theme: 'capri-fe.theme',
  /** 会话列表展示模式：'recent' | 'full'。 */
  workspaceMode: 'capri-fe.workspaceMode',
  /** 历史侧边栏视图模式。 */
  historyView: 'capri-fe.historyView',
  /** /multiline 输入模式。 */
  multiline: 'capri-fe.multiline',
  /** 取消一轮时是否连带停掉子代理。 */
  cancelSubagentsOnTurnCancel: 'capri-fe.cancelSubagentsOnTurnCancel',
  /** rewind 前是否需要确认。 */
  confirmBeforeRewind: 'capri-fe.confirmBeforeRewind',
  /** 审批弹窗默认选中的权限项。 */
  defaultSelectedPermission: 'capri-fe.defaultSelectedPermission',

  // ── 会话/权限状态 ────────────────────────────────────────────
  /** 全局权限模式（yolo/auto/permissionMode/confirmedAsk）。 */
  modeFlags: 'capri-fe.modeFlags',
  /** sessionId → plan 模式副本。 */
  planModes: 'capri-fe.planModes',
  /** 上次见到的 agent 启动时间戳，用于识别 host 重启。 */
  lastAgentStartedAt: 'capri-fe.lastAgentStartedAt',
  /** 已针对其重播种过权限模式的 agent 实例标识。 */
  permissionReseededFor: 'capri-fe.permissionReseededFor',
  /** 工作目录/会话置顶与待办：条目化后的离线缓存（{v:3, entries}）。 */
  historyPins: 'capri-fe.historyPins',
  /**
   * 已废弃（条目化同步不再需要，仅保留名字与迁移映射给仍在用的旧产物）：
   * 上次与 hub 对齐的 pins 快照指纹。旧协议的「本地是否有未推送改动」判定
   * 之源，正是取消的置顶被整份推回 hub 的入口。
   */
  historyPinsSynced: 'capri-fe.historyPins.synced',
  /** 有尚未被 hub 确认接受的本地改动（现仅用于安排重试）。 */
  historyPinsDirty: 'capri-fe.historyPins.dirty',
  /** hub 侧 prefs 文档版本号（条目合并用不上；旧 hub 条件写 + 排障）。 */
  historyPinsVer: 'capri-fe.historyPins.ver',
  /**
   * 已废弃：旧协议的待重放写操作队列。条目模型里每个条目自带时间戳与写入端，
   * 不再需要单独的操作日志。
   */
  historyPinsOps: 'capri-fe.historyPins.ops',
  /** 本浏览器源标识（条目同分时的定序裁决），见 store/prefsEntries.ts。 */
  historyPinsSite: 'capri-fe.historyPins.site',

  // ── 输入历史 ─────────────────────────────────────────────────
  /** composer 上行历史。 */
  promptHistory: 'capri-fe.promptHistory',
  /** 斜杠命令最近使用度。 */
  slashRecency: 'capri-fe.slashRecency',
} as const

/**
 * 旧键 → 新键。启动首次访问存储时搬运一次（见 lib/storage 的 getStore）。
 * 语义：新键已有值则以新键为准，旧键直接丢弃；新键为空才搬值。
 */
export const LEGACY_KEYS: Record<string, string> = {
  // 更名提交 f39174a 只改了 token/host/theme 三个键，其余 acpfe.* 一直沿用
  'acpfe.modeFlags': KEY.modeFlags,
  'acpfe.planModes': KEY.planModes,
  'acpfe.lastAgentStartedAt': KEY.lastAgentStartedAt,
  'acpfe.permissionReseededFor': KEY.permissionReseededFor,
  'acpfe.historyPins': KEY.historyPins,
  'acpfe.historyPins.synced': KEY.historyPinsSynced,
  'acpfe.historyPins.dirty': KEY.historyPinsDirty,
  'acpfe.historyPins.ver': KEY.historyPinsVer,
  'acpfe.historyPins.ops': KEY.historyPinsOps,
  'acpfe.historyView': KEY.historyView,
  'acpfe.multiline': KEY.multiline,
  'acpfe.slashRecency': KEY.slashRecency,
  'acpfe.promptHistory': KEY.promptHistory,
  'acpfe.confirmBeforeRewind': KEY.confirmBeforeRewind,
  'acpfe.cancelSubagentsOnTurnCancel': KEY.cancelSubagentsOnTurnCancel,
  'acpfe.defaultSelectedPermission': KEY.defaultSelectedPermission,

  // 分隔符收口：这两处当年用了短横，统一成点
  'capri-fe-token': KEY.hubToken,
  'capri-fe-workspace-mode': KEY.workspaceMode,

  // 初始提交（0df25fa）的前缀，8/14 之后代码不再读写
  'acp-fe.theme': KEY.theme,
  'acp-fe.host': KEY.host,
}

/**
 * 无新键对应的历史残留，直接清除。
 *
 * `acp-fe-token` 不参与搬运：那是权限模式尚未拆分 hub/host 两槽时代的唯一
 * 令牌键，值既可能是 hub 门禁密钥也可能是某台 host 的 FE_TOKEN，猜错会把
 * 人踢到令牌门外，所以只删不搬。`acpfe.lastViewedAt` 的读写代码已删。
 */
export const DEAD_KEYS: string[] = ['acp-fe-token', 'acpfe.lastViewedAt']

/**
 * 一次性把 LEGACY_KEYS 搬到新名、清掉 DEAD_KEYS。
 *
 * 幂等：搬完旧键即消失，二次调用是空操作。整体 try/catch——存储不可用
 * （无痕/配额）时静默跳过，读写路径照常工作。
 */
export function migrateStorageKeys(store: KVHandle): void {
  try {
    for (const [legacy, current] of Object.entries(LEGACY_KEYS)) {
      if (legacy === current) continue
      const raw = store.getItem(legacy)
      if (raw === null) continue
      if (store.getItem(current) === null) store.setItem(current, raw)
      store.removeItem(legacy)
    }
    for (const dead of DEAD_KEYS) store.removeItem(dead)
  } catch {
    /* 静默降级 */
  }
}
