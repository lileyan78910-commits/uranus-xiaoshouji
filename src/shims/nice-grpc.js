/**
 * 冒充 `nice-grpc` + `nice-grpc-common`，底下走 fetch 发 grpc-web。
 *
 * 为什么：Photon 官方 SDK（@photon-ai/advanced-imessage → @spectrum-ts/imessage
 * → spectrum-ts）只有传输层是 Node 专属的 —— nice-grpc 要 HTTP/2 长连接，
 * Worker 里没有。编解码（ts-proto 生成的 encode/decode）、消息模型、发气泡、
 * 打字、贴纸、表情回应……全是纯 JS。把这一层换掉，整套 SDK 就能在 Worker
 * 里原样跑，桌面版 imessage.js 也就跟着能跑。
 *
 * 网关实测（见探针）：
 *   - 请求 `content-type: application/grpc-web+proto`、`x-grpc-web: 1`，
 *     体是 `[0x00][u32 BE 长度][protobuf]`
 *   - 回的是原生 `application/grpc+proto`：成功时状态在 HTTP/2 trailer 里，
 *     fetch 读不到 —— 所以「没有 grpc-status 头 + 有消息帧」就算成功
 *   - 失败是 trailers-only，grpc-status / grpc-message 直接在响应头里
 *
 * 只实现 advanced-imessage 真用到的那部分：createChannel / ChannelCredentials /
 * createClientFactory().use().create()、Metadata、Status、ClientError。
 * 客户端流式调用 SDK 里一个都没有，这里也不支持。
 */

export const Status = {
  OK: 0, CANCELLED: 1, UNKNOWN: 2, INVALID_ARGUMENT: 3, DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5, ALREADY_EXISTS: 6, PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9, ABORTED: 10, OUT_OF_RANGE: 11, UNIMPLEMENTED: 12,
  INTERNAL: 13, UNAVAILABLE: 14, DATA_LOSS: 15, UNAUTHENTICATED: 16,
};
const STATUS_NAME = Object.fromEntries(Object.entries(Status).map(([k, v]) => [v, k]));

export class ClientError extends Error {
  constructor(path, code, details) {
    super(`${path} ${STATUS_NAME[code] ?? code}: ${details}`);
    this.name = "ClientError";
    this.path = path;
    this.code = code;
    this.details = details;
  }
}

/** nice-grpc 的 Metadata：键不分大小写、一个键可以有多个值、可迭代。 */
export function Metadata(init) {
  const map = new Map();
  const md = {
    set(k, v) { map.set(k.toLowerCase(), Array.isArray(v) ? [...v] : [v]); return md; },
    append(k, v) { const key = k.toLowerCase(); map.set(key, [...(map.get(key) ?? []), v]); return md; },
    get(k) { return map.get(k.toLowerCase())?.[0]; },
    getAll(k) { return map.get(k.toLowerCase()) ?? []; },
    has(k) { return map.has(k.toLowerCase()); },
    delete(k) { map.delete(k.toLowerCase()); },
    [Symbol.iterator]() { return map.entries(); },
    toJSON() { return Object.fromEntries(map); },
  };
  if (init) for (const [k, vs] of init) for (const v of vs) md.append(k, v);
  return md;
}

export const ChannelCredentials = {
  createSsl: () => ({ tls: true }),
  createInsecure: () => ({ tls: false }),
};

