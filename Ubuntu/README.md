# 序列号后台（btkey_html_admin）Ubuntu 部署教程（SQLite 版）

> 数据层已从「Cloudflare KV」换成和 `wxminiapp-server` 一样的 **SQLite**：
> 一行一个号，占号是 `UPDATE … RETURNING`，并发下不会把同一个号发给两个人。
> `workers.js` 的业务代码（后台页面、增删改、导出）不用动，靠 `store.mjs` 把 KV 接口映射到 SQL 表。
>
> 后台已内置 **💾 备份 / 恢复**（导出全部数据+配置、导入还原），见第十节。

---

## 一、和 Cloudflare 版的区别

| Cloudflare 上是什么 | Ubuntu 上换成什么 | 文件 |
|---|---|---|
| Worker 运行时 | `node --experimental-sqlite server.mjs` | `server.mjs` |
| KV 绑定 `bt_KV` | **SQLite 表**（`serials` / `categories` / `claims` / …）+ 一层 KV 兼容适配 | `db.mjs` + `store.mjs` |
| KV 里 `bt_list` 一整段文本 | `serials` 表一行一个号（可取号、可索引、可并发） | `db.mjs` |
| 后台环境变量 | 同目录 `.env` | `.env` |
| `xxx.workers.dev` | 自己的域名 + Nginx + HTTPS | 服务器 Nginx |

### 数据表结构

| 表 | 存什么 |
|---|---|
| `serials` | 号池：`serial`(主键) / `device` / `time` / `status` / `note` / `category` / `pos`(顺序) |
| `categories` | 分类名 |
| `claims` | 号 → 占号信息（`request_id` / `at` / `confirmed`），带过期时间 |
| `claim_reqs` | `request_id` → 号（幂等：同一请求重复调用返回同一个号） |
| `rate` | 接口限流计数（bucket + 分钟） |
| `kv` | 兜底：其它零散 key，行为与 KV 一致（带 TTL） |

### 文件清单

| 文件 | 作用 |
|---|---|
| `workers.js` | 业务逻辑（后台页面 / 页面表单 / 接口 / HMAC / 备份恢复） |
| `server.mjs` | Node 外壳：读 `.env`、注入数据层、转发请求、处理 Cookie |
| `db.mjs` | **SQLite 数据层**：建表、行级读写、原子占号 `claimAtomic()` |
| `store.mjs` | **KV → SQL 适配**：让 `workers.js` 的 `KV.get/put/delete/list` 落到 SQL 表上 |
| `.env` | 端口 / 账号密码 / 令牌 / 数据库路径 |
| `kv-import.mjs` | 命令行把 Cloudflare KV 或老 kv.json 导进 SQLite |
| `test-ubuntu.mjs` | 自测：启动 / 登录 / 导号 / 取号 / 并发不重发 / 导出 / 导入 / 迁移 |

---

## 二、准备 Node.js

```bash
node -v      # 需要 v22.5 以上（推荐 v22 LTS 或 v24）
which node   # 记下路径，systemd 里要用
```

⚠️ **Node 22.5 ~ 23.3 启动必须带 `--experimental-sqlite`**；Node 23.4+/24 不需要，但带上也不报错（本文一律带着）。

没装 Node 的话按 `wxminiapp-server` 那份部署文档第三节装（官方二进制），这里不重复。

---

## 三、上传文件

```bash
mkdir -p /opt/btkey-server/data
cd /opt/btkey-server
```

需要上传这几个（`workers.js` 也一起传，它这次加了「备份 / 恢复」）：

```
workers.js
server.mjs
db.mjs
store.mjs
.env
kv-import.mjs        # 需要从 Cloudflare 迁数据才用得上
test-ubuntu.mjs      # 可选，自测用
```

```bash
# 在你自己的电脑上执行
scp workers.js server.mjs db.mjs store.mjs .env kv-import.mjs root@你的服务器IP:/opt/btkey-server/
```

语法检查：

```bash
cd /opt/btkey-server
node --check workers.js && node --check server.mjs && node --check db.mjs && node --check store.mjs && echo ALL OK
```

---

## 四、配置 .env

`=` 后面写的是**要替换成的值**，照着填；不替换就等于配了错值（后台登不上 / 小程序取不到号）。

```bash
cd /opt/btkey-server
nano .env
```

