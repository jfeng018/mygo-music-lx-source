// MyGo Music 插件：把洛雪音乐（LX Music）的自定义音源脚本接到 MyGo Music 上。
//
// LX 音源脚本只做一件事：把一首歌的 ID 换成播放地址（musicUrl）。搜索、
// 专辑、歌手这些客户端自己的事它不管，所以这个插件自己做搜索（网易云 /
// QQ 音乐），拿到 songmid 之后再交给音源脚本换地址。
//
// 音源脚本从设置里的地址下载，缓存起来，用 new Function 在插件的沙箱里
// 跑，并补上脚本需要的 globalThis.lx（request / utils / EVENT_NAMES）。
//
// 注意：MyGo 加载模块时握着 storage 的锁，所以这里所有 host 调用都放在
// 导出的函数里，模块顶层只定义常量和函数。

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SEARCH_LIMIT = 30;
const SCRIPT_TTL = 10 * 60 * 1000; // 音源脚本缓存多久
const STREAM_TIMEOUT = 10000; // 一个音源多久没回应就不再等它
const TRACK_CACHE_MAX = 600;

const PLATFORM_LABEL = { wy: "网易云音乐", tx: "QQ 音乐" };
const PLATFORM_SHORT = { wy: "网易云", tx: "QQ" };

// MyGo 的音质是 standard / high / lossless，LX 的是 128k / 320k / flac。
const QUALITY_CHAIN = {
  standard: ["128k"],
  high: ["320k", "128k"],
  lossless: ["flac", "flac24bit", "hires", "320k", "128k"],
};

