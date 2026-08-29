# 先备份到 dsh-dev，再在本仓库对接官方

保存时间：2026-08-29。未执行。合官方前先读这份。

## 仓库分工

- **H:\dsh-dev**：本仓库**更新前的完整快照**，用来回滚。先同步，合官方期间不要再改它。
- **本仓库 H:\deepseek-harness**：对接官方、解冲突、改桌面。
- **H:\dsh-plugin**：本仓库更新成功后再改 must-fix。

回滚：把 `H:\dsh-dev` 的源码树拷回本仓库，回到「官方更新前、桌面还能按现状用」的那一版。成功后**不要**用新代码覆盖 dsh-dev，否则快照没了。

## 现状

- 本仓库 `master` 停在 `528c682e06`（`dsh-v0.1.1-rc.1`），官方 `origin/master` 是 `cd5ef81481`（`dsh-v0.1.2-alpha.1`），落后 1114 个提交，committed 历史可以快进。
- 未提交的桌面源码、4 个残留未合并索引、正在跑的 `dsh web --port 3080`。
- dsh-dev HEAD 也是同一旧提交，但 `apps/desktop` 只有过期 `lib/`、`release/`，必须先用本仓库源码盖过去才算能回滚。

## 步骤

1. **先把现在这版同步到 H:\dsh-dev**  
   已跟踪改动 + 未跟踪桌面源码。排除 `node_modules`、`.git`、`.tmp*`、`apps/desktop/release`、各包 `lib/`。抽查 `apps/desktop/electron/main.ts`、`packages/bundle/desktop/src/index.ts`。不 `git push`。

2. **本仓库快进官方**  
   避开 `dsh web`；清残留未合并索引；stash 桌面改动；`git pull --ff-only origin master`；`pnpm install`。合坏了从 dsh-dev 拷回。

3. **叠回桌面，按新 RPC 改**  
   约 11 个文件会撞。不要走旧 ApiProxy。用 `HostConnectionService.createSharedFetchHandler('/api')` 和 `__DSH_TRANSPORT__`（`fetch` + `openStream` + `ownsHost`）。`credentials` 必注入；`webServer` 可选。profile 用官方 `{ bundles, patchReload }` 加 desktop。`bundleText()` 与 `artifactBaseline()` 都留。

4. **插件（仅更新成功后）**  
   必改 plugin-install 的 `initProfile`、happy-bridge 的 `apiProxy.sessions.selectModel`。tsconfig 继续指向本仓库，删掉 `dsh-host-apiproxy`。

## 不做的事

- 合官方期间不改 dsh-dev。
- 成功后不用新代码覆盖 dsh-dev。
- 不把 `apps/desktop/release` 打进 git。
- 不改官方 web 默认鉴权。