```ini
# 监听端口（小程序后台是 8787，这里错开成 8788）
PORT=8788
# SQLite 数据库：号池 / 分类 / 占号记录 / 限流计数都在这一个文件里，务必备份
DB_PATH=./data/btkey.db
# 老的 KV JSON：存在且数据库为空时，启动会自动导入一次，然后把文件改名 .imported
LEGACY_KV_FILE=./data/btkey-kv.json

# 后台登录（必填，ADMIN_PASS 不能留着占位文字，否则服务会拒绝启动）
ADMIN_USER=admin
ADMIN_PASS=改成你自己的后台密码
# 登录 Cookie 的令牌值，随便生成一串；改了等于所有人被踢下线
ADMIN_TOKEN=node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" 生成

# 给小程序后端用的令牌：必须和 wxminiapp-server 的 BTKEY_API_TOKEN 完全一致
API_TOKEN=node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" 生成
# HMAC 签名密钥（可选，只给 /api/serials 的签名接口用；不配则该接口返回 503）
API_SECRET=
# IP 白名单（可选，逗号分隔，支持 1.2.3. 前缀；留空=不限制）
API_IP_ALLOW=
# 每分钟最多调用次数（默认 60）
API_MAX_PER_MIN=60
```

### 生成随机串

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # 48 位
openssl rand -hex 24                                                       # 等价写法
```

> `API_TOKEN` 这条命令跑一次，那串字符要填**两处**，且必须一字不差：
> - 本项目 `.env` → `API_TOKEN=...`
> - 小程序后端 `/opt/wxminiapp-server/.env` → `BTKEY_API_TOKEN=...`

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口，默认 8788 |
| `DB_PATH` | 否 | SQLite 文件，默认 `./data/btkey.db` |
| `LEGACY_KV_FILE` | 否 | 老 KV JSON 路径，仅首次迁移用 |
| `ADMIN_USER` / `ADMIN_PASS` | ✅ | 后台账号密码。密码留空或仍是占位文字 → 服务直接退出 |
| `ADMIN_TOKEN` | 建议 | 登录 Cookie 令牌；不配会用代码里的旧默认值 |
| `API_TOKEN` | ✅ | 小程序取号的 Bearer 令牌 |
| `API_SECRET` | 否 | `/api/serials` HMAC 签名密钥（走 Bearer 不需要） |
| `API_IP_ALLOW` | 否 | 接口白名单，支持 `1.2.3.` 前缀 |
| `API_MAX_PER_MIN` | 否 | 接口限流，默认 60 次/分钟 |

---

## 五、启动

### 5.1 前台试跑

```bash
cd /opt/btkey-server
node --experimental-sqlite server.mjs
```

正常输出：

```
[btkey] 数据库    : /opt/btkey-server/data/btkey.db
[btkey] 号池数量  : 1024 条 · 分类 2 个
[btkey] 后台账号  : admin
[btkey] API_TOKEN : 已配置（48 位）
[btkey] API_SECRET: 未配置（/api/serials 签名接口不可用，走 Bearer 不受影响）
[btkey] 已启动: http://0.0.0.0:8788  （后台首页 / ，登录后才能增删号）
```

### 5.2 本机自测

```bash
# ① 后台首页：应返回登录页
curl -s http://127.0.0.1:8788/ | grep -c 'name="login"'

# ② 接口探活（把 <你的API_TOKEN> 换成 .env 里的值）
curl -s -H "Authorization: Bearer <你的API_TOKEN>" http://127.0.0.1:8788/api/ping