function t(text) {
  return host.t(text);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function secure(url) {
  return typeof url === "string" ? url.replace(/^http:\/\//, "https://") : "";
}

function formBody(object) {
  return Object.keys(object)
    .filter((key) => object[key] != null)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(object[key])}`)
    .join("&");
}

// ---------------------------------------------------------------- Buffer ----

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function utf8Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(out);
}

function utf8String(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i++];
    let code;
    if (byte < 0x80) code = byte;
    else if (byte < 0xe0) code = ((byte & 31) << 6) | (bytes[i++] & 63);
    else if (byte < 0xf0) code = ((byte & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else
      code =
        ((byte & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
    } else out += String.fromCharCode(code);
  }
  return out;
}

function base64Encode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

function base64Decode(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0);
    out.push((n >> 16) & 255);
    if (i + 2 < clean.length) out.push((n >> 8) & 255);
    if (i + 3 < clean.length) out.push(n & 255);
  }
  return new Uint8Array(out);
}

function hexEncode(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexDecode(text) {
  const clean = String(text).replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToString(bytes, encoding = "utf8") {
  const format = String(encoding).toLowerCase().replace(/[-_]/g, "");
  if (format === "hex") return hexEncode(bytes);
  if (format === "base64") return base64Encode(bytes);
  if (format === "latin1" || format === "binary") {
    let out = "";
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
  }
  return utf8String(bytes);
}

// 不用 class extends Uint8Array：有的 Go JS 引擎子类化内置类型会直接报错。
// 换成把原型指过去，实例仍然是真正的 Uint8Array，索引和 length 照常。
const LXBufferProto = Object.create(Uint8Array.prototype);
LXBufferProto.toString = function (encoding) {
  return bytesToString(this, encoding);
};

function toBuffer(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  Object.setPrototypeOf(view, LXBufferProto);
  return view;
}

const LXBuffer = {
  from(value, encoding) {
    if (typeof value === "string") {
      const format = String(encoding || "utf8").toLowerCase().replace(/[-_]/g, "");
      if (format === "hex") return toBuffer(hexDecode(value));
      if (format === "base64") return toBuffer(base64Decode(value));
      if (format === "latin1" || format === "binary") {
        const out = new Uint8Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
        return toBuffer(out);
      }
      return toBuffer(utf8Bytes(value));
    }
    if (value instanceof ArrayBuffer) return toBuffer(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return toBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    if (Array.isArray(value)) return toBuffer(new Uint8Array(value));
    return toBuffer(new Uint8Array(0));
  },

  alloc(size) {
    return toBuffer(new Uint8Array(Number(size) || 0));
  },

  concat(list, total) {
    const length = total == null ? list.reduce((sum, item) => sum + item.length, 0) : total;
    const out = new Uint8Array(length);
    let at = 0;
    for (const item of list) {
      out.set(item, at);
      at += item.length;
    }
    return toBuffer(out);
  },

  isBuffer(value) {
    return !!value && Object.getPrototypeOf(value) === LXBufferProto;
  },
};

// ------------------------------------------------------------ lx runtime ----

function lxRequest(url, options, callback) {
  const settings = options || {};
  let cancelled = false;
  let controller = null;
  try {
    controller = new AbortController();
  } catch {
    controller = null;
  }

  const init = {
    method: (settings.method || "GET").toUpperCase(),
    headers: { "User-Agent": UA, ...(settings.headers || {}) },
  };
  if (controller) init.signal = controller.signal;

  if (settings.body != null) {
    init.body = typeof settings.body === "string" ? settings.body : JSON.stringify(settings.body);
  } else if (settings.form) {
    init.body = formBody(settings.form);
    init.headers["Content-Type"] = init.headers["Content-Type"] || "application/x-www-form-urlencoded";
  } else if (settings.formData) {
    const form = new FormData();
    for (const key of Object.keys(settings.formData)) form.append(key, settings.formData[key]);
    init.body = form;
  }

  const timeout = Number(settings.timeout) > 0 ? Number(settings.timeout) : 20000;

  (async () => {
    let timer = null;
    try {
      const work = (async () => {
        const response = await fetch(url, init);
        const text = await response.text();
        const headers = {};
        try {
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
        } catch {}
        let body = text;
        try {
          body = JSON.parse(text);
        } catch {}
        return { statusCode: response.status, headers, body };
      })();

      const result = await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`请求超时: ${url}`)), timeout);
        }),
      ]);
      if (!cancelled) callback(null, result);
    } catch (error) {
      if (!cancelled) callback(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (timer) clearTimeout(timer);
    }
    // 脚本的回调自己抛错时别把整个插件带下水。
  })().catch(() => {});

  return () => {
    cancelled = true;
    if (controller) {
      try {
        controller.abort();
      } catch {}
    }
  };
}

function makeUtils() {
  return {
    buffer: {
      from: (value, encoding) => LXBuffer.from(value, encoding),
      bufToString: (buffer, format) => bytesToString(LXBuffer.from(buffer), format),
    },
    crypto: {
      md5: (text) => host.crypto.md5(String(text)),
      randomBytes: (size) => {
        const length = Math.max(1, Number(size) || 16);
        let out = "";
        for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 16).toString(16);
        return out;
      },
      aesEncrypt: (buffer, mode, key, iv) => {
        const algorithm = String(mode || "aes-128-ecb").toLowerCase();
        if (!algorithm.includes("ecb")) {
          throw new Error(`这个插件只支持 AES-ECB，脚本要的是 ${algorithm}`);
        }
        const plain = bytesToString(LXBuffer.from(buffer), "utf8");
        const secret = typeof key === "string" ? key : bytesToString(LXBuffer.from(key), "utf8");
        return LXBuffer.from(host.crypto.aesEcbEncrypt(secret, plain), "hex");
      },
      rsaEncrypt: () => {
        throw new Error("这个插件不支持 RSA 加密，请换一个音源脚本");
      },
    },
    zlib: {
      inflate: () => Promise.reject(new Error("这个插件不支持 zlib")),
      deflate: () => Promise.reject(new Error("这个插件不支持 zlib")),
    },
  };
}

function requireShim(name) {
  if (name === "buffer") return { Buffer: LXBuffer };
  if (name === "crypto") {
    return {
      createHash: () => {
        let text = "";
        return {
          update(value) {
            text += String(value);
            return this;
          },
          digest(encoding) {
            const hex = host.crypto.md5(text);
            return encoding === "hex" ? hex : LXBuffer.from(hex, "hex");
          },
        };
      },
    };
  }
  throw new Error(`音源脚本 require("${name}") 不受支持`);
}

// 脚本在 new Function 里跑，globalThis 被参数遮住，所以给它一个以真实
// globalThis 为原型、只多一个 lx 的对象：console、setTimeout 照样能用。
function sandboxGlobal(lx) {
  const sandbox = Object.create(globalThis);
  sandbox.lx = lx;
  // 有些脚本拿 process 判断自己跑在哪，给一个够用的假货。
  sandbox.process = {
    version: "v20.0.0",
    platform: host.platform === "windows" ? "win32" : host.platform,
    arch: host.arch,
    env: {},
    nextTick: (fn) => setTimeout(fn, 0),
  };
  return sandbox;
}

function compileScript(code, info) {
  const listeners = {};
  let inited = null;
  let alert = null;

  const lx = {
    version: "2.0.0",
    env: "desktop",
    currentScriptInfo: info,
    EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },
    on(name, handler) {
      if (typeof handler === "function") (listeners[name] || (listeners[name] = [])).push(handler);
    },
    send(name, data) {
      if (name === "inited") inited = data || {};
      else if (name === "updateAlert") alert = data || null;
    },
    request: lxRequest,
    utils: makeUtils(),
  };

  const module = { exports: {} };
  const factory = new Function(
    "globalThis",
    "lx",
    "module",
    "exports",
    "require",
    "Buffer",
    "console",
    `${code}\n//# sourceURL=lx-source.js`,
  );
  factory(sandboxGlobal(lx), lx, module, module.exports, requireShim, LXBuffer, console);

  const exported = module.exports || {};
  const sources = exported.sources || (inited && inited.sources) || {};
  const handler = (listeners.request || [])[0] || null;
  if (!handler && !Object.keys(sources).length) {
    throw new Error("脚本没有导出任何音源（既没有 sources，也没有注册 request 事件）");
  }
  return { info, sources, handler, alert };
}

