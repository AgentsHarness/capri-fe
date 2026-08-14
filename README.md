<p align="center">
  <img src="docs/brand/banner.png" alt="Capri" width="920" />
</p>

<p align="center">
  <img src="docs/brand/capri.png" alt="Capri mark" width="88" />
</p>

<h1 align="center">Capri FE</h1>

<p align="center">
  <strong>浏览器里的 Agents 操作台</strong><br />
  <em>Capricorn · AgentsHarness 的第一颗星座</em>
</p>

<p align="center">
  <a href="https://github.com/AgentsHarness"><img src="https://img.shields.io/badge/AgentsHarness-vision-002255?style=flat-square" alt="AgentsHarness" /></a>
  <a href="https://github.com/AgentsHarness/capri-host"><img src="https://img.shields.io/badge/sibling-capri--host-002255?style=flat-square" alt="capri-host" /></a>
  <a href="https://github.com/AgentsHarness/capri-hub"><img src="https://img.shields.io/badge/sibling-capri--hub-002255?style=flat-square" alt="capri-hub" /></a>
  <img src="https://img.shields.io/badge/for-Grok%20Build-0c0c0e?style=flat-square" alt="Grok Build" />
</p>

---

[AgentsHarness](https://github.com/AgentsHarness) 想让你在任何时间、任何设备上，掌控任何设备上的 Agents。这件事叫 **slogin**。

**Capri**（Capricorn）是现在的落地。`capri-fe` 是你打开浏览器就能用的那一面：对话、工具、权限、多机切换。当前先适配 [Grok Build](https://x.ai/cli)。

> 只想用起来？**不必单独跑这个仓库。**  
> 启动 [capri-host](https://github.com/AgentsHarness/capri-host) 后打开 `http://localhost:8765`，界面已经嵌在里面。

这个仓库给两件事：改界面，或在开发时把前端指到 Hub。

## 你能做什么

- 在手机、平板、另一台电脑的浏览器里，继续本机 grok 的会话
- 左上角切换 Host：家里的、办公室的、服务器上的
- 斜杠命令、权限审批、图片、后台任务、Git / MCP / 记忆——对齐 Grok Build TUI 的常用能力

Agent 在 Host 那台机器上自己读文件、跑命令。浏览器只负责看和说。

## 开发

需要本机已有 [capri-host](https://github.com/AgentsHarness/capri-host)（或 [capri-hub](https://github.com/AgentsHarness/capri-hub)）。

```bash
# 终端 1 — 本机节点
cd ../capri-host && go run ./cmd/acp-host

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

| 变量 | 说明 |
|------|------|
| `VITE_PROXY_TARGET` | 开发代理目标。默认本机 Host `http://localhost:8765` |

## 一家子

| | |
|---|---|
| [AgentsHarness](https://github.com/AgentsHarness) | 愿景：远程接入，互相调用 |
| [capri-host](https://github.com/AgentsHarness/capri-host) | 本机节点，内嵌这份前端 |
| [capri-hub](https://github.com/AgentsHarness/capri-hub) | 中继，把多台 Host 收拢到一处 |

MIT · [Linux.do](https://linux.do)
