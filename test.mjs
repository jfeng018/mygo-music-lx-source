// 用假的 host 跑一遍插件的骨架：搜索、脚本编译、musicUrl 调用链、页面。
// 音源脚本用本地 fixture，不依赖任何第三方 API；搜索走真实接口。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createCipheriv } from "node:crypto";
import { createServer } from "node:http";

const store = new Map();
const settings = new Map();

globalThis.host = {
  platform: "darwin",
  arch: "arm64",
  dir: ".",
  dataDir: "./data",
  setting: (key) => settings.get(key) || "",
  storage: {
    get: (key) => (store.has(key) ? store.get(key) : null),
    set: (key, value) => store.set(key, value),
    remove: (key) => store.delete(key),
  },
  crypto: {
    md5: (text) => createHash("md5").update(String(text)).digest("hex"),
    aesEcbEncrypt: (key, text) => {
      const cipher = createCipheriv("aes-128-ecb", Buffer.from(String(key)).subarray(0, 16), null);
      return Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]).toString("hex");
    },
  },
  t: (text) => text,
  language: () => "en",
};

const lx = await import("./index.js");

const FIXTURE = `/**
 * @name 测试音源
 * @description 只用来跑测试
 * @version 1.0.0
 * @author test
 */
const { EVENT_NAMES, request, on, send } = globalThis.lx

const httpFetch = (url, options = { method: 'GET' }) =>
  new Promise((resolve, reject) => {
    request(url, options, (err, resp) => (err ? reject(err) : resolve(resp)))
  })

on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('unsupported'))
  return Promise.resolve('https://cdn.example.com/' + source + '/' + info.musicInfo.songmid + '.mp3')
})

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
  },
})
`;

test("search 返回网易云的歌，ID 带平台前缀", async () => {
  const result = await lx.search({ query: "mygo", kind: "tracks", offset: 0 });
  assert.ok(Array.isArray(result.tracks));
  assert.ok(result.tracks.length > 0, "应该搜到歌");
  const track = result.tracks[0];
  assert.match(track.id, /^(wy|tx):/);
  assert.ok(track.name);
  assert.ok(track.duration > 0);
  assert.ok(track.album);
});

test("没有音源时播放给出 setup 错误", async () => {
  await assert.rejects(
    () => lx.stream({ id: "wy:123", quality: "high" }),
    (error) => error.code === "setup",
  );
});

test("加载音源脚本后能拿到播放地址", async () => {
  // 真实环境里 host.setting 会先拿到新值，这里手动同步一下
  settings.set("script", FIXTURE);
  await lx.setSetting({ key: "script", value: FIXTURE });
  const stream = await lx.stream({ id: "wy:2097485069", quality: "high" });
  assert.equal(stream.url, "https://cdn.example.com/wy/2097485069.mp3");
  assert.equal(stream.type, "mp3");
  assert.equal(stream.quality, "high");
});

test("音质按脚本声明的降级", async () => {
  // fixture 只有 128k / 320k，要 flac 应该落到 320k 而不是报错
  const stream = await lx.stream({ id: "wy:1", quality: "lossless" });
  assert.match(stream.url, /wy\/1\.mp3/);
});

test("首页和音源页认得已加载的脚本", async () => {
  const home = await lx.home();
  assert.equal(home.title, "LX Source");
  assert.ok(home.sections.length > 0);

  const page = await lx.browse({ page: "sources" });
  const text = JSON.stringify(page);
  assert.match(text, /测试音源/);
  assert.match(text, /网易云音乐/);
});

test("ID 编解码把搜索结果还原成 musicInfo", async () => {
  const result = await lx.search({ query: "春日影", kind: "tracks", offset: 0 });
  const wy = result.tracks.find((track) => track.id.startsWith("wy:"));
  assert.ok(wy, "应该有一条网易云的结果");
  const stream = await lx.stream({ id: wy.id, quality: "standard" });
  assert.match(stream.url, new RegExp(`wy/${wy.id.slice(3)}\\.mp3`));
});

// 另一种写法：module.exports = { sources }，动作直接挂在源上。顺便验证
// utils.buffer 能把字符串转成十六进制。
const EXPORTS_FIXTURE = `module.exports = {
  sources: {
    tx: {
      name: 'tx',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k'],
      musicUrl(musicInfo, quality) {
        const hex = globalThis.lx.utils.buffer.bufToString(globalThis.lx.utils.buffer.from('hi'), 'hex')
        return 'https://cdn.example.com/tx/' + musicInfo.strMediaMid + '/' + quality + '-' + hex + '.m4a'
      },
    },
  },
}
`;

test("module.exports 写法与 utils.buffer 都能用", async () => {
  settings.set("script", EXPORTS_FIXTURE);
  await lx.setSetting({ key: "script", value: EXPORTS_FIXTURE });
  const stream = await lx.stream({ id: "tx:004Fy3wu3A1gHG:004Fy3wu3A1gHG", quality: "standard" });
  assert.equal(stream.url, "https://cdn.example.com/tx/004Fy3wu3A1gHG/128k-6869.m4a");
  assert.equal(stream.type, "m4a");
  assert.equal(stream.quality, "standard");
});

// 两个地址的脚本，一个立刻给地址，一个慢半秒：应该拿到快的那份。
function slowScript(delay, host) {
  return `/**
 * @name 慢音源 ${host}
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ action }) =>
  new Promise((resolve) =>
    setTimeout(() => resolve('https://${host}/song.mp3'), ${delay}),
  ),
)
send(EVENT_NAMES.inited, {
  sources: { wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
})
`;
}

test("多个音源并发，最快给出地址的赢", async (t) => {
  const fast = slowScript(0, "fast.example.com");
  const slow = slowScript(400, "slow.example.com");

  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/javascript");
    response.end(request.url === "/slow.js" ? slow : fast);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const urls = `http://127.0.0.1:${port}/slow.js, http://127.0.0.1:${port}/fast.js`;
  settings.set("scriptUrls", urls);
  await lx.setSetting({ key: "scriptUrls", value: urls });

  const started = Date.now();
  const stream = await lx.stream({ id: "wy:123", quality: "high" });
  assert.equal(stream.url, "https://fast.example.com/song.mp3");
  assert.ok(Date.now() - started < 400, "不该等慢的那个");
});

test("音源全都失败时报错，并说清每个怎么失败的", async (t) => {
  const broken = `/**
 * @name 坏音源
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.reject(new Error('接口挂了')))
send(EVENT_NAMES.inited, {
  sources: { wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
})
`;
  const server = createServer((request, response) => response.end(broken));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const urls = `http://127.0.0.1:${port}/a.js, http://127.0.0.1:${port}/b.js`;
  settings.set("scriptUrls", urls);
  await lx.setSetting({ key: "scriptUrls", value: urls });

  await assert.rejects(
    () => lx.stream({ id: "wy:123", quality: "high" }),
    (error) => {
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /接口挂了/);
      assert.match(error.message, /坏音源/);
      return true;
    },
  );
});