function scriptInfo(code) {
  const read = (key) => {
    const match = new RegExp(`@${key}\\s+(.+)`).exec(code);
    return match ? match[1].trim() : "";
  };
  return {
    name: read("name") || "LX 音源",
    description: read("description"),
    version: read("version"),
    author: read("author"),
    homepage: read("homepage"),
    rawScript: code,
  };
}

// -------------------------------------------------------------- sources ----

// 编译好的音源，按脚本地址列表缓存，避免每次搜索都重新跑一遍脚本。
let compiled = { key: "", at: 0, runtimes: [], errors: [] };

// 多个脚本地址，逗号、分号、空格或换行分隔；只有一个的时候也认。
function scriptUrls() {
  const many = (host.setting("scriptUrls") || "").trim();
  const one = many ? "" : (host.setting("scriptUrl") || "").trim();
  const list = (many || one)
    .split(/[\s,，;；]+/)
    .map((url) => url.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

async function fetchScript(url) {
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) throw new Error(`下载音源脚本失败 (${response.status})`);
  const code = await response.text();
  if (!code.trim()) throw new Error("音源脚本是空的");
  return code;
}

// 所有脚本一起加载：下载并行，编译各自独立，一个坏了不影响其他的。
async function loadedScripts(force) {
  const urls = scriptUrls();
  const inline = (host.setting("script") || "").trim();
  const key = `${urls.join("|")}#${inline ? host.crypto.md5(inline) : ""}`;

  if (!urls.length && !inline) {
    compiled = { key: "", at: 0, runtimes: [], errors: [] };
    return compiled;
  }
  if (!force && compiled.key === key && compiled.at && Date.now() - compiled.at < SCRIPT_TTL) {
    return compiled;
  }

  const errors = [];
  const codes = [];

  const answers = await Promise.allSettled(urls.map((url) => fetchScript(url)));
  answers.forEach((answer, index) => {
    if (answer.status === "fulfilled") codes.push({ url: urls[index], code: answer.value });
    else errors.push(`${urls[index]}：${(answer.reason && answer.reason.message) || answer.reason}`);
  });
  if (inline) codes.push({ url: "", code: inline });

  const runtimes = [];
  for (const { url, code } of codes) {
    const info = scriptInfo(code);
    if (url) info.url = url;
    try {
      runtimes.push(compileScript(code, info));
    } catch (error) {
      errors.push(`${info.name}：${error.message}`);
    }
  }

  compiled = { key, at: Date.now(), runtimes, errors };
  return compiled;
}

async function callSource(runtime, source, action, info) {
  if (runtime.handler) {
    const answer = await runtime.handler({ source, action, info });
    return answer;
  }
  const entry = runtime.sources[source];
  if (entry && typeof entry[action] === "function") {
    return await entry[action](info.musicInfo, info.type);
  }
  throw new Error(`音源 ${runtime.info.name} 不支持 ${source} 的 ${action}`);
}

function availableSources(runtimes) {
  const map = {};
  for (const runtime of runtimes) {
    for (const source of Object.keys(runtime.sources || {})) {
      if (runtime.sources[source] && runtime.sources[source].type !== "local") map[source] = true;
    }
  }
  return Object.keys(map);
}

// ---------------------------------------------------------------- tracks ----

// 从 ID 里认出平台和最少的信息，不碰 storage：搜索排序时每首都要用。
function parseId(id) {
  const text = String(id);
  const cut = text.indexOf(":");
  if (cut < 0) throw fail("unavailable", `认不出这个歌曲 ID：${text}`);
  const source = text.slice(0, cut);
  const rest = text.slice(cut + 1);

  if (source === "wy") {
    return { source, musicInfo: { source, songmid: rest, songId: rest, id: rest } };
  }
  if (source === "tx") {
    const [mid, media] = rest.split(":");
    return {
      source,
      musicInfo: { source, songmid: mid, strMediaMid: media || mid, songId: mid, id: mid },
    };
  }
  return { source, musicInfo: { source, songmid: rest, hash: rest } };
}

function decodeId(id) {
  const parsed = parseId(id);
  const cache = host.storage.get("tracks") || {};
  const known = cache[String(id)] || {};
  return { source: parsed.source, musicInfo: { ...parsed.musicInfo, ...known } };
}

function remember(tracks) {
  const cache = host.storage.get("tracks") || {};
  for (const track of tracks) {
    const { source, musicInfo } = parseId(track.id);
    cache[track.id] = {
      ...musicInfo,
      name: track.name,
      singer: (track.artists || []).map((artist) => artist.name).join(", "),
      albumName: track.album ? track.album.name : "",
      albumId: track.album ? track.album.id : "",
      img: track.album ? track.album.imageUrl : "",
      interval: track.duration,
    };
  }
  const keys = Object.keys(cache);
  if (keys.length > TRACK_CACHE_MAX) {
    for (const key of keys.slice(0, keys.length - TRACK_CACHE_MAX)) delete cache[key];
  }
  host.storage.set("tracks", cache);
}

// --------------------------------------------------------------- search ----

async function searchWY(query, offset) {
  const response = await fetch("https://music.163.com/api/cloudsearch/pc", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://music.163.com/",
      "User-Agent": UA,
    },
    body: formBody({ s: query, type: 1, limit: SEARCH_LIMIT, offset }),
  });
  if (!response.ok) throw new Error(`网易云搜索失败 (${response.status})`);
  const data = await response.json();
  const songs = (data && data.result && data.result.songs) || [];
  return songs.map((song) => {
    const cover = secure(song.al && song.al.picUrl);
    return {
      id: `wy:${song.id}`,
      name: song.name,
      artists: (song.ar || []).map((artist) => ({ id: String(artist.id), name: artist.name })),
      album: {
        id: String((song.al && song.al.id) || ""),
        name: (song.al && song.al.name) || "",
        imageUrl: cover ? `${cover}?param={size}y{size}` : "",
      },
      duration: song.dt || 0,
      url: `https://music.163.com/song?id=${song.id}`,
    };
  });
}

