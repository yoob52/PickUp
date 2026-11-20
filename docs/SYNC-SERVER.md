# PickUp 自托管同步中继

这是独立的 Node.js 24 中央同步服务，不是桌面应用的数据库服务。默认服务地址为 `https://pickup.3352378.xyz`，也可在应用“高级”中使用自建服务。用户使用邮箱和密码注册；暂不验证邮箱，请正确填写并保存恢复码。服务保存邮箱、认证凭据的 scrypt 摘要、会话摘要、加密包装的根密钥，以及不透明任务密文、空间/设备标识和序号；不接收密码、恢复码或任务明文。服务器无法验证上传内容是否确实经过加密，客户端必须先加密；不要向 API 上传任务 JSON 或任何明文。

## 1. 准备

- Linux 主机、Docker Engine 和 Compose v2；磁盘使用本地持久存储，不能用多副本共享 SQLite 文件或不可靠的网络文件系统。
- 对外访问必须使用 HTTPS：已有 nginx 反向代理，或使用下述可选 Caddy。中继本身只有 HTTP。
- 使用 Caddy 时，准备域名并将 DNS 指向主机，开放 TCP 80/443；nginx 与 Caddy 不要同时占用这些端口。
- 默认服务仅绑定宿主机 `127.0.0.1:8787`。不要直接把明文 HTTP 暴露公网。

在仓库的 `server/` 目录操作：

```sh
cp .env.example .env
chmod 600 .env
openssl rand -base64 48
```

账户注册默认开放，不需要令牌。只有仍需兼容旧版桌面“启用同步”创建无账户空间时，才把生成结果写入 `.env` 的 `PICKUP_REGISTRATION_TOKEN`；设置时至少 32 个非空白字符，不要提交或截图。未设置时禁用旧版 `POST /v1/spaces`，不影响账户注册、登录或已有空间访问。

| 变量                        | 含义                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PICKUP_REGISTRATION_TOKEN` | 可选，仅用于旧版无账户空间创建；不限制新的账户注册 |
| `PICKUP_ACCOUNT_QUOTA_BYTES` | 每账户密文 blob 配额，默认 `20971520`（20 MiB）；按解码后字节累计，幂等重传不重复计费；整批超额回滚并返回 413 `QUOTA_EXCEEDED` |
| `PICKUP_TRUSTED_PROXIES` | 可选，逗号分隔的反代 socket 对端精确 IP（注意 IPv4-mapped IPv6）；仅信任这些对端传入的单一 `X-Real-IP`。默认忽略所有客户端转发头 |
| `PICKUP_ALLOWED_ORIGINS`    | 精确匹配、逗号分隔的浏览器来源；默认 `https://localhost`，保留 Android Capacitor 来源；浏览器另加实际站点来源，不支持通配符，空值禁用浏览器来源 |
| `PICKUP_PORT`               | Compose 宿主机回环监听端口，默认 8787                                                                                                           |
| `PICKUP_DOMAIN`             | 仅 Caddy profile 需要，例如 `sync.example.com`，不带协议或路径                                                                                  |
| `PICKUP_DATA_DIR`           | 直接运行 Node 时的目录，默认 `/data`；Compose 固定容器内 `/data`，使用命名卷                                                                    |
| `PORT`                      | 直接运行 Node 时的端口，默认 8787；Compose 固定容器内 8787                                                                                      |

Electron Node worker 请求没有 Origin，不依赖 CORS。CORS 不是认证；账户注册、prelogin/login/recover 和创建临时扫码请求无需已有凭据，空间访问仍必须认证。账户 session 与旧配对空间密钥都可访问所绑定的空间，但不能跨账户访问。

### 账户、恢复与扫码登录（PR9b）