export function createChannel(address, credentials) {
  let base = String(address);
  if (!/^https?:\/\//.test(base)) base = (credentials?.tls === false ? "http://" : "https://") + base;
  base = base.replace(/:443$/, "").replace(/\/+$/, "");
  return { base, close() {} };
}

function frame(bytes) {
  const out = new Uint8Array(5 + bytes.length);
  new DataView(out.buffer).setUint32(1, bytes.length);
  out.set(bytes, 5);
  return out;
}

/** 把 grpc-web 的 trailer 帧（flag 0x80）解析成 {key: value} */
function parseTrailerFrame(bytes) {
  const out = {};
  for (const line of new TextDecoder().decode(bytes).split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function headersMetadata(headers, extra = {}) {
  const md = Metadata();
  headers.forEach((v, k) => md.set(k, v));
  for (const [k, v] of Object.entries(extra)) md.set(k, v);
  return md;
}

function fail(path, code, message, md, options) {
  options.onTrailer?.(md);
  const err = new ClientError(path, code, message);
  Object.defineProperty(err, "metadata", { value: md, writable: true, configurable: true });
  return err;
}

/**
 * 发一次调用，把响应体按帧吐出来（消息帧 decode 之后 yield）。
 * 一元调用和服务端流式共用：一元的取第一个就行。
 */
async function* invoke(channel, method, request, options) {
  const path = method.path;
  const headers = {
    "content-type": "application/grpc-web+proto",
    "x-grpc-web": "1",
    accept: "application/grpc-web+proto, application/grpc+proto",
  };
  for (const [k, vs] of options.metadata ?? []) {
    if (vs.length) headers[k] = vs.join(", ");
  }
  const body = frame(method.requestSerialize(request));

  let res;
  try {
    res = await fetch(channel.base + path, { method: "POST", headers, body, signal: options.signal });
  } catch (e) {
    if (options.signal?.aborted) throw fail(path, Status.CANCELLED, "调用被取消", Metadata(), options);
    throw fail(path, Status.UNAVAILABLE, `连不上网关：${e?.message ?? e}`, Metadata(), options);
  }

  const headStatus = res.headers.get("grpc-status");
  if (headStatus !== null && headStatus !== "0") {
    const msg = decodeURIComponent(res.headers.get("grpc-message") ?? "");
    res.body?.cancel().catch(() => {});
    throw fail(path, Number(headStatus), msg, headersMetadata(res.headers), options);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const code = res.status === 401 ? Status.UNAUTHENTICATED
      : res.status === 403 ? Status.PERMISSION_DENIED
      : res.status === 404 ? Status.UNIMPLEMENTED
      : res.status === 429 ? Status.RESOURCE_EXHAUSTED
      : Status.UNAVAILABLE;
    throw fail(path, code, `HTTP ${res.status} ${text.slice(0, 200)}`, headersMetadata(res.headers), options);
  }

  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  let trailers = null;
  try {
    for (;;) {
      // 先把缓冲里已经完整的帧吐干净
      while (buf.length >= 5) {
        const len = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0);
        if (buf.length < 5 + len) break;
        const flag = buf[0];
        const payload = buf.slice(5, 5 + len);
        buf = buf.slice(5 + len);
        if (flag & 0x80) trailers = parseTrailerFrame(payload);
        else yield method.responseDeserialize(payload);
      }
      const { done, value } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  } finally {
    reader.releaseLock?.();
  }

  const md = headersMetadata(res.headers, trailers ?? {});
  const status = trailers?.["grpc-status"];
  if (status !== undefined && status !== "0") {
    throw fail(path, Number(status), decodeURIComponent(trailers["grpc-message"] ?? ""), md, options);
  }
  options.onTrailer?.(md);
}

/** ts-proto 生成的 definition → 每个方法补上 path / 序列化函数 */
function normalize(definition) {
  const out = {};
  for (const [key, m] of Object.entries(definition.methods)) {
    out[key] = {
      path: `/${definition.fullName}/${m.name}`,
      requestStream: m.requestStream,
      responseStream: m.responseStream,
      options: m.options ?? {},
      requestSerialize: (req) => m.requestType.encode(m.requestType.fromPartial(req)).finish(),
      responseDeserialize: (bytes) => m.responseType.decode(bytes),
    };
  }
  return out;
}

/**
 * nice-grpc 的中间件是 async generator：`async function* (call, options)`，
 * 里面 `yield* call.next(request, options)` 往下传。一元调用的结果是
 * generator 的 return 值，流式调用是它 yield 出来的每一项。
 */
function compose(middlewares, method, channel) {
  const terminal = async function* (request, options) {
    if (method.responseStream) {
      yield* invoke(channel, method, request, options);
      return undefined;
    }
    for await (const msg of invoke(channel, method, request, options)) return msg;
    throw fail(method.path, Status.INTERNAL, "网关回了空响应", Metadata(), options);
  };
  return middlewares.reduceRight(
    (next, mw) => (request, options) => mw({ method, request, requestStream: false, responseStream: method.responseStream, next }, options),
    terminal
  );
}

export function createClientFactory() {
  const build = (middlewares) => ({
    use(mw) {
      return build([...middlewares, mw]);
    },
    create(definition, channel, defaultOptions = {}) {
      const client = {};
      for (const [key, method] of Object.entries(normalize(definition))) {
        const run = compose(middlewares, method, channel);
        const opts = (o) => ({ ...(defaultOptions["*"] ?? {}), ...(defaultOptions[key] ?? {}), ...(o ?? {}) });
        if (method.responseStream) {
          client[key] = (request, o) => run(request, opts(o));
        } else {
          client[key] = async (request, o) => {
            const it = run(request, opts(o));
            for (;;) {
              const { done, value } = await it.next();
              if (done) return value;
            }
          };
        }
      }
      return client;
    },
  });
  return build([]);
}

export const createClient = (definition, channel, defaultOptions) =>
  createClientFactory().create(definition, channel, defaultOptions);

export default {
  Status, ClientError, Metadata, ChannelCredentials, createChannel, createClientFactory, createClient,
};