async function searchTX(query, offset) {
  const page = Math.floor(offset / SEARCH_LIMIT) + 1;
  const url =
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}` +
    `&format=json&n=${SEARCH_LIMIT}&p=${page}&new_json=1&cr=1&t=0`;
  const response = await fetch(url, {
    headers: { Referer: "https://y.qq.com/", "User-Agent": UA },
  });
  if (!response.ok) throw new Error(`QQ 音乐搜索失败 (${response.status})`);
  const data = await response.json();
  const songs = (data && data.data && data.data.song && data.data.song.list) || [];
  return songs.map((song) => {
    const albumMid = (song.album && song.album.mid) || "";
    const mediaMid = (song.file && song.file.media_mid) || song.mid;
    return {
      id: `tx:${song.mid}:${mediaMid}`,
      name: song.title || song.name,
      artists: (song.singer || []).map((artist) => ({ id: String(artist.mid || artist.id), name: artist.name })),
      album: {
        id: albumMid || String((song.album && song.album.id) || ""),
        name: (song.album && song.album.name) || "",
        imageUrl: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : "",
      },
      duration: (song.interval || 0) * 1000,
      url: `https://y.qq.com/n/ryqq/songDetail/${song.mid}`,
    };
  });
}

const SEARCHERS = { wy: searchWY, tx: searchTX };

function platformsToSearch() {
  const chosen = (host.setting("platform") || "auto").trim();
  if (SEARCHERS[chosen]) return [chosen];
  return ["wy", "tx"];
}

