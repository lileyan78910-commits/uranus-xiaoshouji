/**
 * 冒充 `spectrum-ts`：整包照转 @spectrum-ts/core，只把 `Spectrum()` 换掉。
 *
 * 为什么：桌面版 imessage.js 收消息靠的是
 *
 *     for await (const [space, message] of instance.messages)
 *
 * 而 `instance.messages` 底下是一条永不结束的 gRPC 订阅流 —— Worker 里撑不住
 * （没有请求在身上时 DO 会被收走，流跟着断）。Worker 这边改成 Photon 往我们
 * 的 /hook 推 webhook，SDK 自己的 `app.webhook()` 验签、解出 `[space, message]`，
 * 我们把它塞进一个队列，再把这个队列冒充成 `instance.messages` 交给 imessage.js。
 * 于是桌面版那整个消息循环一行不改就能用。
 *
 * 顺手补一个坑：webhook 推过来的语音条不带字节，`content.read()` 直接抛
 * UnsupportedError。按消息 id 从 gRPC 把整条取回来（`space.getMessage`）再读
 * 就有了 —— 探针实测过，13KB 的语音条这样读得出来。
 */
import * as core from "@spectrum-ts/core";

export * from "@spectrum-ts/core";

/** projectId -> { real, queue } */
const live = new Map();

/**
 * webhook 的登记处：`ensure(projectId, projectSecret)` 负责把 Photon 那边的
 * webhook 指到本 Worker、返回签名密钥。由 Worker 入口在启动时注入。
 */
let registry = null;
export function setWebhookRegistry(r) {
  registry = r;
}

function createQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(v) {
      if (closed) return;
      const w = waiters.shift();
      if (w) w({ value: v, done: false });
      else items.push(v);
    },
    close() {
      closed = true;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (items.length) return Promise.resolve({ value: items.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((r) => waiters.push(r));
          },
          return() {
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}

/** 推送里读不出字节的附件：退回按 id 取整条消息再读 */
function patchContent(space, message) {
  const content = message?.content;
  if (!content || (content.type !== "attachment" && content.type !== "voice")) return;
  let full;
  const refetch = async () => {
    full ??= space.getMessage(message.id).then((m) => m?.content);
    const c = await full;
    if (!c) throw new Error("按消息 id 取回附件失败");
    return c;
  };
  const origRead = typeof content.read === "function" ? content.read.bind(content) : null;
  const origStream = typeof content.stream === "function" ? content.stream.bind(content) : null;
  try {
    content.read = async () => {
      try {
        if (origRead) return await origRead();
      } catch {
        /* 落到下面 */
      }
      return (await refetch()).read();
    };
    content.stream = async () => {
      try {
        if (origStream) return await origStream();
      } catch {
        /* 落到下面 */
      }
      const c = await refetch();
      if (typeof c.stream === "function") return c.stream();
      // 取回来的也没有流：包一个一次性吐完的
      const bytes = await c.read();
      return new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(bytes);
          ctrl.close();
        },
      });
    };
  } catch {
    /* content 冻住了就算了，imessage.js 那边读失败会照常记日志 */
  }
}

/**
 * 起线路的每一步都卡个时限。桌面版那边 `await Spectrum()` 没有超时 —— 这里
 * 哪一步挂住（Photon 接口不回、grpc-web 连不上），状态就永远停在「连接中」，
 * 退避重试也不会触发。超时抛出来，桌面版的重试照常接手，日志里也知道卡在哪。
 */
const STEP_TIMEOUT = 30_000;
function timed(promise, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what}超过 ${STEP_TIMEOUT / 1000} 秒没反应`)), STEP_TIMEOUT);
    }),
  ]).finally(() => clearTimeout(t));
}

export async function Spectrum(opts = {}) {
  let webhookSecret = opts.webhookSecret;
  if (!webhookSecret && opts.projectId && registry) {
    webhookSecret = await timed(registry.ensure(opts.projectId, opts.projectSecret), "登记 Photon webhook ");
  }
  const real = await timed(core.Spectrum({ telemetry: false, ...opts, webhookSecret }), "连 Photon ");
  const queue = createQueue();
  const entry = { real, queue };
  live.set(opts.projectId ?? "", entry);

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "messages") return queue.iterable;
      if (prop === "stop") {
        return async () => {
          queue.close();
          if (live.get(opts.projectId ?? "") === entry) live.delete(opts.projectId ?? "");
          await target.stop();
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** 等到至少有一条线路在线（最多 ms 毫秒）。刚醒的 DO 收到推送时线路可能还在连 */
export async function waitLive(ms) {
  const until = Date.now() + ms;
  while (!live.size && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  return live.size > 0;
}

/**
 * 把一次 webhook 交给在线的实例。每个项目的签名密钥不同，挨个试，
 * 验签过了的那个就是它的。
 *
 * @returns {Promise<{status:number, text:string}>}
 */
export async function deliverWebhook(body, headers) {
  if (!live.size) return { status: 503, text: "没有在线的线路" };
  let last = { status: 401, text: "signature" };
  for (const { real, queue } of live.values()) {
    const res = await real.webhook({ body, headers }, (space, message) => {
      patchContent(space, message);
      queue.push([space, message]);
    });
    const text = new TextDecoder().decode(res.body ?? new Uint8Array());
    if (res.status !== 401) return { status: res.status, text };
    last = { status: res.status, text };
  }
  return last;
}

export default { ...core, Spectrum, deliverWebhook, setWebhookRegistry };
