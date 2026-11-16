# 宝塔面板（Baota / aaPanel）部署指南

本文以 `mydsh.zhengl.vip` 为例，从零把 `mydsh-relay` 部到一台全新的云服务器上。
照着做即可，不需要事先懂 Node 或 nginx。

**目录**

1. [部署前准备](#一部署前准备)
2. [上传代码](#二上传代码)
3. [安装 Node 并跑起来](#三安装-node-并跑起来)
4. [配置 nginx 反向代理（关键：WebSocket）](#四配置-nginx-反向代理关键websocket)
5. [申请 Let's Encrypt 证书](#五申请-lets-encrypt-证书)
6. [用 systemd 守护（推荐）](#六用-systemd-守护推荐)
7. [用 pm2 守护（备选）](#七用-pm2-守护备选)
8. [域名解析配置](#八域名解析配置)
9. [上线后的自检清单](#九上线后的自检清单)
10. [日志与排障](#十日志与排障)
11. [升级与回滚](#十一升级与回滚)
12. [常见问题](#十二常见问题)

---

## 一、部署前准备

### 1.1 需要什么

| 东西 | 要求 |
|---|---|
| 服务器 | 1 核 1G 就够（本服务几乎不占资源）；系统 CentOS 7+ / Ubuntu 20.04+ / Debian 11+ |
| 域名 | 一个可以改 DNS 的域名，本文用 `mydsh.zhengl.vip` |
| 宝塔面板 | 已安装并能登录（[bt.cn](https://www.bt.cn/) / [aapanel.com](https://www.aapanel.com/)） |
| Node.js | **≥ 20.11**，推荐 22 LTS 或更高 |
| 端口 | 443 与 80 放行 |

### 1.2 需要放行的端口

宝塔面板 → **安全**，放行：

- `80`（HTTP，用于 Let's Encrypt 验证 + 跳转）
- `443`（HTTPS）
- **不需要**放行 `8787`。那是 Node 的内部端口，只让 nginx 从本机访问。

如果你在云厂商控制台（阿里云/腾讯云安全组）也有防火墙，那里也要放行 80/443。

### 1.3 检查 Node 版本

宝塔面板 → **软件商店** → 搜索 **Node.js 版本管理器** → 安装。

装好后在 **终端** 里确认：

```bash
node -v
# 期望 v20.11.0 或更高，例如 v22.x / v24.x
```

如果低于 20.11，请在 Node 版本管理器里安装 22 LTS 并在项目设置里选中它。

> 宝塔的 Node 管理器通常把 node 装在 `/www/server/nodejs/vXX.XX.X/bin/node`。
> 后面写 systemd 服务时要用**绝对路径**，可以用 `which node` 查。

---

## 二、上传代码

### 2.1 建目录

宝塔 → **文件** → 进入 `/www/wwwroot/` → 新建目录 `mydsh-relay`。

最终路径是：

```text
/www/wwwroot/mydsh-relay/
├── package.json
├── relay.config.json        ← 待会自己创建
├── src/
│   ├── server.js
│   ├── websocket.js
│   ├── auth.js
│   ├── users.js
│   ├── tunnel.js
│   ├── static.js
│   └── util.js
├── README.md
└── deploy.md
```

### 2.2 上传

宝塔 → **文件** → 进入 `/www/wwwroot/mydsh-relay/` → **上传**，
把 `mydsh-relay` 里的所有文件传上去（保持 `src/` 目录结构）。

或者用终端 + git/scp 也行。上传后确认 `src/server.js` 存在：

```bash
cd /www/wwwroot/mydsh-relay
ls -l src/
```

> **注意**：本项目**零依赖**，不需要执行 `npm install`。
> 如果你习惯性执行了，它也不会装任何东西，无害。

---

## 三、安装 Node 并跑起来

### 3.1 创建配置文件

在 `/www/wwwroot/mydsh-relay/` 下新建 `relay.config.json`（复制模板改）：

```bash
cd /www/wwwroot/mydsh-relay
cp relay.config.example.json relay.config.json
```

用宝塔的文件编辑器打开 `relay.config.json`，**至少改这三处**：

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "tls": {
    "enabled": false,
    "certPath": "",
    "keyPath": ""
  },
  "domain": "mydsh.zhengl.vip",
  "publicUrl": "https://mydsh.zhengl.vip"
}
```

**为什么这样改：**

- `listen.host` 改成 `127.0.0.1`：只让本机的 nginx 访问，外网无法直连 8787。
  如果填 `0.0.0.0`，攻击者可以绕过 nginx 直接打你的 Node，HTTPS 保护就形同虚设。
- `tls.enabled` 保持 `false`：HTTPS 由 nginx 终结（下面第四节配）。
  Node 和 nginx **不要同时**做 TLS。
- `domain` / `publicUrl`：必须是你真实的域名，否则 Origin 校验会误杀。

### 3.2 生成签名密钥

```bash
cd /www/wwwroot/mydsh-relay
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

把输出复制下来（一长串），稍后写进环境变量。**不要写进配置文件**，
避免跟着代码一起被备份/泄露。

> 如果跳过这步也行：不配置密钥时，程序首次启动会自动在 `data/signing.key`
> 生成一个（权限 600）。但显式用环境变量更安全，也便于换机器。

### 3.3 先手工跑一次

```bash
cd /www/wwwroot/mydsh-relay
MYDSH_RELAY_TOKEN_SECRET='把刚才生成的密钥粘这里' node src/server.js
```

看到类似输出就对了：

```text
2026-11-15T14:15:54.669Z INFO  [server] 已生成新的 token 签名密钥 {"file":"..."}
2026-11-15T14:15:54.677Z INFO  [users] 用户库不存在，已初始化空库
2026-11-15T14:15:54.715Z INFO  [server] mydsh-relay 已启动 {"scheme":"http","listen":"127.0.0.1:8787",...}
2026-11-15T14:15:54.719Z WARN  [server] 当前未启用 TLS。若本服务直接对公网暴露，请务必让 nginx/宝塔面板在前面做 HTTPS 终止
```

新开一个终端验证：

```bash
curl -s http://127.0.0.1:8787/api/health
# {"ok":true,"service":"mydsh-relay",...}
```

**验证成功后按 `Ctrl+C` 停掉**，接下来交给守护进程。

> 那条 TLS 的 WARN 是**正常的**——因为你确实要让 nginx 做 TLS。
> 只有当你把 8787 直接暴露到公网时才需要担心它。

---

## 四、配置 nginx 反向代理（关键：WebSocket）

这一步最容易出错。**90% 的「连不上」都是这里配错了。**

### 4.1 新建站点

宝塔 → **网站** → **添加站点**：

| 项 | 值 |
|---|---|
| 域名 | `mydsh.zhengl.vip` |
| 根目录 | 随便（如 `/www/wwwroot/mydsh.zhengl.vip`，不会用到） |
| FTP | 不创建 |
| 数据库 | 不创建 |
| PHP 版本 | **纯静态** |

### 4.2 设置反向代理

宝塔 → **网站** → 点 `mydsh.zhengl.vip` → **反向代理** → **添加反向代理**：

| 项 | 值 |
|---|---|
| 代理名称 | `mydsh-relay` |
| 目标 URL | `http://127.0.0.1:8787` |
| 发送域名 | `$host` |

添加后，宝塔会生成一个配置文件，通常是：

```text
/www/server/panel/vhost/nginx/proxy/mydsh.zhengl.vip/mydsh-relay.conf
```

### 4.3 改成支持 WebSocket 的配置

点该代理右侧的 **配置文件**，或者直接用文件管理器打开上面那个路径，
把内容**整体替换**成：

```nginx
# ── 反代到本机 Node ────────────────────────────────────────────
location ^~ / {
    proxy_pass http://127.0.0.1:8787;

    proxy_http_version 1.1;

    # ↓↓↓ 这三行是 WebSocket 能不能用的关键 ↓↓↓
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    # ↑↑↑ 少了 Upgrade/Connection，握手永远是 400 ↑↑↑

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;

    # 不缓冲：DSH 的流式输出（SSE / 逐字返回）需要立刻到达浏览器
    proxy_buffering off;
    proxy_cache off;
    proxy_request_buffering off;

    # 长连接必须放宽超时，否则 WebSocket 会在 60 秒后被 nginx 掐断
    proxy_connect_timeout 30s;
    proxy_send_timeout    3600s;
    proxy_read_timeout    3600s;

    # 允许大文件上传（比如往 DSH 里传附件）
    client_max_body_size 100m;
}
```

保存后点 **重载 nginx**（宝塔通常会自动 reload，改完看下右上角有没有报错）。

### 4.4 逐项解释（知道为什么才不会配错）

| 指令 | 为什么必须 |
|---|---|
| `proxy_http_version 1.1` | HTTP/1.0 不支持 `Upgrade` 机制，WebSocket 握手必失败。**最常漏的一条**。 |
| `proxy_set_header Upgrade $http_upgrade` | 把浏览器的 `Upgrade: websocket` 透传给 Node。不透传 → Node 收到的请求不是升级请求 → 返回 426。 |
| `proxy_set_header Connection "upgrade"` | 同上。注意这里是**固定字符串** `"upgrade"`，不是变量。 |
| `proxy_set_header Host $host` | 让 Node 看到真实域名，否则 Origin / Host 校验和 cookie 域名都会错。 |
| `X-Real-IP` / `X-Forwarded-For` | 让 Node 拿到访客真实 IP。配合配置里的 `security.trustProxy: true` 使用，否则限流和 IP 白名单全部按 `127.0.0.1` 算，等于失效。 |
| `X-Forwarded-Proto $scheme` | 让 Node 知道外部是 HTTPS，用于生成正确的 cookie `Secure` 属性。 |
| `proxy_buffering off` | 不关的话 nginx 会攒够 buffer 才发给浏览器，DSH 的逐字输出会变成「卡很久然后一次性出现」。 |
| `proxy_read_timeout 3600s` | 默认 60s。WebSocket 空闲 60 秒就被断开，表现为「页面放着不动就掉线」。 |

### 4.5 验证反代是否生效

```bash
# 走域名访问健康检查
curl -s https://mydsh.zhengl.vip/api/health
```

如果还没配证书，先用 HTTP 试：

```bash
curl -s http://mydsh.zhengl.vip/api/health
```

返回 JSON 就说明反代通了。此时浏览器打开域名应该能看到首页。

---

## 五、申请 Let's Encrypt 证书

### 5.1 一键申请

宝塔 → **网站** → 点 `mydsh.zhengl.vip` → **SSL** → **Let's Encrypt**：

1. 勾选 `mydsh.zhengl.vip`（如果同时要用 `www`，一起勾上）
2. 验证方式选 **文件验证**
3. 点 **申请**

申请成功后，宝塔会自动：

- 把证书存到 `/www/server/panel/vhost/cert/mydsh.zhengl.vip/`
  - `fullchain.pem` — 证书链
  - `privkey.pem` — 私钥
- 在 nginx 站点配置里加上 `listen 443 ssl` 与证书路径
- 加一条把 HTTP 跳到 HTTPS 的规则（如果你勾了「强制 HTTPS」）

### 5.2 确认证书生效

```bash
curl -sI https://mydsh.zhengl.vip/api/health | head -3
```

期望：

```text
HTTP/2 200
```

### 5.3 开启强制 HTTPS

宝塔 → 网站 → 该站点 → **SSL** → 打开 **强制 HTTPS**。

这一步不是可选的。明文 HTTP 传输会把用户密码、会话 token 和设备密钥
完整暴露给链路上的任何人。

### 5.4 证书自动续期

宝塔默认会为 Let's Encrypt 证书配置自动续期任务。检查一下：

宝塔 → **计划任务**，应该有一条类似「续签 Let's Encrypt 证书」的任务，状态正常即可。

手动测试续期（不会真的换证书，只是试跑）：

```bash
/www/server/panel/pyenv/bin/python3 /www/server/panel/class/panelLetsencrypt.py --test 2>/dev/null || echo "用面板界面点『续签』即可"
```

### 5.5 如果打算让 Node 自己终结 TLS

一般**不需要**（nginx 做更省事）。如果你确实想让 Node 直接开 HTTPS：

1. nginx 那条反代要改成 `proxy_pass https://127.0.0.1:8787;`（并加 `proxy_ssl_verify off;`）
2. `relay.config.json` 里：

```json
"tls": {
  "enabled": true,
  "certPath": "/www/server/panel/vhost/cert/mydsh.zhengl.vip/fullchain.pem",
  "keyPath": "/www/server/panel/vhost/cert/mydsh.zhengl.vip/privkey.pem"
}
```

3. 证书续期后 Node 不会自动重载，需要 `systemctl restart mydsh-relay`。
   **这就是推荐用 nginx 做 TLS 的原因** —— nginx reload 是无损的，Node 重启会踢掉所有隧道。

---

## 六、用 systemd 守护（推荐）

### 6.1 确定 node 路径

```bash
which node
# 例如 /www/server/nodejs/v22.11.0/bin/node
```

**记住这个路径**，下面要用绝对路径。

### 6.2 建专用用户（可选但推荐）

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin mydsh || true
chown -R mydsh:mydsh /www/wwwroot/mydsh-relay
```

### 6.3 写 service 文件

新建 `/etc/systemd/system/mydsh-relay.service`：

```ini
[Unit]
Description=mydsh-relay (DeepSeek Harness 中转服务)
Documentation=file:///www/wwwroot/mydsh-relay/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mydsh
Group=mydsh
WorkingDirectory=/www/wwwroot/mydsh-relay

# 环境变量：签名密钥必须在这里注入，不要写进配置文件
Environment=NODE_ENV=production
Environment=MYDSH_RELAY_CONFIG=/www/wwwroot/mydsh-relay/relay.config.json
Environment=MYDSH_RELAY_TOKEN_SECRET=把第三节能生成的密钥粘这里
Environment=MYDSH_RELAY_LOG_LEVEL=info

ExecStart=/www/server/nodejs/v22.11.0/bin/node /www/wwwroot/mydsh-relay/src/server.js
Restart=always
RestartSec=3
# 最多 5 分钟内重启 10 次，超过就放弃（避免死循环刷日志）
StartLimitIntervalSec=300
StartLimitBurst=10

# 优雅退出：先 SIGTERM（程序会在 15 秒内自行清理并落盘）
KillSignal=SIGTERM
TimeoutStopSec=20

# ── 安全加固 ──
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
# 只允许写数据目录
ReadWritePaths=/www/wwwroot/mydsh-relay/data

# 日志走 journald，用 journalctl 看
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mydsh-relay

[Install]
WantedBy=multi-user.target
```

> **两个容易踩的坑**：
> 1. `ExecStart` 的 node 路径**必须是绝对路径**。systemd 的 PATH 很精简，
>    写 `node` 会报 `command not found`。
> 2. 如果没建 `mydsh` 用户，就把 `User=`/`Group=` 两行改成 `root`（能用但不够安全）。

### 6.4 启动

```bash
systemctl daemon-reload
systemctl enable --now mydsh-relay
systemctl status mydsh-relay --no-pager
```

看到 `Active: active (running)` 就成功了。

### 6.5 验证

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s https://mydsh.zhengl.vip/api/health
```

两条都返回 JSON → 全部打通。

---

## 七、用 pm2 守护（备选）

不喜欢 systemd 就用 pm2。宝塔的 Node 项目管理器底层也是 pm2。

### 7.1 安装 pm2

```bash
npm install -g pm2
```

### 7.2 启动

```bash
cd /www/wwwroot/mydsh-relay
MYDSH_RELAY_TOKEN_SECRET='你的密钥' \
pm2 start src/server.js \
  --name mydsh-relay \
  --time \
  --max-memory-restart 300M
```

### 7.3 保存并开机自启

```bash
pm2 save
pm2 startup systemd
# 按提示复制粘贴它输出的那一条 sudo 命令再执行
```

### 7.4 常用命令

```bash
pm2 list                      # 列表
pm2 logs mydsh-relay          # 实时日志
pm2 logs mydsh-relay --lines 200   # 最近 200 行
pm2 restart mydsh-relay       # 重启
pm2 stop mydsh-relay
pm2 delete mydsh-relay
pm2 monit                     # CPU/内存监控
```

> pm2 的日志在 `~/.pm2/logs/mydsh-relay-out.log` / `-error.log`。
> 宝塔还提供 **Node 项目** 图形化管理，本质也是 pm2，两条路选一条即可，
> **不要同时用 systemd 和 pm2 管同一个进程**（会端口冲突）。

---

## 八、域名解析配置

在你的域名服务商（阿里云/DNSPod/Cloudflare…）添加一条 A 记录：

| 记录类型 | 主机记录 | 记录值 | TTL |
|---|---|---|---|
| `A` | `mydsh` | `你的服务器公网 IP` | 600 |

如果要同时用 `www.mydsh.zhengl.vip`：

| 记录类型 | 主机记录 | 记录值 | TTL |
|---|---|---|---|
| `A` | `www.mydsh` | `你的服务器公网 IP` | 600 |

如果服务器有 IPv6，再加一条 `AAAA` 记录指向 IPv6 地址。

### 8.1 验证解析

```bash
ping mydsh.zhengl.vip -c 3
# 或
nslookup mydsh.zhengl.vip
```

返回的 IP 必须是你的服务器 IP。

> 解析生效通常 1-10 分钟（TTL 600 秒）。**在解析生效之前，Let's Encrypt
> 的文件验证会失败**，所以顺序是：先配解析 → 等几分钟 → 再申请证书。

### 8.2 如果用 Cloudflare

- 代理状态（橙色云）**可以开**，但要：
  - SSL/TLS 模式设为 **Full (strict)**，不要用 Flexible（会无限重定向）
  - 确认 WebSocket 是开启的（Cloudflare 默认开，Network → WebSockets）
- 或者先设成 **DNS only**（灰色云）拿证书，拿到后再开代理，避免验证失败。

---

## 九、上线后的自检清单

逐条打勾，**全部通过再开始用**：

- [ ] `curl -s https://mydsh.zhengl.vip/api/health` 返回 `{"ok":true,...}`
- [ ] 浏览器打开 `https://mydsh.zhengl.vip/` 能看到首页，地址栏是锁图标
- [ ] `http://mydsh.zhengl.vip/` 会自动跳到 `https://`
- [ ] 能注册账号、能登录、能看到「设备管理」页
- [ ] 创建一台设备，**能复制到 deviceId 和 deviceSecret**
- [ ] 在 DSH 里装好 `dsh-mydsh` 插件，填入上面两项，**设备页显示「在线」**
- [ ] 访问 `https://mydsh.zhengl.vip/d/<deviceId>/` 能打开内网的 DSH 界面
- [ ] DSH 里能正常对话（说明流式响应没被 nginx 缓冲）
- [ ] 页面放 5 分钟不动，回来还能用（说明没被 nginx 超时掐断）
- [ ] 服务器重启后（`reboot`）服务能自动起来，设备能自动重连
- [ ] **已关闭公开注册**（`auth.allowRegistration: false`），或已设置邀请码
- [ ] `ls -l /www/wwwroot/mydsh-relay/data/` 显示 `-rw-------`（600 权限）

### 9.1 关闭公开注册

上线并建好自己的账号后，强烈建议关闭注册：

```bash
cd /www/wwwroot/mydsh-relay
# 编辑 relay.config.json，把 auth.allowRegistration 改成 false
```

```json
"auth": {
  "allowRegistration": false,
  "maxUsers": 5
}
```

然后重启：

```bash
systemctl restart mydsh-relay
# 或 pm2 restart mydsh-relay
```

> 关闭注册后仍然可以登录，只是不能再自助注册。
> 需要加人时：临时改回 `true` → 重启 → 注册 → 再改回 `false` → 重启。
> 或者直接把 `inviteCode` 设成一个长随机串，只发给要邀请的人。

---

## 十、日志与排障

### 10.1 看日志

**systemd：**

```bash
journalctl -u mydsh-relay -f              # 实时跟踪
journalctl -u mydsh-relay -n 200 --no-pager   # 最近 200 行
journalctl -u mydsh-relay --since '10 min ago'
journalctl -u mydsh-relay -p err          # 只看错误
```

**pm2：**

```bash
pm2 logs mydsh-relay
pm2 logs mydsh-relay --lines 200 --nostream
```

### 10.2 日志长什么样

```text
2026-11-15T14:15:54.715Z INFO  [server] mydsh-relay 已启动 {"scheme":"http","listen":"127.0.0.1:8787","users":1}
2026-11-15T14:16:02.001Z INFO  [auth] 登录成功 {"userId":"u_xxx","jti":"t_yyy","ip":"1.2.3.4"}
2026-11-15T14:16:10.220Z INFO  [tunnel] 设备已上线 {"deviceId":"d_abc123","ip":"1.2.3.4","userId":"u_xxx"}
2026-11-15T14:16:15.900Z INFO  [tunnel] 访客 WS 已配对 {"deviceId":"d_abc123","ip":"5.6.7.8","qs":0}
```

敏感字段会被自动替换成 `[redacted]`，所以日志可以相对放心地留着。

### 10.3 WebSocket 连不上（最常见）

**症状**：浏览器控制台报

```text
WebSocket connection to 'wss://mydsh.zhengl.vip/d/xxx/' failed
```

**排查顺序：**

1. **确认 nginx 配了三条关键指令**（第四节 4.4）：
   ```bash
   grep -nE 'proxy_http_version|Upgrade|Connection' \
     /www/server/panel/vhost/nginx/proxy/mydsh.zhengl.vip/mydsh-relay.conf
   ```
   应该能看到 `proxy_http_version 1.1`、`Upgrade $http_upgrade`、`Connection "upgrade"`。

2. **绕过 nginx 直连 Node 试**：
   ```bash
   # 在服务器上跑
   curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" \
        -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        http://127.0.0.1:8787/tunnel
   ```
   - 返回 `403`（缺凭据）→ **Node 是好的**，问题在 nginx。
   - 连不上 → Node 没在跑，`systemctl status mydsh-relay` 看看。

3. **看 nginx 错误日志**：
   ```bash
   tail -50 /www/wwwlogs/mydsh.zhengl.vip.error.log
   ```

4. **检查宝塔有没有覆盖你的配置**。宝塔的代理配置在
   `/www/server/panel/vhost/nginx/proxy/` 下，而站点主配置
   `/www/server/panel/vhost/nginx/mydsh.zhengl.vip.conf` 里用 `include` 引入它。
   如果你改错了文件，会被下一次面板操作覆盖。

### 10.4 设备一直显示「离线」

**症状**：插件端报连接失败，或设备页一直显示灰点。

```bash
journalctl -u mydsh-relay -n 100 --no-pager | grep -E '设备|tunnel|403'
```

| 日志 | 原因 | 处置 |
|---|---|---|
| `设备鉴权失败：bad-secret` | `deviceSecret` 填错了 | 在设备页「换密钥」重新填 |
| `设备鉴权失败：unknown-device` | `deviceId` 填错了，或设备被删了 | 核对 deviceId |
| `设备鉴权失败：revoked` | 设备被吊销 | 重新注册设备 |
| `设备隧道连接被拒绝 … IP 不在白名单` | 配了 IP 白名单但插件出口 IP 不在里面 | 去掉白名单或加 IP |
| （完全没有日志） | 插件根本没连上来 | 检查插件配置里的中转地址与网络 |

### 10.5 所有访客 IP 都是 127.0.0.1

```bash
journalctl -u mydsh-relay -n 50 | grep '访客 WS'
# {"ip":"127.0.0.1"} ← 不对
```

原因：`security.trustProxy` 是 `false`，或 nginx 没传 `X-Forwarded-For`。

处置：配置里设 `trustProxy: true`，并确认 nginx 有 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`。

### 10.6 502 / 504

```bash
journalctl -u mydsh-relay -n 100 | grep -E '500|502|504|超时'
```

- `内网设备响应超时`（504）→ 内网 DSH 太慢或挂了。调大 `tunnel.httpTimeoutMs`，
  或检查内网那台机器的 DSH 是否在跑。
- `设备连接已断开`（502）→ 插件掉线了。看重连日志。

### 10.7 登录一直 429

触发了指数退避锁定。这是**故意**的，防止爆破。

- 等锁定结束（首次 30 秒，最长 1 小时，每多失败一次翻倍）
- 或重启服务更快（限流是内存态，重启即清空）：
  ```bash
  systemctl restart mydsh-relay
  ```

### 10.8 端口被占用

```bash
ss -lntp | grep 8787
```

如果被别的程序占了，改 `relay.config.json` 的 `listen.port`，
同时记得同步改 nginx 的 `proxy_pass` 端口。

---

## 十一、升级与回滚

### 11.1 升级

```bash
# 1) 备份数据和代码
cd /www/wwwroot
tar czf /www/backup/mydsh-relay-$(date +%F).tar.gz mydsh-relay

# 2) 停服
systemctl stop mydsh-relay      # 或 pm2 stop mydsh-relay

# 3) 替换代码（保留 relay.config.json 和 data/）
#    上传新代码 → 覆盖 src/ 和 package.json

# 4) 起服
systemctl start mydsh-relay

# 5) 验证
curl -s http://127.0.0.1:8787/api/health
```

**注意**：`data/users.json` 的 `version` 字段如果和新版本期望的不一致，
新版本会**拒绝启动**并给出明确错误（而不是悄悄写坏数据）。这是刻意的保护。
遇到这种情况先备份 `data/`，再按新版本的迁移说明操作。

### 11.2 回滚

```bash
systemctl stop mydsh-relay
cd /www/wwwroot
rm -rf mydsh-relay.bak
mv mydsh-relay mydsh-relay.bak
tar xzf /www/backup/mydsh-relay-2026-11-15.tar.gz
systemctl start mydsh-relay
```

### 11.3 换服务器

要带走的是三样：

1. `relay.config.json`
2. `data/`（整个目录：`users.json` + `signing.key`）
3. systemd service 文件里的 `MYDSH_RELAY_TOKEN_SECRET`

**`signing.key` 或 `TOKEN_SECRET` 必须一起带走**，否则所有用户会被强制重新登录，
而且已经填好的插件配置（如果依赖 token）也会失效。

---

## 十二、常见问题

**Q：必须用宝塔吗？**
A：不必。任何能跑 Node + nginx 的环境都行。核心只有两条：Node 跑在
`127.0.0.1:8787`，nginx 反代并转发 `Upgrade`/`Connection` 头。

**Q：能不能不装 nginx，让 Node 直接对公网提供 HTTPS？**
A：能（`tls.enabled: true` + 证书路径），但不推荐：证书续期后要重启 Node，
会踢掉所有隧道；而且少了 nginx 的限流、防慢速攻击等保护。

**Q：需要 `npm install` 吗？**
A：**不需要**。本项目零依赖，只用 Node 内置模块。执行了也无害（装 0 个包）。

**Q：Node 版本能低一点吗？**
A：不能。代码用了 Node 20+ 的特性（如 `node:buffer` 的 `isUtf8` 需要 18.14+，
`structuredClone`、`??=` 等），`package.json` 声明 `>=20.11`。

**Q：一个中转能给多少台设备用？**
A：单用户默认 5 台（`limits.maxDevicesPerUser`），单个设备默认 32 个并发通道
（`tunnel.maxChannelsPerDevice`）。都可在配置里调。

**Q：data 目录能删吗？**
A：**不能**。删了 `users.json` = 所有账号和设备没了；删了 `signing.key` =
所有会话立刻失效（但账号还在）。

**Q：怎么彻底重置？**
A：停服 → `rm -rf data/` → 起服。会重新生成密钥和空用户库，等于恢复出厂。

**Q：日志会占满磁盘吗？**
A：systemd 的 journald 默认有容量上限（通常 4G 或系统的 10%），会自动轮转。
pm2 的日志**不会**自动轮转，需要 `pm2 install pm2-logrotate`。

**Q：能不能只让某几个 IP 访问？**
A：能。`security.globalIpAllowlist` 填 CIDR，例如
`["1.2.3.4/32", "10.0.0.0/8"]`。空数组 = 不限制。这层限制同时作用于
HTTP 和 WebSocket 升级请求。

**Q：访客需要登录吗？**
A：默认不需要（`security.visitorRequireAuth: false`），任何人拿到
`/d/<deviceId>/` 链接就能访问。如果你想让只有自己账号能看，
设为 `true`（此时访客必须登录，且必须是该设备的所有者）。