# ③ 不带令牌应被拒（401 或 503）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/api/ping
```

### 5.3 后台常驻

```bash
cd /opt/btkey-server
setsid node --experimental-sqlite server.mjs > run.log 2>&1 < /dev/null &
sleep 1 && cat run.log
```

### 5.4 开机自启（systemd）

```bash
cat > /etc/systemd/system/btkey-server.service <<'EOF'
[Unit]
Description=BTKEY 序列号后台（SQLite 版）
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/btkey-server
# 注意：把 /usr/local/bin/node 换成你 which node 查到的路径
ExecStart=/usr/local/bin/node --experimental-sqlite /opt/btkey-server/server.mjs
Restart=always
RestartSec=3
StandardOutput=append:/opt/btkey-server/app.log
StandardError=append:/opt/btkey-server/app.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now btkey-server
systemctl status btkey-server --no-pager
```

> 用 setsid 跑过的话先杀掉再交给 systemd，避免端口冲突：`pkill -f "btkey-server/server.mjs"`

```bash
systemctl restart btkey-server     # 改完 .env 或导完数据后重启
systemctl stop btkey-server
journalctl -u btkey-server -n 50 --no-pager
tail -f /opt/btkey-server/app.log
```

---

## 六、Nginx 反代 + HTTPS

```bash
cat > /etc/nginx/sites-available/btkey.conf <<'EOF'
server {
    listen 80;
    server_name btkey.你的域名.com;

    # 批量导入几千个号时请求体可能比较大
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # 关键：不传这个，302 跳转会生成 http:// 地址，浏览器会拦混合内容
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/btkey.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

签发证书：

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d btkey.你的域名.com
```

验证：

```bash
curl -sI https://btkey.你的域名.com/ | head -3
curl -s  -H "Authorization: Bearer <API_TOKEN>" https://btkey.你的域名.com/api/ping
```

---

## 七、和小程序后端对接

`/opt/wxminiapp-server/.env` 要填三个值：

```ini
BTKEY_API_BASE=https://btkey.你的域名.com    ← 序列号后台域名，带 https，结尾不要斜杠
BTKEY_API_TOKEN=同一个48位串                ← 与 btkey 的 API_TOKEN 一字不差
SERIAL_CATEGORY=wxminiapp                  ← 必须是 btkey 后台已建好的分类名
```

```bash
systemctl restart wxminiapp-server
```

然后小程序里走一遍：**我的 → 登录 → 绑手机号 → 序列号取号（免费 1 次）**。

> 分类要先建好再导号，否则取号返回 `out_of_stock`。

---

## 八、作废 / 恢复序列号

这个后台的号有四种状态：

| 状态 | 含义 | 能发放？ | 能激活？ |
|---|---|---|---|
| 未激活（空） | 正常可用 | ✅ | ✅ |
| 已领取 | 已被小程序占号、等客户端激活 | ❌ | ✅ |
| 已激活 | 客户端已绑定设备 | ❌ | 只能原设备 |
| **已作废** | 人工作废 | ❌ | ❌（返回 `off`） |

### 作废

后台 → 激活码列表 → 每行右侧 **作废** 按钮 → 确认。

作废后：不再进入可发放状态；客户端带 `device_id` 来激活会返回 `off`。

### 恢复（撤销作废）

列表里状态是 **已作废** 的行，右侧按钮会变成绿色的 **恢复**：

```
未作废： [作废] [删除]
已作废： [恢复] [删除]     ← 点「恢复」并确认，状态立刻还原
```

恢复规则：

- **没激活过**的号 → 状态清空，重新变成可发放，小程序能正常取到
- **激活过**的号（有设备ID + 激活时间）→ 恢复后仍是「已激活」，继续绑原设备，**不会**被重复发给别人
- 备注、分类不动

### 想连设备绑定一起清掉（谨慎）

只有确认「客户已解绑 / 换机 / 误绑」时才这么做 —— 清掉后这个号会重新回到号池，可能被别人激活：

```bash
cd /opt/btkey-server
sqlite3 data/btkey.db "UPDATE serials SET status='', device='', time='' WHERE serial='BT-2026-A3';"
sqlite3 data/btkey.db "DELETE FROM claims WHERE serial='BT-2026-A3';"
```

> 需要先装：`apt install -y sqlite3`。改完不用重启服务，下一次请求就读到新数据。

### 和「小程序后台」那边的配合

小程序后台（`btsm.521156.xyz/admin`）对已激活的号点「删除（作废）」，做两件事：
① 调本后台 `/api/void` 把号作废；② 删掉它自己库里的发放记录。

所以**在本后台恢复之后**，号重新可发放，小程序后台不需要额外操作 —— 下次有用户取到它，会自动重新生成一条发放记录。

---

## 九、数据怎么迁移进来（三种方式，任选其一）

### 方式 1（最省事）：后台一键导出 → 一键导入

1. **旧后台**（Cloudflare 那版，或老的 kv.json 版）：左侧菜单 **💾 备份 / 恢复 → 完整备份（JSON）** 下载
2. **新后台**（这台 Ubuntu）：同一个页面 → 上传那个 json → 选「合并」→ 开始导入

一次把序列号、分类、占号记录全带过来。

### 方式 2：把老的 kv.json 放到 data 目录，启动自动迁移

```bash
# 把老的 data/btkey-kv.json 传到服务器
scp data/btkey-kv.json root@服务器IP:/opt/btkey-server/data/
systemctl restart btkey-server
journalctl -u btkey-server -n 20 --no-pager | grep 迁移
```

启动日志会显示：

```
[btkey] 已从 ./data/btkey-kv.json 迁移 1024 条序列号到 SQLite
[btkey] 原文件已改名为 ./data/btkey-kv.json.imported
```

> 只在**数据库为空**时才会自动迁移；文件会改名成 `.imported`，避免下次启动重复导入。

### 方式 3：命令行导（Cloudflare 上直接拉）

```bash
# 在你本地电脑
npx wrangler kv:key get --namespace-id=<你的KV命名空间ID> "bt_list" > bt_list.txt
npx wrangler kv:key get --namespace-id=<你的KV命名空间ID> "bt_categories" > bt_categories.json

# 传到服务器后
cd /opt/btkey-server
node --experimental-sqlite kv-import.mjs bt_list.txt bt_categories.json
systemctl restart btkey-server
```

输出示例：

```
✓ 已导入序列号 1024 行（库里原有 0 个）
✓ 已导入分类 2 个（合并后 2 个）

数据库: /opt/btkey-server/data/btkey.db
序列号: 0 → 1024 条（新增 1024）
分类  : wxminiapp、默认
分布  :
  wxminiapp: 1000 条
  (未分类): 24 条
```

`kv-import.mjs` 也可以直接吃整份 `kv.json`（后台导出的那种 `{key:{v}}` 结构）：

```bash
node --experimental-sqlite kv-import.mjs data/btkey-kv.json
```

> 导入只「补」不删：已存在的号保留原状态，不会把你已经发出去的号重置。

### 小批量也可以直接在后台贴

号不多的话：后台 → 「批量添加」→ 一行一个粘贴 → 选分类 → 提交（和以前一样）。

---

## 十、备份与升级

### 9.1 后台一键备份 / 恢复（推荐）

登录后台 → 左侧 **💾 备份 / 恢复**：

**导出**（三个按钮）

| 按钮 | 文件 | 用在哪 |
|---|---|---|
| 完整备份（JSON） | `btkey-backup-202610181012.json` | 用下面的「导入」原样恢复；搬家首选 |
| kv.json | `btkey-kv-202610181012.json` | 老格式（整份号池文本），用于回迁 Cloudflare 版 / 给老版本导入 |
| 序列号纯文本 | `btkey-serials-202610181012.txt` | 一行一个，贴进「批量添加」 |

> 默认**不导出真实密钥**（`API_TOKEN` / `ADMIN_TOKEN` / `API_SECRET` 显示 `***已隐藏***`）。
> 需要带走时勾选「备份里包含真实密钥」再导出，这类文件请妥善保管。

**导入**：上传文件或直接粘贴内容；两种模式

| 模式 | 行为 | 适合 |
|---|---|---|
| 合并（默认） | 已有的号保留原状态，只补新增和空白字段 | 日常恢复、同步 |
| 覆盖 | 清空现有序列号和分类，按备份重建 | 灾难恢复、整机搬迁 |

### 9.2 服务器上备份数据库

数据全在 `data/btkey.db`（WAL 模式还有 `-wal` / `-shm` 两个附属文件）。**用 sqlite3 的备份命令最稳**：

```bash
cd /opt/btkey-server
sqlite3 data/btkey.db ".backup 'data/backup-$(date +%F).db'"
```

没有 sqlite3 就装一下：`apt install -y sqlite3`。临时备份也可以直接 copy（WAL 里还没落盘的数据可能丢几条）：

```bash
cp data/btkey.db data/backup-$(date +%F).db
```

每天 3 点自动备份、保留 7 天：

```bash
crontab -e
# 加一行
0 3 * * * cd /opt/btkey-server && sqlite3 data/btkey.db ".backup 'data/backup-$(date +\%F).db'" && find data -name 'backup-*.db' -mtime +7 -delete
```

### 9.3 升级

`workers.js` 有新版本时：覆盖 → 重启，数据不动：

```bash
systemctl restart btkey-server
```

> 改 `DB_PATH` 等于换库；换之前先备份。

---

## 十一、常见报错对照

| 现象 | 原因 | 怎么修 |
|---|---|---|
| 启动报 `Cannot find module 'node:sqlite'` 或 `node:sqlite is an experimental feature` 直接崩 | Node 版本太低，或没带实验开关 | 升级到 Node 22.5+，启动命令加 `--experimental-sqlite` |
| 启动即退出，提示「请先在 .env 里设置后台账号密码」 | `ADMIN_PASS` 留空或还是占位文字 | 填真实密码 |
| 后台登录一直跳回登录页 | 反代没传 `X-Forwarded-Proto`，或访问的是 http | 补 Nginx header，用 https 访问 |
| 后台提示「账号或密码错误」 | `.env` 与输入不一致，或改完没重启 | 改完 `systemctl restart btkey-server` |
| 小程序取号报 `btkey_not_configured` | 小程序后端没填 `BTKEY_API_BASE` / `BTKEY_API_TOKEN` | 补上并重启小程序后端 |
| 小程序取号报 `401 unauthorized` | 两边 `API_TOKEN` 不一致 | 改成一个值，两边都重启 |
| 小程序取号报 `out_of_stock` | 该分类没号了，或分类名不一致 | 后台导号 + 核对 `SERIAL_CATEGORY` |
| 接口报 503 | 访问 `/api/serials` 但没配 `API_SECRET` | 走 Bearer 的 `/api/claim`，或补 `API_SECRET` |
| 接口报 429 | 触发 `API_MAX_PER_MIN` 限流 | 调大该值 |
| 批量导入报 413 | Nginx 请求体上限太小 | `client_max_body_size 20m;` 后 reload |
| 导入后列表还是空 | 数据写进了别的库 | 看启动日志里的「数据库」路径是否正确 |
| 数据库被锁 / `database is locked` | 有另一个进程连着同一个库 | 确认只有一个服务实例（`pkill -f server.mjs`） |

---

## 十二、性能与容量（实测）

在开发机上用 `node --experimental-sqlite` 实测（Windows / SSD，Linux 只会更快）：

| 号池规模 | 导入（一次性） | **单次取号** | 后台全量读取 | 库文件 |
|---|---|---|---|---|
| 1 千 | 13 ms | 1.1 ms | 3 ms | 0.3 MB |
| 5 千 | 51 ms | 1.1 ms | 23 ms | 0.8 MB |
| 1 万 | 107 ms | 1.1 ms | 42 ms | 1.3 MB |
| 5 万 | 575 ms | 1.1 ms | 179 ms | 6.2 MB |
| 10 万 | 1.3 s | 1.1 ms | 445 ms | 12.6 MB |
| 50 万 | 6.4 s | 1.1 ms | 2.6 s | 63 MB |

结论：

- **取号是恒定 1.1ms**，从 1 千到 50 万行都一样（走 `(category, status, pos)` 索引直接定位，不受数据量影响）
- 变慢的是 **后台列表页**（要把全部号读出来渲染成一整张表）：1 万行 42ms 还很顺，10 万行 445ms 开始有感觉，50 万行 2.6s 明显卡
- 所以：**号池 10 万以内随便放；后台列表建议配合「分类筛选」看，单分类超过 1 万再考虑加分页**

> 两个关键索引别删（建库时自动创建）：
> `idx_serials_claim(category, status, pos)` 决定取号速度，
> `idx_serials_status(status)` 决定「回收过期占位」的速度。
> 少了它们，取号耗时会随号池变大而线性变慢（10 万行从 1ms 退到 40ms）。

---

## 十三、自测脚本
改完代码或换服务器后跑一遍（用临时库，不碰正式数据）：

```bash
cd /opt/btkey-server
node --experimental-sqlite test-ubuntu.mjs
```

输出：

```
✓ SQL 版序列号后台测试通过（69 项断言：启动 / 登录 / 导号 / 取号 / 幂等 / 并发不重发 / 导出 / 导入 / SQL 落盘）
```

覆盖内容：

- 占位密码拒绝启动、登录页、登录发 Cookie
- 建分类、批量导号、列表展示
- `/api/ping`、`/api/categories`、`/api/claim`、`/api/confirm`
- 取号幂等（同一 `request_id` 不重复发号）、`exclude` 跳过
- **并发 20 个请求抢 12 个号 → 不允许出现重复号**
- 导出 JSON / kv.json / 纯文本；默认不导出密钥
- 导入：合并 / 覆盖 / 上传文件 / 纯文本
- SQL 落盘：`serials` / `categories` / `claims` / `claim_reqs` / `rate` / `kv` 六张表
- 老 kv.json 自动迁移（状态、时间、备注、分类、占号记录都保留，旧文件改名）
