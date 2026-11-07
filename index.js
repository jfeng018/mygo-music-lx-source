// MyGo Music 插件：把洛雪音乐（LX Music）的自定义音源脚本接到 MyGo Music 上。
//
// LX 音源脚本只做一件事：把一首歌的 ID 换成播放地址（musicUrl）。搜索、
// 目录这些客户端自己的事它不管，所以这个插件自己做搜索和榜单/歌单索引，
// 拿到 ID 之后再交给音源脚本换地址。曲库对外只用中性代号 A / B。
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
const SCRIPT_FETCH_TIMEOUT = 5000; // 下载一个音源脚本最多等多久
const URL_CHECK_TIMEOUT = 2500; // 探测播放地址最多等多久
const STREAM_TIMEOUT = 10000; // 一个音源多久没回应就不再等它
const TRACK_CACHE_MAX = 600;
const LYRIC_CACHE_MAX = 200;
const CATALOG_TTL = 5 * 60 * 1000;
const CATALOG_TIMEOUT = 8000;
const CATALOG_PAGE = 30;
const CHART_LINK_MAX = 24;
const PLAYLIST_LINK_MAX = 12;
const PLAYLIST_TRACK_MAX = 100;
const HOT_CHART_ID = "26";

// 展示层只用中性代号：wy / tx 是音源脚本里的 source key，不对外展开成名称。
const CATALOG_LABEL = { wy: "Catalog A", tx: "Catalog B" };
const CATALOG_SHORT = { wy: "A", tx: "B" };

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

function newController() {
  try {
    return new AbortController();
  } catch {
    return null;
  }
}

function lxRequest(url, options, callback) {
  const settings = options || {};
  let cancelled = false;
  const controller = newController();

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
          timer = setTimeout(() => {
            // 超时后把请求本身停掉，不然慢源会一直挂在后台。
            if (controller) {
              try {
                controller.abort();
              } catch {}
            }
            reject(new Error(`请求超时: ${url}`));
          }, timeout);
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
        const bytes = new Uint8Array(length);
        const provider = globalThis.crypto;
        if (provider && typeof provider.getRandomValues === "function") provider.getRandomValues(bytes);
        else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
        // 和 LX 保持一致：一个字节给一个十六进制字符，长度就是 size。
        let out = "";
        for (const byte of bytes) out += (byte & 15).toString(16);
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
      createHash(algorithm) {
        const digest = String(algorithm || "md5").toLowerCase();
        if (digest !== "md5") throw new Error(`这个插件只支持 md5 摘要，脚本要的是 ${digest}`);
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
  // 第三方脚本不该碰到宿主的设置和存储；这只是防误用，不是安全隔离。
  sandbox.host = undefined;
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
  const pending = new Set();
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
    request(url, options, callback) {
      let stop;
      const cancel = lxRequest(url, options, (error, result) => {
        pending.delete(stop);
        callback(error, result);
      });
      stop = () => {
        pending.delete(stop);
        cancel();
      };
      pending.add(stop);
      return stop;
    },
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
  const handlers = listeners.request || [];
  if (!handlers.length && !Object.keys(sources).length) {
    throw new Error("脚本没有导出任何音源（既没有 sources，也没有注册 request 事件）");
  }
  return {
    info,
    sources,
    handlers,
    alert,
    cancelPending() {
      for (const cancel of pending) cancel();
    },
  };
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
let loading = null;

// 多个脚本地址按换行分隔；逗号、分号或空格只在后面紧跟另一个链接时才算分隔符，
// 免得把 URL query 里的 , 或 ; 切断。只有一个地址的时候也认。
function scriptUrls() {
  const many = (host.setting("scriptUrls") || "").trim();
  const one = many ? "" : (host.setting("scriptUrl") || "").trim();
  const list = (many || one)
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[,，;；\s]+(?=https?:\/\/)/i))
    .map((url) => url.trim().replace(/[,，;；\s]+$/, ""))
    .filter(Boolean);
  return [...new Set(list)];
}

