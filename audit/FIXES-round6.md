# 修复报告（第六轮）— v1.18.6

**基线**：v1.18.5（第三轮审计的残余：P2-1 / P2-3 / P2-22 + FIXES-round5 的 P1-4、P1-13、fail-closed 缺口）
**结果**：v1.18.6（`npm test` 7 套件全绿：shell-guard 292 / audit-fixes 313 / p0-regression 181 / validation 30 / pack 43 / cross-cases 154 / smoke）
**方式**：subagent 运行时本轮不可用（3 个全部异常终止且未改任何文件），由 Lead 直接逐项修复并补回归。

## 逐条

| # | 问题 | 修复 | 验收 |
|---|---|---|---|
| P2-1 | git 加固表三份手工维护且已漂移（`-c` 表加键不进子进程 env —— P0-1 的根因） | 单一 `GIT_HARDENING` 表生成 env / `-c` / scanner 三处；模块加载断言"args 或 scan 的键必须 env" | audit-fixes 源级断言 + `-c` 键 ⊆ env 键；env 9→16 对 |
| P2-3 | containment 原语 5 份拷贝、已分叉（仓库根 hook 拒 / guard 允） | shell-guard 导出 `realpathNearest`/`repoRelative`/`isInsideRepo(...,{allowRoot})`；hook、guard、metadata reader 共用 | p0 同一组路径两侧判定一致；hook 无私有 `realContainment`；claude 无 `fs.realpathSync(root)` |
| P1-4 残余 | `rg --hidden/--no-ignore/-u`、根级递归 `grep` 可读 `.env` 等被忽略的密钥文件 | 窄规则拒绝上述形态；scoped 搜索保持 ALLOW | shell-guard +16 条断言、p0 live-hook 5 条 |
| package.json Edit | hook 只查 Write 内容，Edit/MultiEdit 可逐行加 `scripts.postinstall` | Edit/MultiEdit 的 `new_string` 同样检查 | p0：加 postinstall DENY / 改 version ALLOW |
| P1-13 残余 | 指纹只哈希表，不覆盖内联规则代码 | 把 `segmentProblem`/`dotGlobProblem`/`isInsideRepo`/`repoRelative`/`pathArgs`/`outrightDeny`/`ghProblem` 的源码纳入指纹 | audit-fixes：改副本函数体 → 指纹不同 |
| fail-closed | 不可解析的 `.git/config` 只记 note；`git ls-files` 失败只 note（node_modules 下 attributes 未验证） | 两者都改 refusal（bad config 明确文案） | p0：坏 config 仓库 / 坏 index 仓库 → refusals>0 |
| P2-22 | lockfile 94/95 tarball 指向 `registry.npmmirror.com` | 94 个 `resolved` 改写为 `registry.npmjs.org`（路径与 integrity 不变） | `grep -c npmmirror` = 0；`npm ci --dry-run` 通过；CI 三平台 npm ci 验证 |

## 未做 / 设计取舍

- **P0-6 `gh --repo` 未绑定被审仓库**：`pr=owner/repo#N` 指向其他仓库是合法功能（跨仓 PR 评论），绑定会破坏它；保持形状校验并在报告记录。
- **`.env.example` 层间差异**：权限层 `**/.env.*` 拒绝写入模板、hook 允许；权限层更严（保守方向），非漏洞，记录不改。
- 扫描器对"git 完全不可用"（不是坏 config/index）仍按 not-a-repository 静默——此时评审也无法产生任何 git 输出，无安全面。

## 验证

- Lead 独立探针 `/tmp/verify-round6.mjs`：**20/20**（P1-4 矩阵、package.json Edit、共享 containment、坏 config fail-closed、指纹内联规则）。
- `npm test` 7/7、exit 0；新增回归：shell-guard 272→292、audit-fixes 305→313、p0 163→181。
- 环境限制：subagent 工具本轮不可用，全部改动由 Lead 完成（无并行写冲突）。