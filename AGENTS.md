# AGENTS.md — 给后续会话的操作约定

## 必须遵守：插件更新后同步上传 GitHub

本仓库镜像在 **https://github.com/daybyday66/dsh-camel-pool**（private）。用户要求：**每次插件改动都要同步上去**。

### 一条命令

```bash
npm run sync        # = node scripts/gh-push.mjs
```

脚本行为：

1. 先试原生 `git push origin HEAD:main`（自动清空 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，因为本机环境里那个 127.0.0.1:7897 代理是死的）；
2. 失败（本机 github.com:443 常被阻断：TIMEOUT / Connection reset）则自动改走 **GitHub Git Data API**：blob → tree → commit 链 → `PATCH /repos/:owner/:repo/git/refs/heads/main`；
3. commit 对象用本地 `git cat-file commit` 的原始字节重建，因此远端 SHA 与本地一致，下次同步走增量（`rev-list remote..HEAD`），不依赖强推；
4. token 来源：`$GH_TOK` > `~/.dsh/camel-pool-gh.token`。

### 自动化

`.git/hooks/post-commit` 已装（**不提交**，只在本地）：每次 commit 后后台跑 `node scripts/gh-push.mjs --quiet`，日志在 `~/.dsh/gh-sync.log`。

临时关掉：`git config --local dsh.autosync false`，或 `DSH_NO_AUTOSYNC=1 git commit ...`。

### 注意

- `git push` 走不通时不要用 `--force` 硬试；直接 `npm run sync`。
- 若远端 `main` 与本地 SHA 不一致且本地没有该提交对象，脚本会自动回退为全量重建（`force: true`）。
- 仓库是 private，链接未登录时返回 404，属正常。

## 其它

- 插件通过符号链接被 `~/.dsh/profiles/desktop/node_modules/dsh-camel-pool` 引用；改完跑热重载（`unlag_refresh`），不必重启 DSH。
- 自检：`npm run check`（check-all / check-imports / check-pool-core / check-hardening / check-qoder-vault）。