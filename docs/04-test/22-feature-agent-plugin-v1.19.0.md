---
title: Agent Plugins 打包与 skill 跨 harness 适配（v1.19.0）
version: v1.19.0
created: 2026-11-03
status: final
---

# Agent Plugins 打包与 skill 跨 harness 适配 — v1.19.0

## 背景

此前 skill 只以 Claude Code 的方式存在：`assets/skills/code-review/SKILL.md`，正文里写死了 Claude Code 的工具名（Agent / Read / Grep / Glob / TodoWrite）和本 MCP 的 shell 契约。其他 harness 即使支持 Agent Skills，也只能得到一份"Claude Code 专用"的流程文本；MCP server 本身也没有可移植的插件清单。

## 依据的协议

- [Agent Plugins 1.0.0](https://agent-plugins.org/specification)：plugin root 固定 `plugin.json`（closed manifest）+ `skills/`（Agent Skills）+ `mcp.json`（closed MCP 配置）；`$schema` 固定为 1.0.0 的两个 canonical 标识；配置里的路径必须留在 plugin root 内；组件失败非致命。
- [Agent Skills](https://agentskills.io/specification)：`SKILL.md` YAML frontmatter（`name` 必须与目录名一致、`description` ≤1024、可选 `license`/`compatibility`/`metadata`/`allowed-tools`），正文 < 500 行，`scripts/`/`references/`/`assets/` 为约定目录。

## 改动

1. **仓库成为 Agent Plugins v1.0.0 包**（repo root = plugin root）：
   - 新增 `plugin.json`：canonical plugin `$schema`、`name: cc-code-review`、版本与 package.json 同步、MIT。
   - 新增 `mcp.json`：canonical mcp `$schema`、stdio server `cc-code-review`，`command: node`、`args: ["${PLUGIN_ROOT}/src/index.js"]`、`cwd: "${PLUGIN_ROOT}"`。
   - skill 从 `assets/skills/code-review/` 移到 `skills/code-review/`（固定发现位置；plugin root 下不再有 assets/）。`src/skill.js`、`src/prompt.js`、`src/shell-guard.js`（自审 glob 与 `SELF_REVIEW_PIPELINE`）、`scripts/pack-test.mjs`、`scripts/p0-regression-test.mjs`、`package.json#files` 同步。
2. **SKILL.md 改写为可移植 Agent Skill**：
   - frontmatter 增加 `license: MIT`、`compatibility`（git/gh、fan-out 可选、MCP 会追加 allowlist）、`metadata`（version/homepage）。
   - 正文改为能力语言：fan-out 用 "your harness's subagent/task tool"，无 fan-out 时顺序执行全部角度；"Read/Grep/Glob" → "your harness's file-read/search tools"；新增 Harness notes（Claude Code / 其他 Agent Skills harness / 无 fan-out / 只读）。
   - 本 MCP 的 shell 契约保留为默认只读 briefing，并明确：当 run prompt 自带契约（cc-code-review MCP 会带）时逐字复制。
   - 报告合同（`## Code Review Summary` 等）与 clean-run 句子原样保留——`src/prompt.js` 在加载时从该文件抽取，仍是单一来源。
3. **新增 `scripts/plugin-test.mjs`（45 项，离线）**：校验 plugin.json（closed schema / canonical `$schema` / name 约束 / 与 package.json 的 version、license 一致）、mcp.json（closed 顶层、与 plugin.json 同版本、stdio variant、command 单 token、保留 env 名、cwd 形式、路径 containment）、`skills/*/SKILL.md`（frontmatter 字段与取值、name↔目录、description 长度、正文行数、报告合同存在、路径 containment），以及 `package.json#files` 是否随包发布这三个文件。已加入 `npm test`（8 套件）。
4. **README（中英）**：注册章节改为通用 MCP 客户端（ZCode 一条命令 / Claude Code `.mcp.json` + `claude mcp add` / Cursor / 其他 stdio 客户端）；新增「作为 Agent Plugin / Agent Skill 使用」章节；skill 路径与 inline prompt 体积（~12KB）更新；`claude` 解析章节标题改为名副其实。

## 验证

- `plugin-test`：45/45（含一条 YAML 歧义检查：frontmatter 的 plain scalar 里不允许 `: `）。
- `npm test`：8/8 套件（shell-guard 327、audit-fixes 318、p0 256、validation 31、plugin 44、pack 52、smoke、cross-cases 156/156）。
- 报告合同来源断言：`reportContractSource()` 仍为 `"skill"`（从新路径的 SKILL.md 抽取成功）。
- pack-test：tarball 含 `plugin.json` / `mcp.json` / `skills/code-review/SKILL.md`，仍是窄文件列表且体积在上限内。
- CI：Node 20/22/24 × ubuntu/macos/windows 矩阵全绿。

## 已知边界

- Agent Plugin 的 MCP 组件需要 plugin root 里有 `node_modules`（先 `npm install`）；缺依赖时 server 组件失败、skill 仍可加载（协议要求组件失败非致命）。
- `command: node` 是 bare 可执行名，由客户端的平台搜索规则解析；包内不自带 Node 运行时。
- 未使用 client extension 命名空间；v1 不支持 commands/hooks/agents 等其他组件类型。
