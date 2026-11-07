# LX Source for MyGo Music

把 [洛雪音乐（LX Music）](https://github.com/lyswhut/lx-music-desktop) 的自定义音源脚本接到 [MyGo Music](https://github.com/egoist/mygo-music) 上。

Load LX Music custom source scripts in MyGo Music: multi-source racing, search, lyrics and playback.

洛雪的脚本只做一件事：拿到 `songmid`，返回一个播放地址。搜索、专辑、歌手这些客户端自己的事它不管。所以这个插件自己负责搜索，拿到 ID 之后交给音源脚本换地址。

## 免责声明

- 这个插件**不提供、不托管、不分发任何音乐或音频内容**。它只是一个适配层，把使用者自己配置的第三方音源脚本接到播放器上。
- 插件内置的搜索只调用两个平台的公开接口，用来取得歌曲元数据（歌名、歌手、ID、封面）；**播放地址一律来自使用者自己填写的音源脚本**，本项目不内置、不推荐、不托管任何音源。
- 本项目与所涉及的各音乐平台及洛雪音乐（LX Music）均无关联，也未获得任何授权或认可。所有商标归各自所有者。
- 音源脚本是第三方代码，其来源、合法性与可用性由使用者自行判断并承担后果。**请只播放你有权访问的内容**，并遵守所在地区的法律与各平台的服务条款。
- 本项目不提供任何绕过付费、会员或版权保护的功能，也不鼓励此类行为。因使用本插件产生的任何后果由使用者自行承担。
- 软件按「现状」提供，不附带任何明示或暗示的担保。作者不对可用性、稳定性或由此造成的任何损失负责。

## 要求

MyGo Music **0.1.20** 或更新——封面用了 `{size}` 模板，更早的版本不会按尺寸取图。

## 安装

两种方式：

1. **文件夹**：设置 → 插件 → `+` → 显示插件文件夹，把 `mygo-music-lx-source` 整个目录拷进去，重启应用。
2. **压缩包**：把这个目录压成 zip（`plugin.json` 在压缩包根目录），设置 → 插件 → `+` → 从文件安装。

也可以在应用里直接打开安装链接：

```
mygo-music://install-plugin?repo=jfeng018/mygo-music-lx-source
```

装好后在 **设置 → 插件 → LX 音源** 里填 **音源脚本地址**：一个或多个 LX 自定义音源 `.js` 的直链，用换行分隔；逗号、分号或空格后面紧跟另一个链接时也能分开。也可以直接把脚本内容粘进第二项，它会和地址里的脚本一起用。

填完打开插件首页，能看到脚本名和支持的平台就说明加载成功了。

## 用起来是什么样

- **多音源并发**：配了几个音源，播放时就同时问几个，谁先给出能用的地址就用谁，其余的请求立刻收掉。慢的源最多等 10 秒；有多个源时会先探测一次地址，404 / 410 或连不上的死链会被跳过，继续等其它源。
- 搜索：同时搜两个平台，**当前音源能播的结果排在前面**，点开就能放。
- 播放：按 MyGo 的音质设置映射到脚本声明的音质（`standard → 128k`、`high → 320k`、`lossless → flac`），脚本不支持的音质自动降级。
- 歌词：脚本支持 `lyric` 动作就用脚本的，否则用插件自带的歌词接口。
- 「音源」页：列出每个已加载脚本的作者、版本、支持的平台和音质；加载失败的脚本也会单独列出来，写清失败原因。

## 设置项

| 键 | 说明 |
| --- | --- |
| `scriptUrls` | 一个或多个音源脚本直链，换行分隔；逗号 / 分号 / 空格只在后面紧跟另一个链接时才算分隔，不会切断 URL query 里的 `,` 和 `;`。下载最多等 5 秒，之后缓存 10 分钟 |
| `script` | 直接粘贴脚本内容，作为额外的一个音源 |
| `platform` | `wy` / `tx` 是 LX 音源里的两个 source key，填一个只搜它，留空两个都搜 |

## 它怎么跑 LX 脚本

`plugin.json` 申请了 `network: ["*"]`，因为脚本会请求哪个域名只有它自己知道。插件在内存里搭了一个最小的 `globalThis.lx`：

| LX 提供 | 插件里的实现 |
| --- | --- |
| `lx.request` | `fetch`，`resp.body` 自动 `JSON.parse`，支持 `method/headers/body/form/formData/timeout` |
| `lx.on` / `lx.send` | 事件表，收 `inited` 的 `sources` 和 `updateAlert` |
| `lx.EVENT_NAMES` | 同名常量 |
| `lx.currentScriptInfo` | 从脚本头部的 `@name` / `@version` / `@author` 解析 |
| `lx.utils.buffer` | 自带的 `Buffer`（utf8 / hex / base64 / latin1） |
| `lx.utils.crypto.md5` | `host.crypto.md5` |
| `lx.utils.crypto.randomBytes` | 随机十六进制串，有 `crypto.getRandomValues` 就走安全随机源 |
| `lx.utils.crypto.aesEncrypt` | 只支持 AES-ECB（走 `host.crypto.aesEcbEncrypt`） |

脚本用 `new Function` 执行，`module.exports`、`require('crypto')`、`require('buffer')` 都有最小实现。`require('crypto').createHash` 只实现 md5，别的算法会明确报错而不是给一个错误结果。`on(EVENT_NAMES.request, ...)` 可以注册多个，依次尝试。两种写法都认：`module.exports = { sources }`，或者标准的 `on(...)` + `send(EVENT_NAMES.inited, ...)`。

**不支持**：RSA、AES-CBC、zlib，以及 md5 之外的摘要算法。需要这些的音源脚本会明确报错，换一个只用普通 HTTP 接口的即可。

## 沙箱边界

`new Function` 不是安全沙箱。脚本拿到的是以真实 `globalThis` 为原型的对象，`host` 被显式遮住，但通过原型链或 `Function('return this')()` 仍能回到宿主全局。请把音源脚本当作第三方代码看待，只导入你信任的脚本；插件对脚本的行为不负责。

## 已知限制

- 搜索只做了 `wy` / `tx` 两个平台，因为它们的公开搜索接口不需要登录。脚本声明了其它平台也不会出现在搜索结果里，但如果你有那些平台的 ID，播放链路本身是通的。
- 歌词只做了这两个平台，结果会缓存。
- 没有登录、歌单、每日推荐——那些需要平台账号，不在这个插件的范围内（社区里已经有专门的单平台插件）。
- 并发起手会同时打所有音源，赢家出现后其余请求会被取消，但每首歌仍比单源多几倍请求；有多个源时还会各多一次地址探测。配太多源容易被风控，两三个就够。
- 地址探测只挡明确的 404 / 410、连不上和超时；返回 403 / 405 或需要特定 Referer 的链一律放行，避免误杀。一个看起来正常却实际播不了的链接，这次播放仍会失败。
- 搜索和歌词不等待音源脚本下载：脚本地址不通只影响播放，不会拖住搜索。首页会显示上次搜索的问题，「音源」页显示上次是哪个脚本播的。
- 有些脚本会在加载时自己发一次更新检查，网络不通时会报一条没人接的错误。不影响播放，日志里看到可以忽略。
- 音源脚本是第三方代码，插件只把它的地址交给播放器，不对其内容负责。

## 开发

```bash
node --test test.mjs
```

测试用假的 `host` 和 stub 过的 `fetch` 跑一遍，不依赖任何第三方接口：搜索、脚本编译、`musicUrl` 调用链、ID 编解码、多源并发抢答（本地起 http 服务提供脚本）、死链回退、地址探测、歌词缓存、全部失败时的报错。想顺带打一次真实搜索接口：

```bash
LX_ONLINE_TESTS=1 node --test test.mjs
```

## License

[AGPL-3.0](LICENSE)，与 MyGo Music 一致。