// ------------------------------------------------------------- exported ----

export async function setSetting({ key, value }) {
  if (key === "scriptUrls" || key === "scriptUrl" || key === "script") {
    compiled = { key: "", at: 0, runtimes: [], error: null };
    try {
      await loadedScripts(true);
      host.storage.remove("lastError");
    } catch (error) {
      // 存起来就好，错误在首页和播放时再说
      host.storage.set("lastError", error.message);
    }
  }
}

export async function search({ query, kind, offset }) {
  if (kind !== "tracks") return { [kind]: [], more: false };
  const text = String(query || "").trim();
  if (!text) return { tracks: [], more: false };

  const platforms = platformsToSearch();
  const settled = await Promise.allSettled(platforms.map((platform) => SEARCHERS[platform](text, offset || 0)));
  const tracks = [];
  const errors = [];
  let more = false;

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      tracks.push(...result.value);
      if (result.value.length >= SEARCH_LIMIT) more = true;
    } else {
      errors.push(`${PLATFORM_LABEL[platforms[index]]}: ${result.reason && result.reason.message}`);
    }
  });

  if (!tracks.length && errors.length) throw new Error(errors.join("；"));
  if (!tracks.length) return { tracks: [], more: false };

  // 有音源能播的平台排在前面，省得点开才发现播不了。
  const playable = new Set(availableSources((await loadedScripts()).runtimes));
  const rank = (track) => (playable.has(parseId(track.id).source) ? 0 : 1);
  tracks.sort((a, b) => rank(a) - rank(b));

  remember(tracks);
  return { tracks, more };
}

export async function stream({ id, quality }) {
  const { source, musicInfo } = decodeId(id);
  const { runtimes } = await loadedScripts();
  const usable = runtimes.filter((runtime) => runtime.sources && runtime.sources[source]);
  if (!usable.length) {
    const name = PLATFORM_LABEL[source] || source;
    throw fail("setup", `还没有能播 ${name} 的音源，请在插件设置里填入 LX 音源脚本地址`);
  }

  // 每个音源同时要一次地址，谁先给出能播的就用谁，慢的不管了。
  const attempts = usable.map((runtime) => {
    const declared = (runtime.sources[source].qualitys || []).filter(Boolean);
    const chain = QUALITY_CHAIN[quality] || QUALITY_CHAIN.high;
    const picked = chain.find((item) => declared.includes(item)) || declared[0] || "128k";

    const promise = withTimeout(
      callSource(runtime, source, "musicUrl", { type: picked, musicInfo }),
      STREAM_TIMEOUT,
    ).then((answer) => {
      const url = typeof answer === "string" ? answer : answer && (answer.url || answer.data);
      if (!url || typeof url !== "string") throw new Error("没有给出地址");
      return { runtime, picked, url };
    });

    return { runtime, promise };
  });

  let winner;
  try {
    winner = await raceSources(attempts);
  } catch (error) {
    throw fail("unavailable", `音源都没给出地址：${error.message}`);
  }

  return { url: winner.url, type: typeOf(winner.url, winner.picked), quality: qualityOf(winner.picked) };
}

