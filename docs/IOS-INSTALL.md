# 在自己的 iPhone 上安装 PickUp（免费 Apple ID）

PickUp iOS 版不经 App Store，也不需要付费开发者账号：用 Windows 电脑上的 [Sideloadly](https://sideloadly.io/) 和自己的免费 Apple ID 给安装包签名，装到自己的 iPhone。免费签名的限制：

- 签名 **7 天** 后过期，过期后应用打不开，需要重新签名（数据保留，见第 4 步）。
- 只能装在自己的设备上，不能分发给别人；同一 Apple ID 最多同时 3 个侧载应用。
- 需要 iOS 17.4 或更高版本（设置 → 通用 → 关于本机 查看）。

## 1. 准备 Windows 电脑（只做一次）

1. 安装 Apple 官网版 iTunes 和 iCloud（不要用 Microsoft Store 版）：
   - iTunes：https://www.apple.com/itunes/download/win64
   - iCloud：https://updates.cdn-apple.com/2020/windows/001-39935-20200911-1A70AA56-F448-11EA-8CC0-99D41950005E/iCloudSetup.exe
     如果已装了 Store 版，先在“设置 → 应用”中卸载再装官网版。
2. 从 https://sideloadly.io/ 下载并安装 Sideloadly（Windows 版）。
3. 下载安装包：[GitHub Releases](https://github.com/yoob52/PickUp/releases/latest) 中的 `PickUp-<版本>-unsigned.ipa`。未发布版本可在 Actions 的 “Build iOS IPA” 运行页下载 `pickup-ios-ipa` artifact（需登录 GitHub，解压后得到 `.ipa`）。

## 2. 签名并安装

1. 用数据线连接 iPhone 和电脑，解锁 iPhone，在弹窗中点“信任”并输入锁屏密码。
2. 打开 Sideloadly，左上角设备栏应显示你的 iPhone。
3. 把 `.ipa` 拖到 Sideloadly 左侧图标位置。
4. 在 “Apple account” 中填入你的 Apple ID 邮箱，点 **Start**，输入 Apple ID 密码；开启了双重认证时，在弹窗中输入 iPhone 上收到的验证码。
5. 等待显示 “Done.”，iPhone 桌面上会出现 PickUp。

## 3. 第一次打开前在 iPhone 上设置（只做一次）

1. **开发者模式**：设置 → 隐私与安全性 → 开发者模式 → 打开，按提示重启；重启后在弹窗中选“打开”。（看不到该选项时，先完成第 2 步安装后再找。）
2. **信任开发者**：设置 → 通用 → VPN 与设备管理 → 在“开发者 App”下点你的 Apple ID → 信任。
3. 打开 PickUp。扫码登录需要相机时按提示允许。

## 4. 每 7 天续签

到期前（或应用打不开时）重复第 2 步：连接 iPhone，用同一个 Apple ID 和同一个 `.ipa`（或更新版本）点 Start。保持 Sideloadly 默认的 Bundle ID 不变，就是覆盖安装，本机任务数据保留。**不要先删除应用**，删除会清空手机上的本地数据（已同步到服务器的任务可登录后取回）。

也可在 Sideloadly 中右键已安装的应用开启 Auto-refresh：电脑开着 Sideloadly 且与 iPhone 在同一 Wi-Fi 时自动续签（首次需用数据线连接，并在 iTunes 中勾选“通过 Wi-Fi 与此 iPhone 同步”）。

## 5. 同步

与 Android 相同：点顶栏右侧云图标，用同一个邮箱账户登录，或在电脑上打开登录二维码后点“扫码”。默认同步服务器为 https://pickup.3352378.xyz。

## 常见问题

- **Sideloadly 看不到 iPhone**：确认安装的是官网版 iTunes，换数据线/USB 口，iPhone 上重新点“信任”。
- **提示 “Your maximum App ID limit has been reached”**：免费账号每 7 天最多注册 10 个 App ID，等几天或删除其他侧载应用。
- **打开时提示“未受信任的开发者”**：完成第 3 步第 2 项。
- **应用闪退或打不开**：签名已过期，按第 4 步续签。
