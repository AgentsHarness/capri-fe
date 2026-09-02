<p align="center">
  <img src="docs/brand/capri.png" alt="Capri mark" width="88" />
</p>

<h1 align="center">Capri FE</h1>

<p align="center">
  <strong>Grok Build Web UI</strong>
</p>

<p align="center">
  <em>Capricorn · AgentsHarness 的第一颗星座</em>
</p>

<p align="center">
  <a href="https://github.com/AgentsHarness"><img src="https://img.shields.io/badge/AgentsHarness-vision-002255?style=flat-square" alt="AgentsHarness" /></a>
  <a href="https://github.com/AgentsHarness/capri-host"><img src="https://img.shields.io/badge/sibling-capri--host-002255?style=flat-square" alt="capri-host" /></a>
  <a href="https://github.com/AgentsHarness/capri-hub"><img src="https://img.shields.io/badge/sibling-capri--hub-002255?style=flat-square" alt="capri-hub" /></a>
  <img src="https://img.shields.io/badge/for-Grok%20Build-0c0c0e?style=flat-square" alt="Grok Build" />
  <a href="https://github.com/AgentsHarness/capri-fe/releases"><img src="https://img.shields.io/github/v/tag/AgentsHarness/capri-fe?style=flat-square&color=002255" alt="版本号" /></a>
</p>

---

[AgentsHarness](https://github.com/AgentsHarness) 让你随时随地远程使用 Agents。

**Capri**（Capricorn）是 [Grok Build](https://x.ai/cli) 的具体适配项目，我们基于 ACP 协议，搭配 capri-host、capri-hub 实现远程数据传输。

> 快速开始：
> 安装 Grok Build
> 启动 [capri-host](https://github.com/AgentsHarness/capri-host) 后会自动拉起 Grok Build 核心以及开放 `http://localhost:8765`，WebUI 已经自动嵌入。

## 截图

![Capri FE 界面](docs/screenshot.png)

## 能力

- 在手机、平板、另一台电脑的浏览器里，继续本机 grok 的会话
- 左上角切换 Host：家里的、办公室的、服务器上的
- 斜杠命令、权限审批、图片、后台任务、Git / MCP / 记忆——对齐 Grok Build TUI 的常用能力

Agent 在 Host 那台机器上自己读文件、跑命令。浏览器只负责掌控。

## 开发

需要本机已有 [capri-host](https://github.com/AgentsHarness/capri-host)（或 [capri-hub](https://github.com/AgentsHarness/capri-hub)）。

```bash
# 终端 1 — 本机节点
cd ../capri-host && go run ./cmd/capri-host

# 终端 2 — 前端
npm install
npm run dev
```

打开 <http://localhost:5173>。开发服务器会把 `/api`、`/events` 代理到 `http://localhost:8765`。

连上 Hub、同时看好几台机器：

```bash
VITE_PROXY_TARGET=http://<hub>:8787 npm run dev
```

若 Hub 设置了 `FE_TOKEN`，页面会弹出密钥框。密钥只存在你这台浏览器里，**不要**写进 `VITE_*` 或打进静态包。

### 两把钥匙与本机直连

打开页面只问 **Hub 那把**。之后如果发现选中的一台 Host 就跑在这台电脑上，页面会默认
**直连它的本地端口**（少一跳中继，Hub 不可达时也还能用），而不是绕 Hub。

- 那台 Host 没设 `FE_TOKEN`：直连是免鉴权的本机请求，什么都不问。
- 设了：页面先拿 Hub 那把探一次它的 `GET /api/probe`。两把同值就直接连通，不多问；
  不同值才弹一次「这台 Host 的钥匙」（按机器分别保存，不会覆盖 Hub 那把）。
- 不想输可以拒填：那一台退回 Hub 中继，**Hub 登录不受影响**。事后也能在左上角 Host
  列表的右键菜单里改：「直连本机」/「经 Hub 中继」，行上会标当前是直连还是中继。

Hub 那把失效（服务端换了 `FE_TOKEN`）才会把页面送回门禁。

| 变量                | 说明                                                |
| ------------------- | --------------------------------------------------- |
| `VITE_PROXY_TARGET` | 开发代理目标。默认本机 Host `http://localhost:8765` |

## 项目生态

|                             项目                              |             介绍                    |
| --------------------------------------------------------- | ------------------------------- |
| [AgentsHarness](https://github.com/AgentsHarness)         | 总项目                          |
| [capri-host](https://github.com/AgentsHarness/capri-host) | Agent 节点，内嵌 Capri FE       |
| [capri-hub](https://github.com/AgentsHarness/capri-hub)   | 中继节点，转发用户和 Agent 消息 |

MIT · [Linux.do](https://linux.do)
