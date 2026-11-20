# PickUp 自托管同步中继

这是独立的 Node.js 24 服务，不是桌面应用的数据库服务。它只保存客户端提供的不透明密文字节、空间标识、设备标识和序号，以及空间认证密钥的 SHA-256 摘要；不接收任务明文，也不负责加解密。**桌面版可在设置中启用端到端加密同步并显示配对二维码；Android 扫码接入留待 PR9，当前移动版不提供同步。** 服务器无法验证上传内容是否确实经过加密，客户端必须先加密；不要向 API 上传任务 JSON 或任何明文。

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

将生成结果写入 `.env` 的 `PICKUP_REGISTRATION_TOKEN`，不要提交、截图或共享该值。启动时缺失或不足 32 个非空白字符会明确失败。

| 变量                        | 含义                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PICKUP_REGISTRATION_TOKEN` | 创建空间使用的部署级密钥，仅交给需要注册设备的人；已有空间访问不使用此密钥                                                                      |
| `PICKUP_ALLOWED_ORIGINS`    | 精确匹配、逗号分隔的浏览器来源；默认 `https://localhost`，保留 Android Capacitor 来源；浏览器另加实际站点来源，不支持通配符，空值禁用浏览器来源 |
| `PICKUP_PORT`               | Compose 宿主机回环监听端口，默认 8787                                                                                                           |
| `PICKUP_DOMAIN`             | 仅 Caddy profile 需要，例如 `sync.example.com`，不带协议或路径                                                                                  |
| `PICKUP_DATA_DIR`           | 直接运行 Node 时的目录，默认 `/data`；Compose 固定容器内 `/data`，使用命名卷                                                                    |
| `PORT`                      | 直接运行 Node 时的端口，默认 8787；Compose 固定容器内 8787                                                                                      |

Electron Node worker 请求没有 Origin，不依赖 CORS。CORS 不是认证；所有非 health/preflight 请求仍必须携带对应凭据。

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
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
    }
}
```

反代不能记录 Authorization 或请求体；已有 access log 通常会记录完整 URL，如不希望暴露空间标识，可关闭该 location 的访问日志。中继自身只记录方法、路由模板、状态码和毫秒数。

## 3. API 约定

### 桌面启用与配对

1. 确保 HTTPS 的 `/healthz` 可访问。桌面“设置 → 同步”填写服务器地址与部署注册令牌，点击“启用同步”；仅 localhost/127.0.0.1/[::1] 调试允许 HTTP。不接受 URL 内的账号密码、查询或片段。
2. 点击“立即同步”，看到“已同步”和上次同步时间即为整轮推拉完成。离线时本地记录继续可用；错误显示并自动退避，401/403 显示“需要重新配对”且不再自动发送。
3. “显示配对二维码”提供 `pickup-sync:1:<base64url(JSON{u:serverUrl,k:rootKey})>`。rootKey 是 32 字节、无填充 base64url。**任何扫码者都有完整读写权限；二维码不是仅一次有效的登录码，不要截图分享。** 当前 PR8 只显示桌面二维码；手机扫码与第二台设备导入将在 PR9 接入，当前 Android 版无法扫描此载荷。
4. “停止同步”清除本机配置与待确认密文，保留所有本地任务。它不注销空间、不删除服务器数据、不撤销已分享的二维码或其他设备。重新启用会生成新根密钥和新空间，并上传现有本地事件；需要吊销旧访问时应在服务器访问层停用旧空间，当前 API 尚无轮换/删除接口。

客户端协议：WebCrypto HKDF-SHA256，salt 为 UTF-8 `pickup-sync:1`，分别用 info `pickup-sync:1:spaceId`、`pickup-sync:1:authKey`、`pickup-sync:1:encKey` 派生 256 位。前两项为 32 字节 base64url，后一项作为 AES-256-GCM 密钥。blob 的原始字节为 ASCII `v1`（2 字节）+ 随机 nonce（12 字节）+ AES-GCM 密文（含 16 字节 tag）；AAD 为 UTF-8 `spaceId:deviceId:clientSeq`。传输时整体 base64url 编码，不含 `=`。JSON 内容为单条共享 sync change；错误密钥、身份/序号错配、篡改或未知版本均拒绝整页，不推进拉取游标。

### 路由

- `GET /healthz` → `{ok:true}`，不需要认证。
- `POST /v1/spaces`：注册 token 的 Bearer 认证；JSON `{spaceId,authKey}`，两者均为客户端生成的 32 字节规范 base64url（无 `=`）。首次返回 201，同空间同密钥返回 200，不同密钥返回 409；服务仅保存 authKey 原始字节的 SHA-256 摘要。
- 其余 API 使用该空间 `authKey` 的 Bearer 认证。密钥错误和不存在的空间均返回 401。
- `POST /v1/spaces/:id/changes`：JSON `{deviceId,changes:[{clientSeq,blob}]}`。deviceId 为 1–128 字符，clientSeq 为非负安全整数；blob 为规范 base64url 密文，解码后不超过 64 KiB。每次最多 500 条，请求体最多 1 MiB。重复 `(space,deviceId,clientSeq)` 且密文相同为 no-op，密文不同则 409，整批回滚。返回 `{accepted,lastServerSeq}`，accepted 是新插入的条数；空批次允许。
- `GET /v1/spaces/:id/changes?after=0&limit=200`：limit 为 1–500；返回 `{changes:[{serverSeq,deviceId,clientSeq,blob}],lastServerSeq,more}`。`clientSeq` 是原始设备的 outbox 序号，接收端用它重建 AES-GCM AAD；不能用 serverSeq 代替。**非空页 lastServerSeq 是本页末尾的游标，不是空间全局高水位**；下一页以该值作为 after，直到 more 为 false。空页返回空间当前真实最大序号（无事件为 0），不回显 after。客户端保存最后拉取事件的序号 N 与 deviceId/clientSeq；N>0 从 after=N−1 拉取并验证首条锚点，随后丢弃重叠行。锚点缺失或变化即事务清零推拉游标，再用保留的原始密文、clientSeq 重传 outbox；不依赖服务器高水位下降，因此其他设备重新填充旧备份后仍能检测连续性变化。N=0 不需要锚点。每个空间独立分配递增序号。
- 所有 API 错误为 `{error:{code,message}}`；格式错误 400、凭据错误 401、CORS 拒绝 403、冲突 409、超时 408、体积过大 413、错误 Content-Type 415。用 `application/json` 上传。

没有空间删除、配额、密钥轮换或速率限制接口。注册 token 可以通过更新环境变量并重建容器轮换；空间 authKey 由客户端保管，当前无服务端找回。服务器操作者仍能观察设备/空间标识、变更大小和请求时间，不能把密文存储等同于完整隐私保证。部署在可信访问范围内，必要时由反代实施额外限流和访问控制。

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