- 桌面与手机均可注册、登录和退出。“高级”可更改服务器。登录会把本机已有记录并入账户；退出保留本地任务，只撤销当前会话。手机和扫码登录电脑使用独立的 30 天会话；退出一台不会退出另一台。无法联网撤销时明确提示本机已退出、服务器会话需等到期。
- 客户端以 WebCrypto PBKDF2-SHA256（600,000 次，服务端给出的 32 字节账户盐）派生 masterKey，再用带版本域分离的 HKDF 派生 authKey 和 AES-256-GCM KEK。服务端只保存随机盐 scrypt(authKey)，参数 N=16384/r=8/p=1；密码不发送。随机 rootKey 分别以密码 KEK 和 256 位随机恢复码派生 KEK 包装。任务空间与任务密钥仍按 PR8 从 rootKey 派生。
- 注册后离线保存“仅此一次”的恢复码并确认。未确认前仅保留在本机私有数据库，避免网络响应丢失或误关界面导致无法保存；确认后删除该暂存，不能再从服务端取回恢复码。忘记密码时用邮箱、恢复码和新密码重包装同一 rootKey，服务端撤销该账户全部会话。恢复码继续有效；本轮不提供邮箱找回、邮件验证、密钥轮换或管理员代解密。配对密钥不因密码重设而改变，已分享的旧配对访问不能因此撤销。
- prelogin 对未知邮箱返回基于数据库内随机 secret 的 HMAC 确定性假盐，与真实盐同长度、同响应。登录与恢复对未知邮箱/错误凭据返回相同 401；注册重复邮箱返回通用不可注册响应。无验证邮件不能证明邮箱所有权，也不能阻止别人先注册某地址。
- 每 socket IP：注册 5 次/小时，登录和恢复合计 20 次/分钟，prelogin 60 次/分钟，扫码请求创建 20 次/分钟；每邮箱错误 5 次后锁定 5 秒，继续错误指数退避至 1 小时。限流和邮箱计数持久化，已知/未知邮箱同规则。反代必须覆盖（不能拼接）`X-Real-IP`，并将实际连接的反代 IP 加入 `PICKUP_TRUSTED_PROXIES`，否则所有反代用户共享同一 IP 限流。不要信任公网客户端提供的头。
- 桌面点“扫码登录”，生成仅内存保存的 ECDH P-256 私钥。先 `POST /v1/handoff` 申请服务端 2 分钟槽位和私有轮询凭据；二维码只含 server/requestId/pubkey/expiry，不包含轮询凭据。已登录手机点“扫码登录电脑”，核对账户和服务器后明确确认；可粘贴电脑登录码作为相同协议的备用输入。手机申请独立会话，经 ECDH+HKDF 派生 AES-GCM 密钥，把 rootKey/会话/邮箱加密到桌面公钥，向 `POST /v1/handoff/:id` 发送不透明密文。桌面带私有凭据轮询 `GET /v1/handoff/:id`，密文只可取一次，槽位 2 分钟过期；私钥不落盘。不保存明文密钥于服务器，也不在日志记录完整 payload。
- 原桌面到手机的配对二维码继续可用，是授予完整空间访问的可选路径，不要求在配对手机重复登录。请勿公开任何配对码或登录二维码。

## 2. 启动与 HTTPS

```sh
docker compose pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8787/healthz
# {"ok":true}
```

GHCR 镜像由 main 分支服务改动通过测试后发布；首次镜像尚未发布或需要本地源码构建时，使用 `docker compose build sync && docker compose up -d`。镜像提供 `latest` 和 `sha-<7位提交号>` 标签；生产部署建议把 compose 的 image 改为已验证的 SHA 标签。首次发布后，维护者可能需要在 GitHub Packages 设置中将包设为 public；私有包先按自己的部署凭据执行 `docker login ghcr.io`。

### 方案 A：内置 Caddy

填写 `.env` 中真实的 `PICKUP_DOMAIN`，然后：

```sh
docker compose --profile https up -d
curl --fail https://sync.example.com/healthz
```

Caddy 自动申请并续期证书，代理到同一 Compose 网络中的 `sync:8787`。证书状态保存在单独命名卷。之后升级、停止时同样使用 `--profile https`。

### 方案 B：已有 nginx

已有 nginx 在宿主机运行时，示例 TLS server 配置如下；证书由现有证书管理工具提供，按实际路径替换。若 nginx 在容器内，`127.0.0.1` 是该容器自身，应将其加入中继网络并代理到 `sync:8787`。

```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;
    ssl_certificate /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;
    # 让应用统一以 JSON 拒绝超过 1 MiB 的请求。
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
    }
}
```

反代不能记录 Authorization 或请求体；已有 access log 通常会记录完整 URL，如不希望暴露空间标识，可关闭该 location 的访问日志。中继自身只记录方法、路由模板、状态码和毫秒数。

## 3. API 约定

### 旧版桌面启用与可选配对