async function fetchScript(url) {
  const controller = newController();
  const init = { headers: { "User-Agent": UA } };
  if (controller) init.signal = controller.signal;
  const timer = controller ? setTimeout(() => controller.abort(), SCRIPT_FETCH_TIMEOUT) : null;
  try {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`下载音源脚本失败 (${response.status})`);
    const code = await response.text();
    if (!code.trim()) throw new Error("音源脚本是空的");
    return code;
  } catch (error) {
    if (controller && controller.signal.aborted) {
      throw new Error(`下载音源脚本超时 (${SCRIPT_FETCH_TIMEOUT / 1000} 秒)`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 所有脚本一起加载：下载并行，编译各自独立，一个坏了不影响其他的。
async function loadScripts(urls, inline, key) {
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

async function loadedScripts(force) {
  const urls = scriptUrls();
  const inline = (host.setting("script") || "").trim();
  const key = `${urls.join("|")}#${inline ? host.crypto.md5(inline) : ""}`;

  if (!urls.length && !inline) {
    loading = null;
    compiled = { key: "", at: 0, runtimes: [], errors: [] };
    return compiled;
  }
  if (!force && compiled.key === key && compiled.at && Date.now() - compiled.at < SCRIPT_TTL) {
    return compiled;
  }
  // 并发的播放请求共用同一轮加载，别重复下载和编译。
  if (!force && loading && loading.key === key) return loading.promise;

  const promise = loadScripts(urls, inline, key);
  loading = { key, promise };
  try {
    return await promise;
  } finally {
    if (loading && loading.promise === promise) loading = null;
  }
}

async function callSource(runtime, source, action, info) {
  if (runtime.handlers.length) {
    let lastError = null;
    for (const handler of runtime.handlers) {
      try {
        const answer = await handler({ source, action, info });
        if (answer != null) return answer;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`音源 ${runtime.info.name} 不支持 ${source} 的 ${action}`);
  }
  const entry = runtime.sources[source];
  if (entry && typeof entry[action] === "function") {
    return await entry[action](info.musicInfo, info.type);
  }
  throw new Error(`音源 ${runtime.info.name} 不支持 ${source} 的 ${action}`);
}

function declaredSources(runtime) {
  return Object.keys(runtime.sources || {}).filter(
    (source) => runtime.sources[source] && runtime.sources[source].type !== "local",
  );
}

function availableSources(runtimes) {
  const map = {};
  for (const runtime of runtimes) {
    for (const source of declaredSources(runtime)) map[source] = true;
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

// ------------------------------------------------------------- catalog ----

// 目录只做索引：公开的榜单、歌单、每日曲目，以及登录后本人自己的列表。
// 这里产出的歌曲 ID 和搜索结果完全一致，拿到就能直接交给 stream() 换地址。
const CATALOG_SITES = {
  wy: { referer: "https://music.163.com/", signIn: "https://music.163.com/", until: ["MUSIC_U"] },
  tx: { referer: "https://y.qq.com/", signIn: "https://y.qq.com/", until: ["uin", "qm_keyst"] },
};
const PLAYLIST_QUERIES = ["华语", "流行", "轻音乐", "欧美"];

let catalogCache = new Map();
const knownPlaylists = new Map();

function catalogOn() {
  return String(host.setting("catalog") || "on").trim().toLowerCase() !== "off";
}

function catalogProviders() {
  const chosen = String(host.setting("platform") || "").trim();
  return chosen === "wy" || chosen === "tx" ? [chosen] : ["wy", "tx"];
}

function catalogLabel(source) {
  return CATALOG_LABEL[source] ? t(CATALOG_LABEL[source]) : source;
}

function catalogShort(source) {
  return CATALOG_SHORT[source] || source;
}

function credential(source) {
  return String(host.storage.get(`credential:${source}`) || "").trim();
}

function signedSources() {
  return Object.keys(CATALOG_SITES).filter((source) => credential(source));
}

function cookieValue(cookie, name) {
  const match = String(cookie).match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

// 网页端把登录态折算成请求参数的公开算法，只用于读取本人主页。
function hash33(text) {
  let value = 5381;
  for (let i = 0; i < text.length; i++) value += (value << 5) + text.charCodeAt(i);
  return value & 0x7fffffff;
}

function catalogHeaders(source, withCredential) {
  const site = CATALOG_SITES[source] || {};
  const headers = { "User-Agent": UA, Referer: site.referer || "" };
  if (withCredential) {
    const cookie = credential(source);
    if (cookie) headers.Cookie = cookie;
  }
  return headers;
}

async function apiJson(url, options) {
  const { source, withCredential, init } = options || {};
  const controller = newController();
  const requestInit = {
    ...(init || {}),
    headers: { ...catalogHeaders(source, withCredential), ...((init && init.headers) || {}) },
  };
  if (controller) requestInit.signal = controller.signal;
  const timer = controller ? setTimeout(() => controller.abort(), CATALOG_TIMEOUT) : null;
  try {
    const response = await fetch(url, requestInit);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return JSON.parse(text.replace(/^\s*\w+\(/, "").replace(/\)\s*;?\s*$/, ""));
  } catch (error) {
    if (controller && controller.signal.aborted) throw new Error(t("Catalog request timed out"));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cached(key, make) {
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.promise;
  const promise = Promise.resolve()
    .then(make)
    .catch((error) => {
      const current = catalogCache.get(key);
      if (current && current.promise === promise) catalogCache.delete(key);
      throw error;
    });
  catalogCache.set(key, { at: Date.now(), promise });
  return promise;
}

function musicu(data, source, withCredential) {
  const key = withCredential ? cookieValue(credential(source), "qm_keyst") : "";
  const url =
    `https://u.y.qq.com/cgi-bin/musicu.fcg?g_tk=${hash33(key)}&format=json` +
    `&data=${encodeURIComponent(JSON.stringify(data))}`;
  return apiJson(url, { source, withCredential });
}

function wyTrack(song) {
  if (!song || !song.id) return null;
  const cover = secure(song.al && song.al.picUrl);
  return {
    id: `wy:${song.id}`,
    name: song.name || "",
    artists: (song.ar || song.artists || []).map((artist) => ({ id: String(artist.id), name: artist.name })),
    album: {
      id: String((song.al && song.al.id) || ""),
      name: (song.al && song.al.name) || "",
      imageUrl: cover ? `${cover}?param={size}y{size}` : "",
    },
    duration: song.dt || song.duration || 0,
    url: `https://music.163.com/song?id=${song.id}`,
  };
}

function txTrack(song) {
  if (!song || !song.mid) return null;
  const albumMid = (song.album && song.album.mid) || "";
  const mediaMid = (song.file && song.file.media_mid) || song.media_mid || song.mid;
  return {
    id: `tx:${song.mid}:${mediaMid}`,
    name: song.title || song.name || "",
    artists: (song.singer || []).map((artist) => ({ id: String(artist.mid || artist.id), name: artist.name })),
    album: {
      id: albumMid || String((song.album && song.album.id) || ""),
      name: (song.album && song.album.name) || "",
      imageUrl: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : "",
    },
    duration: (song.interval || 0) * 1000,
    url: `https://y.qq.com/n/ryqq/songDetail/${song.mid}`,
  };
}

function prioritize(tracks) {
  const playable = new Set(availableSources(compiled.runtimes));
  const rank = (track) => (playable.has(parseId(track.id).source) ? 0 : 1);
  return tracks.slice().sort((a, b) => rank(a) - rank(b));
}

function catalogTracks(source, songs) {
  const tracks = prioritize(songs.map(source === "wy" ? wyTrack : txTrack).filter(Boolean));
  remember(tracks);
  return tracks;
}

function notePlaylist(playlist) {
  if (knownPlaylists.size > 400) knownPlaylists.clear();
  knownPlaylists.set(playlist.id, playlist);
  return playlist;
}

function wyPlaylist(item) {
  if (!item || !item.id) return null;
  return notePlaylist({
    id: `wy:${item.id}`,
    name: item.name || "",
    imageUrl: secure(item.coverImgUrl || item.picUrl || ""),
    description: item.description || "",
    owner: (item.creator && item.creator.nickname) || "",
    trackCount: item.trackCount || 0,
  });
}

function txPlaylist(item) {
  const id = item && (item.dissid || item.diss_tid);
  if (!id) return null;
  return notePlaylist({
    id: `tx:${id}`,
    name: item.dissname || "",
    imageUrl: secure(item.imgurl || ""),
    trackCount: item.song_count || item.songnum || 0,
    owner: item.nickname || (item.creator && item.creator.nick) || "",
  });
}

async function chartsOf(source) {
  return cached(`charts:${source}`, async () => {
    if (source === "wy") {
      const data = await apiJson("https://music.163.com/api/toplist/detail", { source });
      return (data.list || [])
        .filter((item) => item && item.id && item.name)
        .slice(0, CHART_LINK_MAX)
        .map((item) => ({
          id: String(item.id),
          name: item.name,
          imageUrl: secure(item.coverImgUrl || ""),
          subtitle: item.updateFrequency || "",
        }));
    }
    const data = await musicu(
      { comm: { ct: 23, cv: 0 }, topList: { module: "musicToplist.ToplistInfoServer", method: "GetAll", param: {} } },
      source,
    );
    const groups = (data.topList && data.topList.data && data.topList.data.group) || [];
    const out = [];
    for (const group of groups) {
      for (const item of group.toplist || []) {
        if (item && item.topId && item.title) {
          out.push({
            id: String(item.topId),
            name: item.title,
            imageUrl: secure(item.headPicUrl || item.frontPicUrl || ""),
            subtitle: "",
          });
        }
      }
    }
    return out.slice(0, CHART_LINK_MAX);
  });
}

async function chartTracks(source, id, offset) {
  return cached(`chart:${source}:${id}:${offset}`, async () => {
    if (source === "wy") {
      const data = await apiJson(
        `https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=${PLAYLIST_TRACK_MAX}`,
        { source },
      );
      return catalogTracks("wy", (data.playlist && data.playlist.tracks) || []);
    }
    const data = await musicu(
      {
        comm: { ct: 24, cv: 0 },
        detail: {
          module: "musicToplist.ToplistInfoServer",
          method: "GetDetail",
          param: { topId: Number(id), offset: offset || 0, num: CATALOG_PAGE },
        },
      },
      source,
    );
    const detail = data.detail && data.detail.data;
    return catalogTracks("tx", (detail && detail.songInfoList) || []);
  });
}

async function featuredPlaylists(source) {
  return cached(`featured:${source}`, async () => {
    if (source === "wy") {
      const data = await apiJson(`https://music.163.com/api/personalized/playlist?limit=${PLAYLIST_LINK_MAX}`, { source });
      return (data.result || []).map(wyPlaylist).filter(Boolean);
    }
    const answers = await Promise.allSettled(
      PLAYLIST_QUERIES.map((query) =>
        apiJson(
          `https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?remoteplace=txt.yqq.playlist` +
            `&page_no=0&num_per_page=8&query=${encodeURIComponent(query)}&format=json`,
          { source },
        ),
      ),
    );
    const out = [];
    for (const answer of answers) {
      if (answer.status !== "fulfilled") continue;
      const list = (answer.value.data && answer.value.data.list) || [];
      for (const item of list) {
        const playlist = txPlaylist(item);
        if (playlist) out.push(playlist);
      }
    }
    return out.slice(0, PLAYLIST_LINK_MAX * 2);
  });
}

async function playlistTracks(source, id, offset) {
  return cached(`playlist:${source}:${id}:${offset}`, async () => {
    if (source === "wy") {
      const data = await apiJson(
        `https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=${PLAYLIST_TRACK_MAX}`,
        { source },
      );
      return catalogTracks("wy", (data.playlist && data.playlist.tracks) || []);
    }
    const data = await musicu(
      {
        comm: { ct: 24, cv: 1859 },
        pl: {
          module: "music.srfDissInfo.aiDissInfo",
          method: "uniform_get_Dissinfo",
          param: { song_begin: offset || 0, song_num: CATALOG_PAGE, disstid: Number(id), ctx: 1 },
        },
      },
      source,
      true,
    );
    const detail = data.pl && data.pl.data;
    const songs = ((detail && detail.songlist) || []).map((item) => item.songinfo || item);
    return catalogTracks("tx", songs);
  });
}

async function dailyTracks(source) {
  return cached(`daily:${source}`, async () => {
    if (source === "wy") {
      const data = await apiJson("https://music.163.com/api/v3/discovery/recommend/songs", {
        source,
        withCredential: true,
      });
      return catalogTracks("wy", (data.data && data.data.dailySongs) || []);
    }
    return chartTracks("tx", HOT_CHART_ID, 0);
  });
}

async function searchPlaylists(query, offset) {
  if (!catalogOn()) return { playlists: [], more: false };
  const answers = await Promise.allSettled(
    catalogProviders().map(async (source) => {
      if (source === "wy") {
        const data = await apiJson("https://music.163.com/api/cloudsearch/pc", {
          source,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody({ s: query, type: 1000, limit: CATALOG_PAGE, offset: offset || 0 }),
          },
        });
        return ((data.result && data.result.playlists) || []).map(wyPlaylist).filter(Boolean);
      }
      const page = Math.floor((offset || 0) / CATALOG_PAGE) + 1;
      const data = await apiJson(
        `https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?remoteplace=txt.yqq.playlist` +
          `&page_no=${page}&num_per_page=${CATALOG_PAGE}&query=${encodeURIComponent(query)}&format=json`,
        { source },
      );
      return ((data.data && data.data.list) || []).map(txPlaylist).filter(Boolean);
    }),
  );
  const playlists = [];
  for (const answer of answers) {
    if (answer.status === "fulfilled") playlists.push(...answer.value);
  }
  return { playlists, more: false };
}

async function txProfile(source) {
  const cookie = credential(source);
  const uin = cookieValue(cookie, "uin").replace(/^o/, "").replace(/^0+/, "") || "0";
  const gtk = hash33(cookieValue(cookie, "qm_keyst"));
  const url =
    `https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?cv=4747474&ct=24&format=json` +
    `&inCharset=utf-8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&uin=${uin}` +
    `&g_tk_new_20200303=${gtk}&g_tk=${gtk}&cid=205360838&userid=${uin}&reqfrom=1&reqtype=0` +
    `&hostUin=0&loginUin=${uin}`;
  return apiJson(url, { source, withCredential: true });
}

async function profileOf(source) {
  if (source === "wy") {
    const data = await apiJson("https://music.163.com/api/nuser/account/get", { source, withCredential: true });
    const profile = data.profile;
    if (!profile) throw fail("signIn", t("This credential has expired; sign in again."));
    return {
      id: String(profile.userId),
      name: profile.nickname || t("Listener"),
      imageUrl: secure(profile.avatarUrl || ""),
      source,
    };
  }
  const data = await txProfile(source);
  const creator = (data.data && data.data.creator) || {};
  const uin = cookieValue(credential(source), "uin") || "0";
  if (!creator.nick && !creator.headpic) throw fail("signIn", t("This credential has expired; sign in again."));
  return { id: uin, name: creator.nick || t("Listener"), imageUrl: secure(creator.headpic || ""), source };
}

async function myPlaylists() {
  const answers = await Promise.allSettled(
    signedSources().map(async (source) => {
      if (source === "wy") {
        const saved = host.storage.get("account") || {};
        if (saved.source !== "wy" || !saved.id) return [];
        const data = await apiJson(
          `https://music.163.com/api/user/playlist?uid=${encodeURIComponent(saved.id)}&limit=100&offset=0`,
          { source, withCredential: true },
        );
        return (data.playlist || []).map((item) => {
          const playlist = wyPlaylist(item);
          if (!playlist) return null;
          const own = { ...playlist, mine: true };
          return notePlaylist(own);
        }).filter(Boolean);
      }
      const data = await txProfile(source);
      const items = (data.data && data.data.mymusic) || [];
      const out = [];
      for (const item of items) {
        const match = /[?&]id=(\d+)/.exec(String(item.jumpurl || ""));
        if (!match) continue;
        out.push(notePlaylist({
          id: `tx:${match[1]}`,
          name: item.title || "",
          imageUrl: secure(item.picurl || item.picUrl || ""),
          trackCount: item.songnum || item.song_count || 0,
          mine: true,
        }));
      }
      return out;
    }),
  );
  const out = [];
  for (const answer of answers) {
    if (answer.status === "fulfilled") out.push(...answer.value);
  }
  return out;
}

function splitCatalogId(id) {
  const cut = String(id).indexOf(":");
  if (cut < 0) return null;
  const source = String(id).slice(0, cut);
  return CATALOG_SITES[source] ? { source, raw: String(id).slice(cut + 1) } : null;
}

function pageParts(page, kind) {
  const text = String(page);
  return text.startsWith(`${kind}|`) ? text.slice(kind.length + 1).split("|") : null;
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
  if (!response.ok) throw new Error(`${catalogLabel("wy")} 搜索失败 (${response.status})`);
  const data = await response.json();
  const songs = (data && data.result && data.result.songs) || [];
  return songs.map(wyTrack).filter(Boolean);
}

async function searchTX(query, offset) {
  const page = Math.floor(offset / SEARCH_LIMIT) + 1;
  const url =
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}` +
    `&format=json&n=${SEARCH_LIMIT}&p=${page}&new_json=1&cr=1&t=0`;
  const response = await fetch(url, {
    headers: { Referer: "https://y.qq.com/", "User-Agent": UA },
  });
  if (!response.ok) throw new Error(`${catalogLabel("tx")} 搜索失败 (${response.status})`);
  const data = await response.json();
  const songs = (data && data.data && data.data.song && data.data.song.list) || [];
  return songs.map(txTrack).filter(Boolean);
}

const SEARCHERS = { wy: searchWY, tx: searchTX };

// ------------------------------------------------------------- exported ----

export async function setSetting({ key }) {
  if (key === "platform" || key === "catalog" || key === "credential") {
    catalogCache.clear();
    knownPlaylists.clear();
    return;
  }
  if (key === "scriptUrls" || key === "scriptUrl" || key === "script") {
    loading = null;
    compiled = { key: "", at: 0, runtimes: [], errors: [] };
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
  if (kind === "playlists") return searchPlaylists(String(query || "").trim(), offset || 0);
  if (kind !== "tracks") return { [kind]: [], more: false };
  const text = String(query || "").trim();
  if (!text) return { tracks: [], more: false };

  const platforms = catalogProviders();
  const settled = await Promise.allSettled(platforms.map((platform) => SEARCHERS[platform](text, offset || 0)));
  const tracks = [];
  const errors = [];
  let more = false;

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      tracks.push(...result.value);
      if (result.value.length >= SEARCH_LIMIT) more = true;
    } else {
      errors.push(`${catalogLabel(platforms[index])}: ${result.reason && result.reason.message}`);
    }
  });

  if (errors.length) host.storage.set("lastSearchError", errors.join("；"));
  else host.storage.remove("lastSearchError");

  if (!tracks.length && errors.length) throw new Error(errors.join("；"));
  if (!tracks.length) return { tracks: [], more: false };

  // 排序只看已经编译好的音源，不在这里下载脚本：脚本地址卡住不该拖慢搜索。
  const playable = new Set(availableSources(compiled.runtimes));
  const rank = (track) => (playable.has(parseId(track.id).source) ? 0 : 1);
  tracks.sort((a, b) => rank(a) - rank(b));

  remember(tracks);
  return { tracks, more };
}

export async function stream({ id, quality }) {
  const { source, musicInfo } = decodeId(id);
  const { runtimes } = await loadedScripts();
  const usable = runtimes.filter((runtime) => {
    const entry = runtime.sources && runtime.sources[source];
    return entry && entry.type !== "local";
  });
  if (!usable.length) {
    throw fail("setup", `还没有能播 ${catalogLabel(source)} 的音源，请在插件设置里填入 LX 音源脚本地址`);
  }

  // 每个音源同时要一次地址，谁先给出能用的就用谁，其余立刻收手。
  const verify = usable.length > 1;
  const attempts = usable.map((runtime) => {
    const declared = (runtime.sources[source].qualitys || []).filter(Boolean);
    const chain = QUALITY_CHAIN[quality] || QUALITY_CHAIN.high;
    const picked = chain.find((item) => declared.includes(item)) || declared[0] || "128k";
    const controller = newController();

    const promise = withTimeout(
      callSource(runtime, source, "musicUrl", { type: picked, musicInfo }),
      STREAM_TIMEOUT,
    ).then(async (answer) => {
      const raw = typeof answer === "string" ? answer : answer && (answer.url || answer.data);
      if (!raw || typeof raw !== "string") throw new Error("没有给出地址");
      const url = secure(raw);
      if (verify) await verifyUrl(url, controller);
      return { runtime, picked, url };
    });

    return {
      runtime,
      promise,
      cancel() {
        runtime.cancelPending();
        if (controller) {
          try {
            controller.abort();
          } catch {}
        }
      },
    };
  });

  let winner;
  try {
    winner = await raceSources(attempts);
  } catch (error) {
    throw fail("unavailable", `音源都没给出地址：${error.message}`);
  }

  host.storage.set("lastSource", `${winner.runtime.info.name} · ${qualityOf(winner.picked)}`);
  return { url: winner.url, type: typeOf(winner.url, winner.picked), quality: qualityOf(winner.picked) };
}

// 多个音源时才探测：单源多打一次请求既没意义，又可能因为鉴权误杀好链。
// 只有明确的 404/410、网络不通或超时算失败，403/405 之类一律放行。
async function verifyUrl(url, controller) {
  if (!/^https?:\/\//i.test(url)) throw new Error("给出的不是 http(s) 地址");
  const init = { method: "GET", headers: { Range: "bytes=0-0", "User-Agent": UA } };
  if (controller) init.signal = controller.signal;
  let timer = null;
  try {
    await Promise.race([
      (async () => {
        const response = await fetch(url, init);
        if (response.status === 404 || response.status === 410) {
          throw new Error(`地址返回 ${response.status}`);
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("地址探测超时")), URL_CHECK_TIMEOUT);
      }),
    ]);
  } catch (error) {
    if (controller) {
      try {
        controller.abort();
      } catch {}
    }
    throw new Error(`地址不可用：${error.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 谁先给出能用的地址就用谁，同时把其余的请求收掉；全失败了才报错。
function raceSources(attempts) {
  return new Promise((resolve, reject) => {
    let left = attempts.length;
    let settled = false;
    const errors = [];
    for (const attempt of attempts) {
      attempt.promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          for (const other of attempts) {
            if (other !== attempt) other.cancel();
          }
          resolve(value);
        },
        (error) => {
          errors.push(`${attempt.runtime.info.name}：${(error && error.message) || error}`);
          if (--left === 0 && !settled) reject(new Error(errors.join("；")));
        },
      );
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
  const cache = host.storage.get("lyrics") || {};
  if (cache[id]) return cache[id];

  const { source, musicInfo } = decodeId(id);
  let result = null;

  // 音源脚本自己能给歌词就先问它（local 源才有 lyric 动作）。
  for (const runtime of compiled.runtimes) {
    const entry = runtime.sources && runtime.sources[source];
    if (entry && Array.isArray(entry.actions) && entry.actions.includes("lyric")) {
      try {
        const answer = await callSource(runtime, source, "lyric", { musicInfo });
        if (answer && answer.lyric) result = { lrc: answer.lyric, translation: answer.tlyric || "" };
      } catch {}
    }
    if (result) break;
  }

  if (!result) {
    try {
      if (source === "wy") {
        const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(musicInfo.songmid)}&lv=1&tv=1`;
        const response = await fetch(url, { headers: { Referer: "https://music.163.com/", "User-Agent": UA } });
        const data = await response.json();
        const lrc = data && data.lrc && data.lrc.lyric;
        if (lrc) result = { lrc, translation: (data.tlyric && data.tlyric.lyric) || "" };
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
        if (lrc) result = { lrc };
      }
    } catch {}
  }

  if (!result) throw fail("unsupported", "这首歌没有歌词");

  cache[id] = result;
  const keys = Object.keys(cache);
  if (keys.length > LYRIC_CACHE_MAX) {
    for (const key of keys.slice(0, keys.length - LYRIC_CACHE_MAX)) delete cache[key];
  }
  host.storage.set("lyrics", cache);
  return result;
}

export async function home() {
  const { runtimes, errors } = await loadedScripts();
  const sections = [];

  if (runtimes.length) {
    const sources = availableSources(runtimes);
    sections.push({
      title: t("Loaded sources"),
      subtitle: `${runtimes.length} · ${sources.map(catalogShort).join(" · ")}`,
      links: runtimes.map((runtime) => ({
        title: runtime.info.name,
        subtitle:
          declaredSources(runtime).map(catalogShort).join(" · ") || t("No sources declared"),
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

  const lastSearchError = host.storage.get("lastSearchError");
  if (lastSearchError) sections.push({ title: t("Last search problem"), empty: lastSearchError });

  // 发现能力只放几个普通链接，不占侧边栏，也不在首页拉数据。
  if (catalogOn()) {
    sections.push({
      title: t("Browse"),
      links: [
        { title: t("Charts"), subtitle: t("What listeners are playing"), page: "charts" },
        { title: t("Playlists"), subtitle: t("Collections to open"), page: "playlists" },
        { title: t("Daily picks"), subtitle: t("A fresh set of songs"), page: "daily" },
        { title: t("My lists"), subtitle: t("Your own collections"), page: "mine" },
      ],
    });
  }

  return { title: t("LX Source"), sections };
}

async function sourcesPage() {
  const { runtimes, errors } = await loadedScripts();
  const sections = [];

  if (runtimes.length) {
    for (const runtime of runtimes) {
      const sources = declaredSources(runtime);
      sections.push({
        title: runtime.info.name,
        subtitle: [runtime.info.author, runtime.info.version].filter(Boolean).join(" · "),
        empty: t("This script declares no sources"),
        links: sources.map((source) => ({
          title: catalogLabel(source),
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

  const lastSource = host.storage.get("lastSource");
  if (lastSource) sections.push({ title: t("Last playback"), empty: lastSource });

  sections.push({
    title: t("Note"),
    empty: t(
      "Source scripts come from third parties: this plugin only hands their play URLs to the player. A script may reach any host, so import only ones you trust.",
    ),
  });

  return { title: t("Sources"), sections };
}

// 目录页只在被点开时才取数据；单个曲库挂掉不影响另一个。
export async function browse({ page }) {
  if (page === "sources") return sourcesPage();
  if (!catalogOn()) throw fail("unsupported", t("Catalog is turned off in the plugin settings."));

  const providers = catalogProviders();

  if (page === "discover") {
    return {
      title: t("Browse"),
      sections: [
        {
          title: t("Explore"),
          links: [
            { title: t("Charts"), page: "charts" },
            { title: t("Playlists"), page: "playlists" },
            { title: t("Daily picks"), page: "daily" },
            { title: t("My lists"), page: "mine" },
          ],
        },
      ],
    };
  }

  if (page === "charts") {
    const answers = await Promise.allSettled(providers.map((source) => chartsOf(source)));
    const sections = answers.map((answer, index) => {
      const source = providers[index];
      const charts = answer.status === "fulfilled" ? answer.value : [];
      return {
        title: catalogLabel(source),
        empty: t("Charts are unavailable right now"),
        links: charts.map((chart) => ({
          title: chart.name,
          subtitle: chart.subtitle,
          imageUrl: chart.imageUrl,
          page: `chart|${source}|${chart.id}|0`,
        })),
      };
    });
    return { title: t("Charts"), sections };
  }

  const chartPage = pageParts(page, "chart");
  if (chartPage) {
    const [source, id, at] = chartPage;
    if (!CATALOG_SITES[source]) throw fail("unavailable", t("There is no such page"));
    const offset = Number(at) || 0;
    const tracks = await chartTracks(source, id, offset).catch(() => []);
    const section = { title: t("Charts"), tracks, empty: t("Charts are unavailable right now") };
    if (tracks.length >= CATALOG_PAGE) section.morePage = `chart|${source}|${id}|${offset + CATALOG_PAGE}`;
    return { title: t("Charts"), sections: [section] };
  }

  if (page === "playlists") {
    const answers = await Promise.allSettled(providers.map((source) => featuredPlaylists(source)));
    const sections = answers.map((answer, index) => ({
      title: catalogLabel(providers[index]),
      playlists: answer.status === "fulfilled" ? answer.value : [],
      empty: t("Playlists are unavailable right now"),
    }));
    return { title: t("Playlists"), sections };
  }

  const playlistPage = pageParts(page, "playlist");
  if (playlistPage) {
    const [source, id, at] = playlistPage;
    if (!CATALOG_SITES[source]) throw fail("unavailable", t("There is no such page"));
    return playlistTracksPage(source, id, Number(at) || 0);
  }

  if (page === "daily") {
    const answers = await Promise.allSettled(providers.map((source) => dailyTracks(source)));
    const sections = answers.map((answer, index) => ({
      title: catalogLabel(providers[index]),
      tracks: answer.status === "fulfilled" ? answer.value : [],
      empty: t("Picks are unavailable right now"),
    }));
    return { title: t("Daily picks"), sections };
  }

  if (page === "mine" || page === "account") return myPage(page);

  throw fail("unavailable", t("There is no such page"));
}

async function playlistTracksPage(source, id, offset) {
  const meta = knownPlaylists.get(`${source}:${id}`) || {};
  const tracks = await playlistTracks(source, id, offset).catch(() => []);
  const section = {
    title: meta.name || t("Playlist"),
    tracks,
    empty: t("This playlist has no tracks available"),
  };
  if (tracks.length >= CATALOG_PAGE) section.morePage = `playlist|${source}|${id}|${offset + CATALOG_PAGE}`;
  return { title: meta.name || t("Playlist"), sections: [section] };
}

async function myPage(page) {
  const saved = host.storage.get("account");
  if (!saved) {
    if (page === "mine") throw fail("signIn", t("Sign in to sync your own collections."));
    return { title: t("My lists"), sections: [{ empty: t("Sign in to sync your own collections.") }] };
  }
  const lists = await myPlaylists().catch(() => []);
  return {
    title: t("My lists"),
    subtitle: catalogLabel(saved.source),
    imageUrl: saved.imageUrl || "",
    sections: [
      {
        title: t("Your collections"),
        playlists: lists,
        empty: t("No collections came back; sign in again if this persists."),
      },
      {
        title: t("Note"),
        empty: t("Switch the catalog in the plugin settings, then sign in again to sync another one."),
      },
    ],
  };
}

// 登录由宿主打开网页让用户自己完成，凭证只留在本机，只用来读本人的列表。
export async function signIn() {
  if (!catalogOn()) throw fail("unsupported", t("Catalog is turned off in the plugin settings."));
  const source = catalogProviders()[0];
  const site = CATALOG_SITES[source];
  let cookie = "";
  if (typeof host.webSignIn === "function") {
    const answer = await host.webSignIn({
      url: site.signIn,
      cookiesOf: site.signIn,
      until: site.until,
      userAgent: UA,
    });
    cookie = answer && answer.cookie ? String(answer.cookie) : "";
  }
  if (!cookie) cookie = String(host.setting("credential") || "").trim();
  if (!cookie) {
    throw fail("setup", t("Sign in isn't available here; put your sync credential in the plugin settings."));
  }
  host.storage.set(`credential:${source}`, cookie);
  catalogCache.clear();
  const profile = await profileOf(source);
  host.storage.set("account", profile);
  return account();
}

export function signOut() {
  for (const source of Object.keys(CATALOG_SITES)) host.storage.remove(`credential:${source}`);
  host.storage.remove("account");
  catalogCache.clear();
  knownPlaylists.clear();
}

export function account() {
  if (!catalogOn()) return null;
  const saved = host.storage.get("account");
  if (!saved) return null;
  return { id: saved.id, name: saved.name, imageUrl: saved.imageUrl || "", page: "account" };
}

export async function playlists() {
  if (!catalogOn() || !signedSources().length) return [];
  return myPlaylists().catch(() => []);
}

export async function playlist({ id }) {
  if (!catalogOn()) throw fail("unsupported", t("Catalog is turned off in the plugin settings."));
  const parts = splitCatalogId(id);
  if (!parts) throw fail("unavailable", t("There is no such playlist"));
  const tracks = await playlistTracks(parts.source, parts.raw, 0);
  const meta = knownPlaylists.get(String(id)) || {};
  return { id: String(id), name: meta.name || t("Playlist"), tracks, mine: !!meta.mine, trackCount: tracks.length };
}
