# Maltor 独立站（Cloudflare Workers + Resend）

域名 `maltor.xyz` 上的联系 / 询价落地页。访客填表单 → Cloudflare Worker → Resend 发邮件 → 你的收件箱。

- 后端：Cloudflare Workers（单个 JS 文件，无框架、无数据库）
- 发信：Resend HTTP API（`POST https://api.resend.com/emails`）
- 页面：纯静态 HTML，内联 CSS/JS，随 Worker 一起打包

## 目录结构

（项目文件直接放在仓库根目录，所有命令都在这一层执行）

```
./
├─ src/
│  ├─ index.js       # Worker 入口：路由 + 校验 + 调 Resend
│  └─ site.html      # 落地页 + 表单（文案都在这改）
├─ wrangler.toml     # 部署配置（名字、变量、自定义域）
├─ .dev.vars.example # 本地环境变量模板
└─ package.json
```

## 一、配置说明

打开 `wrangler.toml`，改 `[vars]`：

| 变量 | 说明 |
| --- | --- |
| `CONTACT_FROM` | 发件人，**必须是 Resend 里已验证域名下的地址**，例如 `Maltor <noreply@maltor.xyz>` |
| `CONTACT_TO` | 收件邮箱，当前已设为 `okwang1979@163.com`，要换人改这里 |
| `SITE_DOMAIN` | 本站主域 `maltor.xyz`。该域及其**所有子域**自动放行表单提交，加新子域不用改白名单 |
| `ALLOWED_ORIGINS` | 额外放行的来源（精确匹配），只用于本地开发地址 |

页面文案（标题、服务介绍、页脚邮箱）在 `src/site.html` 里直接改，改完重新部署即可。

## 二、本地跑起来

```bash
npm install                      # 只装 wrangler（装不上见文末常见问题）
cp .dev.vars.example .dev.vars   # 复制后填入真实 RESEND_API_KEY
npm run dev                      # 打开 http://localhost:8787
```

`npm run dev` 用的是本地模拟环境，但**会真的调 Resend 发信**，测试提交时邮件会真的进 `okwang1979@163.com`，别拿它压测。

## 三、部署上线

### 1. 登录 Cloudflare（只需一次）

```bash
npx wrangler login
```

会打开浏览器授权。如果 maltor.xyz 的 DNS 已经托管在 Cloudflare，选对应账号即可。

### 2. 写入 API Key（不进代码库）

```bash
npx wrangler secret put RESEND_API_KEY
# 粘贴你的 re_xxxx 开头的 Key，回车
```

Key 会以加密形式存在 Cloudflare，不会出现在 `wrangler.toml` 或 Git 里。查看：`npx wrangler secret list`。

### 3. 部署

```bash
npm run deploy
```

成功后会给出 `https://maltor-contact.<你的子域>.workers.dev`，先访问这个地址验证功能是否正常。

### 4. 自定义域名（已配好，通常不用再动）

`wrangler.toml` 末尾已经声明好了三个域名，`npm run deploy` 会自动创建 DNS 记录并签证书：

```
maltor.xyz           (custom domain)
www.maltor.xyz       (custom domain)
message.maltor.xyz   (custom domain)
```

> **重要：不要再到控制台手动加域名或路由。**
> `wrangler deploy` 会用 `wrangler.toml` 里的 `[[routes]]` **整份替换** Worker 的触发规则，配置里没写的会被删掉（手动加的白加）。要加新域名就写进 `wrangler.toml`，再加一行：
>
> ```toml
> [[routes]]
> pattern = "新子域.maltor.xyz"
> custom_domain = true
> ```
>
> 然后重新 `npm run deploy`。

> 前置条件：域名的 DNS 必须由 Cloudflare 托管。如果域名还在原注册商的 DNS 上，需要先在 Cloudflare 添加站点并按提示改 NS 记录，等生效后再绑。

## 四、上线后自检

```bash
# 1) 页面能打开
curl -I https://maltor.xyz

# 2) 接口通不通（故意不带 Origin，应返回 403，说明来源校验生效）
curl -X POST https://maltor.xyz/api/contact -H 'Content-Type: application/json' -d '{}'

# 3) 看实时日志
npm run tail
```

然后在页面上真实提交一次，确认邮箱收到邮件，并且**直接点回复**时收件人是访客邮箱（reply-to 已设置）。

## 五、已经做好的防护