1. 新用户优先在“设置 → 同步”注册或登录账户（见上文）。仅为兼容旧部署，在“高级：旧版配对空间”填写服务器地址与管理员配置的可选部署注册令牌，点击“启用同步”；仅 localhost/127.0.0.1/[::1] 调试允许 HTTP。不接受 URL 内的账号密码、查询或片段。
2. 点击“立即同步”，看到“已同步”和上次同步时间即为整轮推拉完成。离线时本地记录继续可用；错误显示并自动退避，401/403 显示“需要重新配对”且不再自动发送。
3. “显示配对二维码”提供 `pickup-sync:1:<base64url(JSON{u:serverUrl,k:rootKey})>`；也可点旁边的“复制配对码”。rootKey 是 32 字节、无填充 base64url。**任何持有码的人都有完整读写权限；二维码不是仅一次有效的登录码，不要截图分享或通过不可信渠道发送。**
4. “停止同步”清除本机配置与待确认密文，保留所有本地任务。它不注销空间、不删除服务器数据、不撤销已分享的二维码或其他设备。重新启用会生成新根密钥和新空间，并上传现有本地事件；需要吊销旧访问时应在服务器访问层停用旧空间，当前 API 尚无轮换/删除接口。

### 手机加入已有空间

1. Android 8.0（API 26）以上安装应用，点紧凑顶栏右侧的云图标打开“同步”。点“扫码配对”，首次使用按系统提示允许相机；拒绝权限、相机不可用或不方便扫码时，始终可用“粘贴配对码”文本框。浏览器版仅支持粘贴，不调用相机。
2. 扫描桌面二维码，或把桌面复制的完整 `pickup-sync:1:…` 粘贴后点“配对并同步”。手机只读取服务器 URL/rootKey，直接加入已有空间并首次推拉，**不需要也不保存注册令牌**。已有本地任务也会上传，与电脑已有事件合并。
3. “已同步”、上次同步时间及错误可在此查看。可“立即同步”或“停止同步”；401/403 显示“需要重新配对”，可重新扫码或重新粘贴。Android 返回键关闭 sheet，键盘显示时先收起键盘。
4. 手机只在页面前台可见时工作：本地变更后防抖 2 秒、每 60 秒及回到前台时同步；隐藏时停计时器并中止网络请求。**没有后台同步或后台保活**；离线/后台记录在下次前台重试。停止同步不删除本地任务，也不撤销其他设备。

Android 请求来源固定 `https://localhost`，服务器 `PICKUP_ALLOWED_ORIGINS` 必须保留它；移动浏览器另加真实站点来源。移动 CSP 仅允许同源、HTTPS 和开发用 `http://localhost:*`；Android 明文网络策略也只放行 `localhost`，不允许局域网 IP 的 HTTP。模拟器调试先在宿主运行中继，执行 `adb reverse tcp:8787 tcp:8787`，桌面启用地址用 `http://localhost:8787` 再复制给手机，不能用 `127.0.0.1` 替代该明文例外。

客户端协议：WebCrypto HKDF-SHA256，salt 为 UTF-8 `pickup-sync:1`，分别用 info `pickup-sync:1:spaceId`、`pickup-sync:1:authKey`、`pickup-sync:1:encKey` 派生 256 位。前两项为 32 字节 base64url，后一项作为 AES-256-GCM 密钥。blob 的原始字节为 ASCII `v1`（2 字节）+ 随机 nonce（12 字节）+ AES-GCM 密文（含 16 字节 tag）；AAD 为 UTF-8 `spaceId:deviceId:clientSeq`。传输时整体 base64url 编码，不含 `=`。JSON 内容为单条共享 sync change；错误密钥、身份/序号错配、篡改或未知版本均拒绝整页，不推进拉取游标。

### 路由

