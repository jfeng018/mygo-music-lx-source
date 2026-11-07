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
let qrPolls = 0;
let qrCodes = [803];
let qrSessionCookie = true;
const qrPrompts = [];
const qrRequestHeaders = [];
const qrEapiCalls = [];

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

function responseHeaders(setCookies) {
  const lines = setCookies || [];
  return {
    getSetCookie: () => lines,
    get: (name) => (String(name).toLowerCase() === "set-cookie" ? lines.join(", ") : null),
  };
}

function jsonResponse(data, setCookies) {
  return {
    ok: true,
    status: 200,
    headers: responseHeaders(setCookies),
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function textResponse(text) {
  return { ok: true, status: 200, headers: responseHeaders(), json: async () => JSON.parse(text), text: async () => text };
}

function probeResponse(status) {
  return { ok: status < 400, status, headers: responseHeaders(), json: async () => ({}), text: async () => "" };
}

function musicuFixture(target) {
  let data = {};
  try {
    data = JSON.parse(new URL(target).searchParams.get("data") || "{}");
  } catch {}
  if (data.topList) {
    return jsonResponse({ topList: { data: { group: [{ toplist: [{ topId: 26, title: "热门", headPicUrl: "" }] }] } } });
  }
  if (data.detail) {
    return jsonResponse({ detail: { data: { data: { title: "热门" }, songInfoList: [TX_SONG] } } });
  }
  if (data.pl) {
    return jsonResponse({ pl: { data: { songlist: [{ songinfo: TX_SONG }], total_song_num: 1 } } });
  }
  return jsonResponse({});
}

globalThis.fetch = async (url, init) => {
  const target = String(url);
  fetchCalls.push(target);
  if (target.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (target.includes("client_search_cp") && txSearchFails) throw new Error("曲库 B 挂了");
  const songSearch =
    (target.includes("cloudsearch/pc") && !String((init && init.body) || "").includes("type=1000")) ||
    target.includes("client_search_cp");
  if (online && songSearch) return realFetch(url, init);

  if (target.includes("cloudsearch/pc")) {
    if (String((init && init.body) || "").includes("type=1000")) {
      return jsonResponse({ result: { playlists: [{ id: 8232, name: "搜索歌单", coverImgUrl: "" }] } });
    }
    return jsonResponse({ result: { songs: [WY_SONG] } });
  }
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
  if (target.includes("musicu.fcg")) return musicuFixture(target);
  if (target.includes("/api/toplist/detail")) {
    return jsonResponse({ list: [{ id: 19723756, name: "飙升", coverImgUrl: "", updateFrequency: "每日" }] });
  }
  if (target.includes("/api/v6/playlist/detail")) {
    return jsonResponse({ playlist: { name: "歌单", tracks: [WY_SONG] } });
  }
  if (target.includes("/api/personalized/playlist")) {
    return jsonResponse({ result: [{ id: 8232, name: "推荐歌单", picUrl: "" }] });
  }
  if (target.includes("/api/v3/discovery/recommend/songs")) {
    return jsonResponse({ data: { dailySongs: [WY_SONG] } });
  }
  if (target.includes("/eapi/login/qrcode/")) {
    qrEapiCalls.push({ target, body: (init && init.body) || "", redirect: init && init.redirect });
  }
  if (target.includes("/eapi/login/qrcode/unikey")) {
    return jsonResponse({ code: 200, unikey: "test-unikey" }, ["NMTID=n1; Path=/"]);
  }
  if (target.includes("/eapi/login/qrcode/client/login")) {
    const code = qrCodes[Math.min(qrPolls, qrCodes.length - 1)];
    qrPolls++;
    qrRequestHeaders.push((init && init.headers) || {});
    const cookies = code === 803 && qrSessionCookie ? ["MUSIC_U=u1; Path=/", "__csrf=c1; Path=/"] : [];
    return jsonResponse({ code, message: "" }, cookies);
  }
  if (target.includes("/api/nuser/account/get")) {
    return jsonResponse({ profile: { userId: 42, nickname: "听友", avatarUrl: "" } });
  }
  if (target.includes("/api/user/playlist")) {
    return jsonResponse({ playlist: [{ id: 88, name: "我的歌单", coverImgUrl: "" }] });
  }
  if (target.includes("fcg_get_profile_homepage.fcg")) {
    return jsonResponse({
      data: { creator: { nick: "听友", headpic: "" }, mymusic: [{ title: "我喜欢", jumpurl: "taoge.html?id=99" }] },
    });
  }
  if (target.includes("client_music_search_songlist")) {
    return jsonResponse({ data: { list: [{ dissid: 77, dissname: "歌单 B", imgurl: "" }] } });
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
  assert.match(text, /Catalog A/);
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
  assert.deepEqual(loaded.links.map((link) => link.subtitle), ["A", "B"]);
});

test("单平台搜索失败会记录并在首页显示", async () => {
  txSearchFails = true;
  try {
    const result = await lx.search({ query: "mygo", kind: "tracks", offset: 0 });
    assert.ok(result.tracks.length > 0);
    assert.match(store.get("lastSearchError"), /曲库 B 挂了/);
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
  assert.deepEqual(page.sections[0].links, []);
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

// ---------------- 目录能力 ----------------

async function catalogSetting(key, value) {
  settings.set(key, value);
  await lx.setSetting({ key, value });
}

// 只缩短扫码轮询的等待，目录请求的超时定时器保持原值。
async function withFastQrPoll(fn) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) =>
    realSetTimeout(callback, ms > 1000 && ms < 2000 ? 1 : ms, ...args);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test("首页发现区只有链接，不出现曲库名称", async () => {
  await catalogSetting("catalog", "on");
  const home = await lx.home();
  const section = home.sections.find((item) => item.title === "Browse");
  assert.ok(section, "首页应该有发现入口");
  assert.ok(section.links.every((link) => link.page));
  assert.ok(!section.tracks, "首页不该拉曲目");
  assert.doesNotMatch(JSON.stringify(home), /网易|QQ 音乐|NetEase|QQ Music/);
});

test("榜单页按曲库分组，链接可直接打开", async () => {
  await catalogSetting("platform", "");
  const page = await lx.browse({ page: "charts" });
  assert.equal(page.title, "Charts");
  assert.equal(page.sections.length, 2);
  assert.match(page.sections[0].links[0].page, /^chart\|wy\|19723756\|0$/);
  assert.match(page.sections[1].links[0].page, /^chart\|tx\|26\|0$/);
});

test("榜单曲目沿用搜索 ID，可直接交给音源播放", async () => {
  settings.set("script", FIXTURE);
  await lx.setSetting({ key: "script", value: FIXTURE });
  const page = await lx.browse({ page: "chart|wy|19723756|0" });
  const id = page.sections[0].tracks[0].id;
  assert.equal(id, `wy:${WY_SONG.id}`);
  const stream = await lx.stream({ id, quality: "standard" });
  assert.equal(stream.url, `https://cdn.example.com/wy/${WY_SONG.id}.mp3`);
});

test("另一个曲库的榜单 ID 也带齐播放所需字段", async () => {
  const page = await lx.browse({ page: "chart|tx|26|0" });
  assert.equal(page.sections[0].tracks[0].id, `tx:${TX_SONG.mid}:${TX_SONG.file.media_mid}`);
});

test("歌单搜索返回中性 ID", async () => {
  const result = await lx.search({ query: "华语", kind: "playlists", offset: 0 });
  assert.ok(result.playlists.length >= 1);
  assert.ok(result.playlists.every((item) => /^(wy|tx):/.test(item.id)));
});

test("歌单详情给出可播曲目", async () => {
  const wy = await lx.playlist({ id: "wy:8232" });
  assert.equal(wy.tracks[0].id, `wy:${WY_SONG.id}`);
  const tx = await lx.playlist({ id: "tx:77" });
  assert.equal(tx.tracks[0].id, `tx:${TX_SONG.mid}:${TX_SONG.file.media_mid}`);
});

test("每日曲目在匿名状态下也能打开", async () => {
  const page = await lx.browse({ page: "daily" });
  assert.equal(page.sections.length, 2);
  assert.equal(page.sections[0].tracks[0].id, `wy:${WY_SONG.id}`);
  assert.equal(page.sections[1].tracks[0].id, `tx:${TX_SONG.mid}:${TX_SONG.file.media_mid}`);
});

test("曲库切换只影响选中的那一边", async () => {
  await catalogSetting("platform", "tx");
  const page = await lx.browse({ page: "charts" });
  assert.equal(page.sections.length, 1);
  assert.equal(page.sections[0].title, "Catalog B");
  const result = await lx.search({ query: "mygo", kind: "tracks", offset: 0 });
  assert.ok(result.tracks.every((track) => track.id.startsWith("tx:")));
  await catalogSetting("platform", "");
});

test("关掉目录后入口与能力都停用，搜索歌曲不受影响", async () => {
  await catalogSetting("catalog", "off");
  const home = await lx.home();
  assert.ok(!home.sections.some((item) => item.title === "Browse"));
  await assert.rejects(() => lx.browse({ page: "charts" }), (error) => error.code === "unsupported");
  assert.deepEqual((await lx.search({ query: "华语", kind: "playlists", offset: 0 })).playlists, []);
  assert.deepEqual(await lx.playlists(), []);
  await assert.rejects(() => lx.signIn(), (error) => error.code === "unsupported");
  await assert.rejects(() => lx.playlist({ id: "wy:8232" }), (error) => error.code === "unsupported");
  store.set("account", { id: "1", name: "x", source: "wy" });
  assert.equal(lx.account(), null);
  store.delete("account");
  assert.ok((await lx.search({ query: "mygo", kind: "tracks", offset: 0 })).tracks.length > 0);
  await catalogSetting("catalog", "on");
});

test("登录后同步本人歌单，退出登录即清除", async () => {
  globalThis.host.webSignIn = async () => ({ cookie: "MUSIC_U=abc; __csrf=1" });
  try {
    const signed = await lx.signIn();
    assert.equal(signed.id, "42");
    assert.equal(signed.page, "account");
    assert.deepEqual(lx.account(), signed);
    const lists = await lx.playlists();
    assert.ok(lists.some((item) => item.id === "wy:88" && item.mine));
    const page = await lx.browse({ page: "account" });
    assert.match(JSON.stringify(page), /我的歌单/);
    lx.signOut();
    assert.equal(lx.account(), null);
    assert.equal(store.has("credential:wy"), false);
  } finally {
    delete globalThis.host.webSignIn;
  }
});

test("扫码登录：显示二维码、轮询到确认并保存凭证", async () => {
  globalThis.host.signInPrompt = (prompt) => qrPrompts.push(prompt);
  qrCodes = [801, 802, 803];
  qrPolls = 0;
  qrSessionCookie = true;
  qrPrompts.length = 0;
  qrRequestHeaders.length = 0;
  qrEapiCalls.length = 0;
  try {
    const signed = await withFastQrPoll(() => lx.signIn());
    assert.equal(signed.id, "42");
    assert.equal(signed.page, "account");
    const texts = qrPrompts.map((item) => item.text);
    assert.ok(texts.includes("Preparing a sign-in QR code..."));
    assert.ok(texts.includes("Scan the QR code with your phone, then confirm there."));
    assert.ok(texts.includes("Scanned. Confirm the sign-in on your phone."));
    assert.ok(texts.includes("Signed in."));
    const withQr = qrPrompts.find((item) => item.qr);
    assert.equal(withQr.qr, "https://music.163.com/login?codekey=test-unikey");
    assert.equal(qrPolls, 3);
    assert.match(store.get("credential:wy"), /MUSIC_U=u1/);
    assert.match(store.get("credential:wy"), /__csrf=c1/);
    assert.match(qrRequestHeaders[0].Cookie, /NMTID=n1/);
    assert.equal(qrEapiCalls.length, 4);
    assert.match(qrEapiCalls[0].target, /\/eapi\/login\/qrcode\/unikey$/);
    assert.match(qrEapiCalls[0].body, /^params=[0-9A-F]+$/);
    assert.equal(qrEapiCalls[0].redirect, "error");
    assert.equal(store.has("lastSignInError"), false);
    assert.equal(lx.account().id, "42");
  } finally {
    delete globalThis.host.signInPrompt;
    qrCodes = [803];
    qrPolls = 0;
    qrSessionCookie = true;
    qrPrompts.length = 0;
    qrRequestHeaders.length = 0;
    qrEapiCalls.length = 0;
    lx.signOut();
  }
});

test("扫码登录：过期、缺会话、取消都明确报错", async () => {
  globalThis.host.signInPrompt = () => {};
  try {
    qrCodes = [800];
    qrPolls = 0;
    await assert.rejects(
      () => withFastQrPoll(() => lx.signIn()),
      (error) => error.code === "setup" && /expired/.test(error.message),
    );
    assert.match(store.get("lastSignInError"), /expired/);

    qrCodes = [803];
    qrPolls = 0;
    qrSessionCookie = false;
    await assert.rejects(
      () => withFastQrPoll(() => lx.signIn()),
      (error) => error.code === "setup" && /did not return a session/.test(error.message),
    );

    qrCodes = [801];
    qrPolls = 0;
    qrSessionCookie = true;
    const pending = withFastQrPoll(() => lx.signIn());
    lx.signOut();
    await assert.rejects(pending, (error) => error.code === "unavailable");
  } finally {
    delete globalThis.host.signInPrompt;
    qrCodes = [803];
    qrPolls = 0;
    qrSessionCookie = true;
    store.delete("lastSignInError");
    lx.signOut();
  }
});

test("没有二维码 UI 时回退到网页窗口，另一个曲库也走网页窗口", async () => {
  const calls = [];
  globalThis.host.webSignIn = async (options) => {
    calls.push(options);
    return { cookie: "MUSIC_U=abc; __csrf=1" };
  };
  try {
    await lx.signIn();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://music.163.com/login");
    await catalogSetting("platform", "tx");
    await lx.signIn();
    assert.equal(calls[1].url, "https://y.qq.com/");
  } finally {
    delete globalThis.host.webSignIn;
    await catalogSetting("platform", "");
    lx.signOut();
  }
});

test("未登录打开我的歌单会提示登录", async () => {
  await assert.rejects(() => lx.browse({ page: "mine" }), (error) => error.code === "signIn");
});

test("交付文件里不出现任何曲库名称", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["README.md", "plugin.json", "locales/zh-CN.json", "index.js"]) {
    const text = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /网易云|QQ 音乐|NetEase Cloud Music|QQ Music|酷狗|汽水音乐/, file);
  }
});

test("文档保留出处，但不写参考或照搬语义", async () => {
  const { readFile } = await import("node:fs/promises");
  const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  assert.match(readme, /洛雪音乐（LX Music）/);
  assert.match(readme, /MyGo Music/);
  assert.match(readme, /github\.com/);
  assert.doesNotMatch(readme + source, /参考|借鉴|抄|复刻|照搬|based on|adapted from/i);
});

test("所有界面文案都有中文翻译", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./index.js", import.meta.url), "utf8");
  const plugin = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
  const locales = JSON.parse(await readFile(new URL("./locales/zh-CN.json", import.meta.url), "utf8"));
  const keys = [...src.matchAll(/\bt\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
  const texts = [
    ...plugin.settings.flatMap((item) => [item.label, item.help]),
    ...plugin.navigation.map((item) => item.title),
    "Catalog A",
    "Catalog B",
  ];
  const missing = [...new Set([...keys, ...texts])].filter((key) => !(key in locales));
  assert.deepEqual(missing, []);
});

if (online) {
  test("在线：真实搜索接口可用", async () => {
    const result = await lx.search({ query: "mygo", kind: "tracks", offset: 0 });
    assert.ok(result.tracks.length > 0);
  });
}
