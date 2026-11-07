// 用假的 host 和 stub 过的 fetch 跑一遍插件，不依赖任何第三方 API。
// 只有给 fixture 用的本地 http 服务走真实网络；LX_ONLINE_TESTS=1 时额外打一次真实搜索接口。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createCipheriv } from "node:crypto";
import { createServer } from "node:http";

const store = new Map();
const settings = new Map();
const online = process.env.LX_ONLINE_TESTS === "1";
const fetchCalls = [];
let lyricFetches = 0;
let txSearchFails = false;

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

const realFetch = globalThis.fetch;

const WY_SONG = {
  id: 2097485069,
  name: "春日影",
  ar: [{ id: 1, name: "MyGo" }],
  al: { id: 11, name: "专辑", picUrl: "http://p1.music.126.net/cover.jpg" },
  dt: 240000,
};
const TX_SONG = {
  mid: "004Fy3wu3A1gHG",
  file: { media_mid: "004Fy3wu3A1gHG" },
  title: "春日影",
  singer: [{ mid: "s1", name: "MyGo" }],
  album: { mid: "a1", name: "专辑" },
  interval: 240,
};

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function textResponse(text) {
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
}

function probeResponse(status) {
  return { ok: status < 400, status, json: async () => ({}), text: async () => "" };
}

