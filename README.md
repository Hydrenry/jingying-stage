# 晶莹的舞台：GitHub Pages + Supabase 免费安装包

核实日期：2026-10-31。本文件夹是可手动上传的静态网站包；GitHub Pages 托管网页，Supabase 保存在线排期、账号和管理权限。登录使用自己的邮箱密码，不依赖 ChatGPT。无需 GitHub 插件、服务器、Node.js 或 Docker。

如果第一次接触这些工具，先看 [GitHub 免费上线教程](START.md)，先完成 Supabase 注册并进入控制台；下面的步骤可以分次操作。

## 免费条件与当前状态

GitHub Free 支持**公开仓库**的 Pages，网址通常为 `https://用户名.github.io/仓库名/`。Supabase Free 当前为 0 美元/月，受数据库、流量、用户及函数等配额限制；一周低活跃可能触发项目暂停，需要回控制台恢复。Free 不包含自动数据库备份，不代表无限用量或永远在线。[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[Supabase 价格](https://supabase.com/pricing)、[项目暂停](https://supabase.com/docs/guides/platform/free-project-pausing)

本包没有替你创建仓库、Supabase 项目或上线新站，真实云端初始化和访问还需要按下列步骤完成。

## 1. 先发布网页，取得实际网址

在自己的 GitHub 公开仓库首页，选择 **Add file → Upload files**，上传**本文件夹里面的文件和子文件夹**。如果得到的是 ZIP，先解压，不要把 ZIP 当成网页文件上传。

上传后，仓库最外层应直接看到 `index.html`、`config.js`、`cloud-client.js`、`app.js`，以及 `admin`、`assets`、`supabase` 文件夹。不能再多套一层 `github-pages-site`。这一步可以全部在浏览器完成；每次最多上传 100 个文件，单个文件不得超过 25 MiB。[GitHub 上传说明](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)

提交到 `main`，再打开仓库 **Settings → Pages**：

| 项目 | 选择 |
| --- | --- |
| Source | Deploy from a branch |
| Branch | main |
| Folder | /(root) |

点击 Save，等待 Pages 显示发布成功，复制它给出的实际 HTTPS 网址，包含最后的仓库路径与 `/`。后续称这个完整网址为“网站基址”。[发布设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

此时 `config.js` 还是空值，首页只能体验附带的原始 84 条排期，管理功能没有启用。**这不是旧站线上最新数据库。**若旧站已经有新增或修改，先从旧站保留最新排期备份，核对迁移数据后再正式对外使用；不要把回退数据当作已经完成数据迁移。

## 2. 创建 Supabase Free 项目并初始化

在 [Supabase Dashboard](https://supabase.com/dashboard) 登录，创建自己的 Free 项目。项目数据库密码与网站站主密码是两回事；不要把数据库密码填进网页配置。等待项目准备完成后，打开项目的 **SQL Editor**。

按下面顺序执行两次查询，每次复制对应文件的**完整内容**，粘贴到新的查询中运行；不要把 Markdown 的三反引号一起复制：

1. 先运行 [`supabase/schema.sql`](supabase/schema.sql)，创建表、RPC 和权限规则。
2. 成功后运行 [`supabase/seed.sql`](supabase/seed.sql)，初始化原表的 84 条排期。

种子保留 8 条未知时间为 `null`，没有待核项目。它只初始化缺失的排期状态，重复执行不会覆盖已有在线修改，但也不能用来恢复或刷新线上数据。若要搬迁旧站最新版本，应先核对最新备份的导入方式，不能靠重复运行 seed 完成。

`schema.sql` 已为数据表启用 RLS，并禁止浏览器直接读写表；需要的操作通过逐次检查身份的 RPC 完成。不要为了排除错误而关闭 RLS 或添加“所有人可写”策略。[Supabase 数据安全说明](https://supabase.com/docs/guides/database/secure-data)

## 3. 明确创建自己的站主账号

在 Supabase 的 Auth 配置中，关闭 **Allow new users to sign up** 和匿名登录，保留邮箱密码登录。将密码最短长度设为 12；可选的密码变更通知保持关闭。本地 `supabase/config.toml` 只是配置参考，不会自动替你更改云端项目。[Auth 配置说明](https://supabase.com/docs/guides/auth/general-configuration)

然后在 **Authentication → Users** 中选择 **Add user → Create new user**，填写自己的邮箱和自己保管的密码，选择 **Auto Confirm User** 后创建。这里使用“创建用户”，不使用“Send invitation”；不需要发送邀请邮件。若控制台当前用词不同，选择直接填写密码、确认用户的创建方式，先核对再提交。

复制这个新账号的 **User UID**。回 SQL Editor 新建查询，把下面引号里的中文替换成刚复制的真实 UID，再运行：

```sql
insert into public.schedule_members(user_id, role)
values ('这里替换为真实Auth UID'::uuid, 'owner')
on conflict (user_id) do nothing;

select user_id, role from public.schedule_members;
```

查询结果中，自己的 UID 对应 `owner` 才完成站主初始化。没有“首位访客认领”功能，也不能只把邮箱写进网页源码来授予权限。若提示站主已经存在，先核对已有账号，不要删除或改写原站主来强行通过。

## 4. 配置网站地址与两个云端函数

### 网站与返回地址

在 Supabase **Authentication → URL Configuration** 中，将 **Site URL** 设为第 1 步复制的网站基址，含完整项目路径。将这个基址下的 `invitation.html` 加入允许的 Redirect URLs，使用精确地址，不用放开到任意网站。例如仓库名在路径中，就不能只填写 `https://用户名.github.io/`。[返回地址说明](https://supabase.com/docs/guides/auth/redirect-urls)

在 **Edge Functions → Secrets** 中添加自定义配置 `SITE_URL`，值也是同一个完整 HTTPS 网站基址，并以 `/` 结尾。它用于生成正确的邀请地址；不要把本地 `127.0.0.1` 地址填到线上。

### 直接用 Dashboard 部署

本包提供两个自包含函数，没有需要另外上传的 `_shared` 文件：

| 云端函数名称，必须完全一致 | 复制的本地文件 |
| --- | --- |
| `admin-access` | [`supabase/functions/admin-access/index.ts`](supabase/functions/admin-access/index.ts) |
| `accept-invitation` | [`supabase/functions/accept-invitation/index.ts`](supabase/functions/accept-invitation/index.ts) |

在 **Edge Functions** 选择 **Deploy a new function → Via Editor**，分别建立上表的函数，使用对应 `index.ts` 的完整内容替换示例代码，再点击 Deploy function。[Dashboard 部署说明](https://supabase.com/docs/guides/functions/quickstart-dashboard)

这两个函数的既定配置是 **`verify_jwt = false`**。用 Dashboard 部署时，按函数设置中的 Verify JWT 选项关闭平台这一层的 JWT 检查；本包 `supabase/config.toml` 已写好相同设置。函数内部仍会验证管理员 access token、站主身份或一次性邀请令牌，不能删掉这些检查。[函数配置说明](https://supabase.com/docs/guides/functions/function-configuration)

`SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY` 是托管 Edge Functions 内置的服务端变量，不需要把其值粘贴进函数源码。`service_role` 只留在受保护的函数运行环境，绝不能进入 `config.js` 或公开仓库。[函数环境变量](https://supabase.com/docs/guides/functions/secrets)

这套 Dashboard 操作不需要安装任何 CLI 或 Docker。如果维护者以后改用 CLI，远程 `functions deploy --use-api` 也可以不依赖 Docker；本地运行 `functions serve` 才需要 Docker。本教程不要求进行本地函数运行。[官方区别说明](https://supabase.com/docs/guides/functions/quickstart)

## 5. 填写两个公开配置值

在 Supabase 项目的 **Connect** 或 **Settings → API Keys** 找到项目 URL 和 publishable key。优先使用以 `sb_publishable_` 开头的公钥；旧项目的 `anon` 公钥也兼容，不要使用 `service_role` 或以 `sb_secret_` 开头的密钥。[公钥与私钥区别](https://supabase.com/docs/guides/getting-started/api-keys)

编辑本包 `config.js`，只填写现有的两个值，属性名不改：

| 属性 | 填写内容 |
| --- | --- |
| `supabaseUrl` | 自己的 Supabase 项目 HTTPS 地址，不是 GitHub Pages 地址，也不加 `/rest/v1` |
| `publishableKey` | 自己的 Supabase publishable 公钥；兼容旧 anon 公钥 |

保存后，在 GitHub 用网页编辑或重新上传同名 `config.js`，提交到 `main`，等待 Pages 更新。不要上传 `.env`、数据库密码、服务端私钥或私有备份。

公开仓库中的 `/admin/` 是页面外壳，任何人都能读取 HTML；实际排期数据读取、保存和授权由 Supabase 端的身份与数据库规则控制。公钥不等于管理员权限，隐藏页面地址也不等于权限保护。

## 6. 验证日常操作

从实际网站基址进入 `login.html`，用刚创建的站主邮箱密码登录，再进入基址下的 `admin/`：

1. 新增一条清楚标明测试的排期，保存成功后刷新公开页，确认内容一致。
2. 编辑一次，删除后在回收站恢复，确认每次只有成功提示后才生效。
3. 在权限管理页填编辑的邮箱，生成邀请链接。复制后自行交给本人；本包不自动发送邮件。
4. 对方用链接设置密码，之后以邮箱密码登录。邀请为一次性，期限由项目的 Email OTP Expiry 决定，不固定承诺 24 小时；过期可由站主重新生成。
5. 撤销该编辑权限后，对方应不能再保存排期或读取管理数据。编辑不能给自己或别人升为站主。

撤销权限不等于删除 Auth 账号；已经生成的 Auth 链接可能仍能验证账号，但不会恢复被撤销的排期管理权限。

## 7. 备份、升级与常见问题

日常数据保存在 Supabase，不写回 GitHub 文件。站主定期使用后台的“下载排期备份”，保存到自己的电脑；JSON 包含回收站记录，不含 Auth 密码或完整账号备份。公开日历只返回未删除条目，不能代替完整排期备份。升级前先备份，再更新网页文件；不要通过清空数据库或覆盖旧 seed 更新网站。

| 现象 | 先检查 |
| --- | --- |
| 首页只有原始排期，管理未启用 | `config.js` 两个值是否仍为空；空配置只是回退预览 |
| Pages 首页或管理页 404 | `index.html` 是否在仓库根，Pages 是否为 main + /(root)，管理地址是否保留仓库路径 |
| 登录成功但没有管理权限 | Auth 用户 UID 是否对应 `schedule_members` 中的 owner/editor |
| 邀请功能不可用 | 两个函数是否同名部署，`SITE_URL` 是否完整，函数配置是否按第 4 步设置 |
| 保存提示版本冲突 | 先保留未保存内容，再重新加载最新排期，不强行覆盖别人的修改 |
| Supabase 项目暂停 | 回 Supabase 控制台恢复项目，不用重新上传 GitHub 网站 |

本包的部署步骤按官网文档与代码契约整理；没有替你执行云端 SQL、创建 Auth 账号、发送邮件或验证正式网址。完成以上实际验证后，再把新网址对外分享。