// 谁先成功用谁；全都失败了才报错，错误里带上每个音源的说法。
function raceSources(attempts) {
  return new Promise((resolve, reject) => {
    let left = attempts.length;
    const errors = [];
    for (const attempt of attempts) {
      attempt.promise.then(resolve, (error) => {
        errors.push(`${attempt.runtime.info.name}：${(error && error.message) || error}`);
        if (--left === 0) reject(new Error(errors.join("；")));
      });
    }
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${ms / 1000} 秒没有回应`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// 报给 MyGo 的音质要是实际拿到的那个，不然 lossless 的徽章会标错。
function qualityOf(picked) {
  if (/flac|hires|lossless|24bit/i.test(picked)) return "lossless";
  if (picked === "320k") return "high";
  return "standard";
}

function typeOf(url, quality) {
  const match = /\.(mp3|flac|m4a|aac|ogg|wav)(?:\?|#|$)/i.exec(url);
  if (match) return match[1].toLowerCase();
  if (/flac|hires/.test(quality)) return "flac";
  return "mp3";
}

export async function lyrics({ id }) {
  const { source, musicInfo } = decodeId(id);

  // 音源脚本自己能给歌词就先问它（local 源才有 lyric 动作）。
  const { runtimes } = await loadedScripts();
  for (const runtime of runtimes) {
    const entry = runtime.sources && runtime.sources[source];
    if (entry && Array.isArray(entry.actions) && entry.actions.includes("lyric")) {
      try {
        const answer = await callSource(runtime, source, "lyric", { musicInfo });
        if (answer && answer.lyric) return { lrc: answer.lyric, translation: answer.tlyric || "" };
      } catch {}
    }
  }

  try {
    if (source === "wy") {
      const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(musicInfo.songmid)}&lv=1&tv=1`;
      const response = await fetch(url, { headers: { Referer: "https://music.163.com/", "User-Agent": UA } });
      const data = await response.json();
      const lrc = data && data.lrc && data.lrc.lyric;
      if (lrc) return { lrc, translation: (data.tlyric && data.tlyric.lyric) || "" };
    }
    if (source === "tx") {
      const url =
        `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(musicInfo.songmid)}` +
        `&format=json&nobase64=0&g_tk=5381`;
      const response = await fetch(url, { headers: { Referer: "https://y.qq.com/", "User-Agent": UA } });
      let text = await response.text();
      const wrapped = /^[^(]*\((.*)\)[^)]*$/s.exec(text);
      if (wrapped) text = wrapped[1];
      const data = JSON.parse(text);
      const lrc = data && data.lyric ? bytesToString(base64Decode(data.lyric), "utf8") : "";
      if (lrc) return { lrc };
    }
  } catch {}

  throw fail("unsupported", "这首歌没有歌词");
}

export async function home() {
  const { runtimes, errors } = await loadedScripts();
  const sections = [];

  if (runtimes.length) {
    const sources = availableSources(runtimes);
    sections.push({
      title: t("Loaded sources"),
      subtitle: `${runtimes.length} · ${sources.map((source) => PLATFORM_SHORT[source] || source).join(" · ")}`,
      links: runtimes.map((runtime) => ({
        title: runtime.info.name,
        subtitle: sources.map((source) => PLATFORM_SHORT[source] || source).join(" · ") || t("No sources declared"),
        page: "sources",
      })),
    });
    sections.push({
      title: t("How it works"),
      links: [
        { title: t("Search for a song"), subtitle: t("Playable platforms come first") },
        {
          title: t("They race: the fastest answer plays"),
          subtitle: t("Add more script URLs to have more to choose from"),
        },
        { title: t("Source settings"), subtitle: t("Change the script, or see what it supports"), page: "sources" },
      ],
    });
  } else {
    sections.push({
      title: t("No source yet"),
      links: [
        {
          title: t("Fill in a script URL"),
          subtitle:
            errors[0] ||
            host.storage.get("lastError") ||
            t("Settings → Plugins → LX Source → Source script URLs"),
          page: "sources",
        },
      ],
      empty: t("An LX script only answers with a play URL; search is done by this plugin."),
    });
  }

  if (errors.length && runtimes.length) {
    sections.push({ title: t("Couldn't load"), empty: errors.join("\n") });
  }

  return { title: t("LX Source"), sections };
}

export async function browse({ page }) {
  if (page !== "sources") throw fail("unavailable", "没有这个页面");
  const { runtimes, errors } = await loadedScripts();
  const sections = [];

  if (runtimes.length) {
    for (const runtime of runtimes) {
      const sources = Object.keys(runtime.sources || {}).filter((key) => runtime.sources[key].type !== "local");
      sections.push({
        title: runtime.info.name,
        subtitle: [runtime.info.author, runtime.info.version].filter(Boolean).join(" · "),
        empty: t("This script declares no sources"),
        links: sources.map((source) => ({
          title: PLATFORM_LABEL[source] || source,
          subtitle: `${t("Quality")}: ${(runtime.sources[source].qualitys || []).join(" / ") || "—"}`,
        })),
      });
    }
  } else {
    sections.push({
      title: t("No source yet"),
      empty: t("Go to the settings and paste an LX source script URL, such as a raw GitHub link."),
    });
  }

  if (errors.length) {
    sections.push({ title: t("Couldn't load"), empty: errors.join("\n") });
  }

  sections.push({
    title: t("Note"),
    empty: t(
      "Source scripts come from third parties: this plugin only hands their play URLs to the player. A script may reach any host, so import only ones you trust.",
    ),
  });

  return { title: t("Sources"), sections };
}