globalThis.fetch = async (url, init) => {
  const target = String(url);
  fetchCalls.push(target);
  if (target.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (target.includes("client_search_cp") && txSearchFails) throw new Error("QQ 挂了");
  if (online && (target.includes("cloudsearch/pc") || target.includes("client_search_cp"))) {
    return realFetch(url, init);
  }
  if (target.includes("cloudsearch/pc")) return jsonResponse({ result: { songs: [WY_SONG] } });
  if (target.includes("client_search_cp")) return jsonResponse({ data: { song: { list: [TX_SONG] } } });
  if (target.includes("api/song/lyric")) {
    lyricFetches++;
    return jsonResponse({ lrc: { lyric: "[00:00.00]wy 歌词" }, tlyric: { lyric: "[00:00.00]翻译" } });
  }
  if (target.includes("fcg_query_lyric_new.fcg")) {
    lyricFetches++;
    const lyric = Buffer.from("[00:00.00]tx 歌词").toString("base64");
    return textResponse(`cb(${JSON.stringify({ lyric })})`);
  }
  if (target.includes("dead.example.com")) return probeResponse(404);
  return probeResponse(206);
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
  assert.equal(store.get("lastSource"), "测试音源 · high");
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
  settings.set("script", "");
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
  settings.set("script", "");
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

function urlScript(name, target) {
  return `/**
 * @name ${name}
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.resolve('${target}'))
send(EVENT_NAMES.inited, {
  sources: { wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
})
`;
}

test("死链探测失败后继续用好链", async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/javascript");
    response.end(
      request.url.startsWith("/dead")
        ? urlScript("死链音源", "https://dead.example.com/x.mp3")
        : urlScript("好链音源", "https://good.example.com/x.mp3"),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const urls = `http://127.0.0.1:${port}/dead.js, http://127.0.0.1:${port}/good.js`;
  settings.set("script", "");
  settings.set("scriptUrls", urls);
  await lx.setSetting({ key: "scriptUrls", value: urls });

  const stream = await lx.stream({ id: "wy:123", quality: "standard" });
  assert.equal(stream.url, "https://good.example.com/x.mp3");
});

const MULTI_FIXTURE = `/**
 * @name 多监听器
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.reject(new Error('unsupported')))
on(EVENT_NAMES.request, ({ source, info }) =>
  Promise.resolve('https://cdn.example.com/' + source + '/' + info.musicInfo.songmid + '.mp3'))
send(EVENT_NAMES.inited, {
  sources: { wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
})
`;

test("多个 request 监听器会依次尝试", async () => {
  settings.set("scriptUrls", "");
  settings.set("script", MULTI_FIXTURE);
  await lx.setSetting({ key: "script", value: MULTI_FIXTURE });
  const stream = await lx.stream({ id: "wy:1", quality: "standard" });
  assert.equal(stream.url, "https://cdn.example.com/wy/1.mp3");
});

const HASH_FIXTURE = `/**
 * @name 摘要音源
 * @version 1.0.0
 */
const crypto = require('crypto')
crypto.createHash('sha256').update('x').digest('hex')
module.exports = {
  sources: {
    wy: {
      name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k'],
      musicUrl() { return 'https://cdn.example.com/x.mp3' },
    },
  },
}
`;

test("非 md5 摘要会明确报错", async () => {
  settings.set("scriptUrls", "");
  settings.set("script", HASH_FIXTURE);
  await lx.setSetting({ key: "script", value: HASH_FIXTURE });
  const page = await lx.browse({ page: "sources" });
  assert.match(JSON.stringify(page), /sha256/);
});

function sourceScript(name, source) {
  return `/**
 * @name ${name}
 * @version 1.0.0
 */
module.exports = {
  sources: {
    ${source}: {
      name: '${source}', type: 'music', actions: ['musicUrl'], qualitys: ['128k'],
      musicUrl() { return 'https://cdn.example.com/${source}.mp3' },
    },
  },
}
`;
}

test("URL 里的逗号分号不会被切断，首页按脚本列平台", async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/javascript");
    response.end(request.url.startsWith("/a.js") ? sourceScript("只支持 wy", "wy") : sourceScript("只支持 tx", "tx"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const urls = `http://127.0.0.1:${port}/a.js?token=1,2;3, http://127.0.0.1:${port}/b.js`;
  settings.set("script", "");
  settings.set("scriptUrls", urls);
  await lx.setSetting({ key: "scriptUrls", value: urls });

  const home = await lx.home();
  const loaded = home.sections[0];
  assert.match(loaded.subtitle, /^2 ·/);
  assert.deepEqual(loaded.links.map((link) => link.subtitle), ["网易云", "QQ"]);
});

test("单平台搜索失败会记录并在首页显示", async () => {
  txSearchFails = true;
  try {
    const result = await lx.search({ query: "mygo", kind: "tracks", offset: 0 });
    assert.ok(result.tracks.length > 0);
    assert.match(store.get("lastSearchError"), /QQ 挂了/);
    const home = await lx.home();
    assert.match(JSON.stringify(home), /Last search problem/);
  } finally {
    txSearchFails = false;
  }
});

test("歌词会缓存，第二次不再请求", async () => {
  settings.set("scriptUrls", "");
  settings.set("script", "");
  await lx.setSetting({ key: "script", value: "" });
  const before = lyricFetches;
  const first = await lx.lyrics({ id: "wy:2097485069" });
  assert.match(first.lrc, /wy 歌词/);
  const second = await lx.lyrics({ id: "wy:2097485069" });
  assert.deepEqual(second, first);
  assert.equal(lyricFetches, before + 1);
});

test("local 源不参与在线播放", async () => {
  const local = `/**
 * @name 本地音源
 * @version 1.0.0
 */
module.exports = {
  sources: {
    wy: {
      name: 'wy', type: 'local', actions: ['musicUrl'], qualitys: ['128k'],
      musicUrl() { return 'https://cdn.example.com/local.mp3' },
    },
  },
}
`;
  settings.set("script", local);
  await lx.setSetting({ key: "script", value: local });
  await assert.rejects(
    () => lx.stream({ id: "wy:123", quality: "standard" }),
    (error) => error.code === "setup",
  );
  const page = await lx.browse({ page: "sources" });
  assert.doesNotMatch(JSON.stringify(page.sections[0]), /网易云音乐/);
});

test("搜索不触发音源脚本下载", async () => {
  settings.set("script", "");
  settings.set("scriptUrls", "https://slow.example.com/never.js");
  const before = fetchCalls.length;
  const result = await lx.search({ query: "mygo", kind: "tracks", offset: 0 });
  assert.ok(result.tracks.length > 0);
  assert.ok(!fetchCalls.slice(before).some((url) => url.includes("never.js")));
  settings.delete("scriptUrls");
});

if (online) {
  test("在线：真实搜索接口可用", async () => {
    const result = await lx.search({ query: "mygo", kind: "tracks", offset: 0 });
    assert.ok(result.tracks.length > 0);
  });
}
