/**
 * MCP 状态分级 —— `x.ai/mcp/server_status` 载荷的唯一判色依据。
 *
 * shell 侧 `McpServerStatusPayload` 每条事件都带 `reason`（必填枚举，
 * snake_case）：它是「这次状态变化是因为什么」的原因码，成功转移同样有值
 * （首次握手完成 = `initialized`，工具列表刷新 = `config_changed`，
 * 自动重启恢复 = `restart_succeeded`）。真正的失败描述只在可选的 `detail`
 * 里（handshake_failed / restart_failed 才带）。所以诊断文案的红/黄只能按
 * `status` 判，不能按「有没有 reason」判。
 */

/** 视觉档位：绿=就绪，黄=进行中/待配置，橙=待认证，红=异常，灰=未知。 */
export type McpTone = 'ok' | 'pending' | 'auth' | 'error' | 'unknown'

/**
 * wire status → 档位。shell 序列化为小写（`ready` / `initializing` /
 * `unavailable` / `needs_auth`）；`connected` / `running` / `ok` 是 host 与
 * 旧 shell 的同义写法，`setuprequired` 是驼峰吞掉下划线后的形态。
 * 未知取值按异常处理（新状态先亮红再补映射，比静默绿色安全）。
 */
export function mcpTone(status?: string): McpTone {
  switch (status?.trim().toLowerCase()) {
    case 'ready':
    case 'connected':
    case 'running':
    case 'ok':
      return 'ok'
    case 'initializing':
    case 'connecting':
    case 'setup_required':
    case 'setuprequired':
      return 'pending'
    case 'needs_auth':
    case 'needsauth':
      return 'auth'
    case undefined:
    case '':
      return 'unknown'
    default:
      return 'error'
  }
}
