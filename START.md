# 晶莹的舞台：GitHub 免费上线教程

核实日期：2026 年 10 月 31 日。这次使用 **GitHub Pages 放网页、Supabase 保存在线排期和账号权限**。不需要 GitHub 插件，不需要先买服务器或域名。

## 现在先注册 Supabase

你已经有 GitHub 账号，可以先打开 [Supabase](https://supabase.com/dashboard)，按页面提示注册、登录。进入 Dashboard 后先停住；项目、数据库和站主账号可以在后续步骤逐一配置。先使用 Free 方案，不用购买域名或付费套餐。

Supabase 登录账号用于管理数据库服务；以后网站后台的站主账号会单独创建。密码、数据库密码和私钥都自己保管，不要发到聊天里。

## 接着准备一个公开仓库

1. 打开 [GitHub](https://github.com)，登录已有账号，确认邮箱已经验证。
2. 点击右上角 **＋ → New repository**，或使用 GitHub 的新建仓库入口。
3. 仓库名可以填 `jingying-stage`，可见性选 **Public**，勾选添加 README，再点击 **Create repository**。
4. 记下自己的用户名和仓库名，先停在仓库首页。不需要安装插件，也不用输入终端命令。

GitHub Free 支持公开仓库的 Pages。公开的是网页源代码，因此之后只上传准备好的 `github-pages-site` 文件夹内容，不上传桌面上的整个项目、数据库、密码或私有备份。[GitHub 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## 接下来分次完成

1. 在 [Supabase](https://supabase.com/dashboard) 创建 Free 项目，按顺序初始化数据库、创建自己的站主账号。
2. 在本地 `config.js` 只填项目地址和 **publishable 公钥**；兼容旧项目的 `anon` 公钥。不要填 `service_role` 或 `secret` 密钥。
3. 在 GitHub 网页上传准备好的网站文件，启用 **Settings → Pages → Deploy from a branch → main → /(root)**。
4. 用自己的邮箱密码登录新站后台，再测试一次新增、保存和回收站恢复。

每一步的具体操作见 [安装包 README](README.md)。GitHub 支持直接从浏览器上传文件或文件夹，无需命令行。[上传说明](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)、[Pages 设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

最终网址格式是 `https://你的用户名.github.io/仓库名/`。它包含仓库名这一段；Supabase 的网站地址和邀请返回地址也必须保留这段路径。这里只展示格式，实际网址以上线后的 Pages 页面为准。

## 网页公开，修改权限单独保护

公开日历可以让大家查看；登录、排期保存和编辑授权由 Supabase Auth 与数据库规则控制。别人即使打开 `/admin/` 或查看网页源码，也不会因此获得编辑权限。站主由你在 Supabase 控制台明确创建并赋权，没有“第一个访问网站的人自动当站主”的流程。

网站登录使用自己的邮箱密码，不依赖 ChatGPT 登录。新增、编辑和删除排期在网页表单里完成；只有站主可以邀请或撤销其他编辑。

## “免费”的范围

GitHub Pages 采用免费公开仓库；Supabase Free 当前为 **0 美元/月，受免费配额限制**。Supabase 项目在一周内活动不足时可能暂停，需要你回控制台恢复，因此不能承诺永久免费、无限流量或始终在线。[Supabase 价格](https://supabase.com/pricing)、[暂停规则](https://supabase.com/docs/guides/platform/free-project-pausing)

安装包带的 84 条初始排期是原表回退数据，不自动代表旧站线上最新版本。如果旧站已经有在线修改，迁移前先保留最新排期备份。当前还没有替你创建仓库、配置 Supabase 或发布新站。