| 措施 | 位置 |
| --- | --- |
| 来源校验（只接受自己域名提交） | `src/index.js` `handleContact` |
| 蜜罐字段 `website`，机器人填了就静默丢弃 | `src/index.js` + `site.html` 隐藏 input |
| 字段长度 / 邮箱格式 / 描述最少 10 字校验 | `validate()` |
| 同 IP 10 分钟最多 5 次提交 | `rateLimited()` |
| 邮件内容 HTML 转义，防注入 | `esc()` |
| CSP、X-Frame-Options 等安全响应头 | `SECURITY_HEADERS`（**`connect-src 'self'` 不能漏**，见常见问题） |

关于限流的说明：Workers 每个实例内存独立，这个计数是"尽力而为"的软限制。如果被扫得厉害，去 Cloudflare 控制台配置 WAF Rate limiting 规则（对 `/api/contact` 限流），那是硬限制。

## 六、常见问题

**部署成功了，但 `xxx.workers.dev` 打不开（ERR_CONNECTION_TIMED_OUT）**：正常现象，不是部署失败。`*.workers.dev` 在大陆被 DNS 污染（会解析到 Facebook 的 IP 段），必须走自定义域名。本项目已绑定 `maltor.xyz` / `www.maltor.xyz`，用这两个域名访问。

**绑了自定义域名还是打不开**：多数是本机 / 运营商 DNS 还没同步。

```bash
nslookup maltor.xyz 223.5.5.5   # 用公共 DNS 查，能返回 104.21.x / 172.67.x 就说明服务器端没问题
ipconfig /flushdns              # 刷新本机缓存
```

还是不行就把电脑的 DNS 改成 `223.5.5.5`（阿里）或 `119.29.29.29`（腾讯），或者用手机流量试一下。电信默认的 IPv6 DNS 同步这个域名有时要等几小时。

**Cloudflare 里需要手动加 DNS 记录吗**：不需要。`wrangler.toml` 里写了 `custom_domain = true` 并 deploy 后，Cloudflare 会自动在 `maltor.xyz` 这个 zone 里建好记录并签证书（记录类型显示为 Workers 类型、开启代理）。手动重复添加反而会冲突。

**表单提交提示"网络异常，请稍后再试"**：页面本身能打开、但点提交没反应，先看浏览器控制台（F12 / 手机端可用 chrome://inspect）。最典型的两个原因：

1. **CSP 少了 `connect-src`** —— `connect-src` 没写时会回退到 `default-src`，而 `default-src 'none'` 会把页面里所有 `fetch()` 直接封杀。本项目已在 `SECURITY_HEADERS` 里声明 `connect-src 'self'`，改 CSP 时务必保留。
2. **控制台出现 `static.cloudflareinsights.com` 被拦截的报错** —— 这是 Cloudflare 自动注入的访问统计脚本（beacon.min.js），**不影响任何功能**，只影响你看不到访问量统计。本项目已在其 CSP 的 `script-src` 放行 `https://static.cloudflareinsights.com`、`connect-src` 放行 `https://cloudflareinsights.com`，正常情况下不会再报。

**收不到邮件**：先看 `npm run tail` 的日志。常见原因是 `CONTACT_FROM` 用了未验证的域名（Resend 返回 403/422）。Resend 控制台 → Domains 里确认 `maltor.xyz` 状态是 Verified，SPF/DKIM 都已打勾。

**本地测试想不验证域名**：把 `.dev.vars` 里的 `CONTACT_FROM` 改成 `Maltor <onboarding@resend.dev>`，这是 Resend 提供的测试发件人，但只能发到你注册 Resend 时用的那个邮箱。

**加急方案**：页面底部有邮件地址，接口挂了访客还能直接发邮件。

**`npm install` 报 `esbuild ... EBUSY` 或 `workerd` 二进制找不到**：esbuild 的安装脚本在这台机器上起不了子进程。绕过去就行（已实测可用）：

```bash
npm install --ignore-scripts
npm install @esbuild/win32-x64 --no-save --ignore-scripts
npm install @cloudflare/workerd-windows-64 --no-save --ignore-scripts
```

版本号要跟 `node_modules/esbuild/package.json`、`node_modules/workerd/package.json` 里的 version 对上，不确定就先 `node -p "require('./node_modules/esbuild/package.json').version"` 看一下。

## 七、下一步可以加

- 提交记录落库：Cloudflare KV 或 D1（当前不存，出问题只能靠邮件回溯）
- 自动回复：Resend 发一封"已收到"确认邮件给访客（注意别做成垃圾邮件，纯通知可以）
- 数据看板：D1 + 简单后台看提交量
