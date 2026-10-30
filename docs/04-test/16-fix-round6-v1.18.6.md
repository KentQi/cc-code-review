---
title: 修复报告（第六轮）
version: v1.18.6
created: 2026-10-30
status: final
---

# 修复报告（第六轮）— v1.18.6

**基线**：v1.18.5（第三轮审计的残余：P2-1 / P2-3 / P2-22 + FIXES-round5 的 P1-4、P1-13、fail-closed 缺口）
**结果**：v1.18.6（`npm test` 7 套件全绿：shell-guard 298 / audit-fixes 314 / p0-regression 206 / validation 30 / pack 48 / cross-cases 154 / smoke）
**PR**：[#6](https://github.com/KentQi/cc-code-review/pull/6)（stacked on [#5](https://github.com/KentQi/cc-code-review/pull/5)）
**CI**：ubuntu/macos/windows × node 18/22 **6/6 全绿**（run [40992030320](https://github.com/KentQi/cc-code-review/actions/runs/40992030320)）
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
- `npm test` 7/7、exit 0；新增回归：shell-guard 272→298、audit-fixes 305→314、p0 163→206、pack 43→48。
- 环境限制：subagent 工具本轮不可用，全部改动由 Lead 完成（无并行写冲突）。
## CI 抓到的两个 fixture 问题（已修）

- **Node 18 的 ESM 检测**：P1-13 的指纹副本以 `.js` 放在无 `package.json` 的临时目录，Node 18 按 CommonJS 解析 → 改为复制成 `.mjs`（Node 22+ 自动检测 ESM，所以只有 18.x job 红）。
- **Windows 的 git config 转义**：hooksPath/fsmonitor fixture 把 `C:\...` 原样写进 `.git/config`，反斜杠是转义符 → `bad config line`，而扫描器现在 fail-closed 拒绝（此前 fallback line-scan 会通过）。fixture 改用 `cfgPath()` 正斜杠（git 全平台接受）。

这两个都是测试 fixture 的平台问题，不是产品缺陷；修复后 CI 6/6。

## 收编的增量（A/B 组在 Lead 核心实现之上完成）

Lead 先落地了 round-6 的核心（单表固定键、fail-closed、P1-4 窄规则、package.json Edit、指纹子集、P2-3 的 realpathNearest/repoRelative/isInsideRepo）。随后两个 subagent 在此基础上补齐了完整性：

- **P2-1 全量单表**：扫描侧的通配/正则族（`url.*.insteadOf`、`remote.*.vcs`、`diff|filter.<name>.*`、`pager.<cmd>`、`credential[.<url>].helper`、`merge.<name>.driver`、`include[If].path`）也进入 `GIT_HARDENING` 的 `pattern` 字段，由 `scanPattern()`/`scanKeyOfKind()` 派生；原有 8 个手工常量删除。加载期断言扩展：pattern 禁 env/args、禁 `g`/`y`、id 唯一、transport 必须有 refuse。env 16 键 / args 16 对与重构前逐字节一致，28 个真实仓库 fixture 的 refusals+notes 完全一致。
- **P2-3 完整收口**：`readRepoFile` + `MAX_REPO_METADATA_BYTES` 移入 `src/shell-guard.js`（唯一实现），`claude.js` 改为 import；`isInsideRepo` 默认 `allowRoot=false`（仓库根默认不算内部），新增 `shellSyntax` 选项区分 Bash 词元与工具字面路径（修掉"仓库内 `a$b.txt` 被 hook 误拒"）。hook 的 Write/Read 用 `allowRoot:false`、Grep/Glob 用 `allowRoot:true`，两侧判定一致（130/130 矩阵）。
- **P1-4 残余补强**：grep 的规范化根（`.//`、`src/..`、仓库根绝对路径）与 GNU `-d recurse` 别名也拒绝；`--` 之后的 token 不再当 flag（`rg -n -- --hidden .` ALLOW）；`grep -rn x -- .` 仍 DENY。
- **P1-13 完整覆盖**：指纹 canon 纳入全部 22 个规则函数源码（`parseCommand`/`matchPolicy`/`cdProblem`/`analyseCommand` 等），不只 7 个。
- **fail-closed 加固**：不依赖 git 英文报错文本（本地化 shim 仍 refusal；旧 git 缺 `--no-includes` 仍走行扫描不误拒）；`spawnSync` 抛异常也 refusal。

验证：shell-guard 298、audit-fixes 314、p0-regression 206、validation 30、pack 48、cross-cases 154/154、smoke PASS；`npm test` 7/7（本机 + 克隆各一次）；Lead 探针 20/20。

## 收尾时又修的两处（scripts 组报告的残余）

- **package.json 的 Edit 结果级校验**：只查 `new_string` 时，`"preinstal"` → `"preinstall"` 这种两步改名可以绕过（每个 new_string 都不含 install 键）。hook 现在读当前文件、应用 old→new 重建结果再解析；读不到/不匹配时回退到 new_string（绝不放行）。p0 新增两步改名 DENY / 无害改名 ALLOW。
- **`core.attributesFile` 的 containment**：claude.js 里最后一处手写 `path.relative(realpath(...))` 改为共享 `repoRelative`（P2-3 同类收口）；audit-fixes 新增源级断言。