- `GET /healthz` → `{ok:true}`，不需要认证。
- `POST /v1/spaces`：注册 token 的 Bearer 认证；JSON `{spaceId,authKey}`，两者均为客户端生成的 32 字节规范 base64url（无 `=`）。首次返回 201，同空间同密钥返回 200，不同密钥返回 409；服务仅保存 authKey 原始字节的 SHA-256 摘要。
- 下面的空间变更 API 接受该空间 `authKey` 或绑定同一空间的账户 session 的 Bearer 认证。凭据错误和不存在的空间均返回 401；账户与扫码路由见上文。
- `POST /v1/spaces/:id/changes`：JSON `{deviceId,changes:[{clientSeq,blob}]}`。deviceId 为 1–128 字符，clientSeq 为非负安全整数；blob 为规范 base64url 密文，解码后不超过 64 KiB。每次最多 500 条，请求体最多 1 MiB。重复 `(space,deviceId,clientSeq)` 且密文相同为 no-op，密文不同则 409，整批回滚。返回 `{accepted,lastServerSeq}`，accepted 是新插入的条数；空批次允许。
- `GET /v1/spaces/:id/changes?after=0&limit=200`：limit 为 1–500；返回 `{changes:[{serverSeq,deviceId,clientSeq,blob}],lastServerSeq,more}`。`clientSeq` 是原始设备的 outbox 序号，接收端用它重建 AES-GCM AAD；不能用 serverSeq 代替。**非空页 lastServerSeq 是本页末尾的游标，不是空间全局高水位**；下一页以该值作为 after，直到 more 为 false。空页返回空间当前真实最大序号（无事件为 0），不回显 after。客户端保存最后拉取事件的序号 N 与 deviceId/clientSeq；N>0 从 after=N−1 拉取并验证首条锚点，随后丢弃重叠行。锚点缺失或变化即事务清零推拉游标，再用保留的原始密文、clientSeq 重传 outbox；不依赖服务器高水位下降，因此其他设备重新填充旧备份后仍能检测连续性变化。N=0 不需要锚点。每个空间独立分配递增序号。
- 所有 API 错误为 `{error:{code,message}}`；格式错误 400、凭据错误 401、CORS 拒绝 403、冲突 409、超时 408、体积过大 413、错误 Content-Type 415。用 `application/json` 上传。

没有空间删除、密钥轮换或管理配额/限流的 HTTP 接口；账户配额与认证限流由服务端执行。旧版注册 token 可以通过更新环境变量并重建容器轮换；空间 authKey 由客户端保管，恢复依赖用户保存的恢复码。服务器操作者仍能观察邮箱、设备/空间标识、变更大小和请求时间，不能把密文存储等同于完整隐私保证。必要时由反代实施额外限流和访问控制。

## 4. 备份、恢复与升级

数据库文件为 `/data/sync.sqlite`，开启 WAL。**运行中不要只复制主文件**，否则可能遗漏已提交的 WAL。最简单的备份方法是先停止中继（处理已接收请求后关闭连接），再打包整个目录：

```sh
mkdir -p backups
docker compose stop sync
docker compose run --rm --no-deps --user root --entrypoint tar sync -C /data -czf - . > backups/sync-data.tar.gz
docker compose up -d sync
```

备份命令使用一次性的 root 进程只读打包，以保留目录内 node 用户的所有权；正常服务始终使用非 root。备份需要加密并异机保存。另行备份受保护的 `.env`；客户端加密密钥不在服务端，必须单独保管。Caddy 的卷可重新签发证书或另行备份。

恢复到已停止的目标部署，把归档解压到其命名卷，并确保 `/data` 归属镜像中的 node 用户；不要删除原卷作为“修复”。先保留现状副本，再用 `docker compose run --rm --no-deps --user root --entrypoint tar sync -C /data -xzf - < backups/sync-data.tar.gz` 恢复备份，启动后检查 health 与已知空间数据。

升级：先备份 → 记录旧镜像 SHA → `docker compose pull sync` → `docker compose up -d sync` → `docker compose ps` 和 `/healthz`。Caddy 部署在命令中加 `--profile https`。不要执行 `docker compose down -v`，它会删除数据库卷。当前只有启动建表；未来若有不兼容 schema 迁移，回滚镜像必须同时考虑数据库备份。

## 5. 源码开发

```sh
# 仓库根目录，使用 .node-version 的 Node 24
npm ci --prefix server
npm run server:test   # 包含独立 TypeScript typecheck，真实 HTTP/SQLite 测试
npm run server:build
PICKUP_DATA_DIR=./server-data PICKUP_REGISTRATION_TOKEN='<私有32字符以上值>' node server/dist/main.js
```

依赖及锁文件与应用隔离；无 Web 框架或原生 npm 依赖。SQLite 使用 Node 内置 `node:sqlite`（部分 Node 24 版本会输出实验性 API 警告）。服务收到 SIGTERM/SIGINT 后停止接入，给在途请求最多 10 秒完成，再关闭连接；Compose 的停止宽限期为 20 秒。
