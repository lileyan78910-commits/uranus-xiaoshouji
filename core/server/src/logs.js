/**
 * 运行日志中枢。
 *
 * 后端各模块把「发生了什么」写到这里，前端控制台通过 SSE 实时拉走。
 * 同时照旧打到 stdout，这样 .bat 窗口和前端控制台看到的是同一份东西。
 *
 * 日志只在内存里留最近 RING_MAX 条——这是给人排查用的，不是审计日志。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// net.js 自己一个 import 都没有，所以这条不会成环（datadir.js 那种反向依赖
// 的坑见下面 ROOT_SLASH 那段注释）
import { netCodes, whyNetwork } from "./net.js";

/**
 * 内存里留多少条。
 *
 * 2000 而不是 800：级别切到 DEBUG 之后条数是原来的好几倍（每个 HTTP 请求
 * 两条），800 条撑不到几分钟，等用户发现出问题再去翻，出问题那一刻已经被
 * 挤出去了。每条都是短字符串（`detail` 本来就截在 4000 字符），2000 条的
 * 内存代价可以忽略。
 */
const RING_MAX = 2000;

/**
 * 允许的级别，按严重程度从低到高排列（前端过滤按这个顺序算「以上」）。
 *
 * `critical` 排在 `error` 后面而不是别的位置 —— 这个数组的**顺序就是语义**：
 * 前端的「xx 以上」是拿 indexOf 比大小算出来的，插错位置的话「只看问题」
 * 会把最严重的那一档漏掉。
 *
 * `error` 和 `critical` 的分界：error 是「这件事没做成」（一轮回复没生成、
 * 一张图没出来），服务本身还好好的；critical 是「服务本身出问题了」
 * （数据写不进去、进程要退了）。分不清就用 error —— 宁可少喊一声。
 */
export const LEVELS = ["debug", "info", "warn", "error", "critical"];

let seq = 0;
const ring = [];
const subscribers = new Set();

/* ================= 错误栈说人话 ================= */

/**
 * 项目根目录，用来把栈里的绝对路径压成相对路径。
 *
 * 自己算而**不是**从 datadir.js 拿它的 `ROOT` —— datadir.js 反过来 import
 * 了这个文件（它要 logWarn），那样是循环依赖。
 */
const ROOT_SLASH = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  .replace(/\\/g, "/");

/** 一条栈最多留几帧。再往下都是框架内部，看了也不知道该改哪儿。 */
const MAX_FRAMES = 6;

/**
 * 把栈里的一个 `file:///…` 地址压成人能读的相对路径。
 *
 * 这个项目的路径里有中文（「小手机」），Node 打出来的栈是**百分号编码**的：
 *
 *     at call (file:///F:/qq/%E5%B0%8F%E6%89%8B%E6%9C%BA/imessage/server/src/cloud/github.js:145:11)
 *
 * 那串 `%E5%B0%8F%E6%89%8B%E6%9C%BA` 就是「小手机」。不解码的话，报错里
 * 「是哪个文件」这个最要紧的信息压根看不出来。这跟哪个模块无关 —— 全项目
 * 每一条栈都长这样，所以修在这儿，一处管所有人。
 *
 * 上面那一帧最后会变成 `server/src/cloud/github.js:145`。
 */
function tidyFrame(url) {
  let text = url;
  try {
    text = decodeURIComponent(url);
  } catch {
    // 畸形的百分号序列（`%E0%A4%A` 这种）decodeURIComponent 会抛。
    // 原样留着也比让整条日志消失好
  }
  text = text.replace(/^file:\/{2,3}/, "");
  // 大小写不敏感地砍掉项目根：Windows 上盘符的大小写不固定（F: / f: 都有）
  const root = `${ROOT_SLASH.toLowerCase()}/`;
  if (text.toLowerCase().startsWith(root)) text = text.slice(root.length);
  // 只留行号 —— 列号对「该改哪儿」没有帮助，白占宽度
  return text.replace(/:(\d+):\d+$/, ":$1");
}

/**
 * 一整条栈：路径解码 + 扔掉没信息量的帧。
 *
 * 扔的是 `node:internal/*`（`processTicksAndRejections` 那种），它们在每条
 * async 栈里都有、每条都一样。**全是内部帧的时候留一条** —— 那说明是 Node
 * 自己抛的，一帧不留就只剩一句光秃秃的消息，连从哪儿来的都不知道。
 */
function tidyStack(text) {
  const cleaned = String(text).replace(/file:\/{2,3}[^\s)]+/g, tidyFrame);

  const isFrame = (l) => /^\s*at /.test(l);
  const isInternal = (l) => /node:internal\//.test(l);
  const lines = cleaned.split("\n");
  const frames = lines.filter(isFrame);
  if (!frames.length) return cleaned;

  const hasMine = frames.some((l) => !isInternal(l));
  const limit = hasMine ? MAX_FRAMES : 1;

  const out = [];
  let kept = 0;
  let internal = 0; // 扔掉的框架内部帧
  let overflow = 0; // 超出上限扔掉的
  for (const line of lines) {
    if (!isFrame(line)) {
      out.push(line);
      continue;
    }
    if (hasMine && isInternal(line)) {
      internal += 1;
      continue;
    }
    if (kept >= limit) {
      overflow += 1;
      continue;
    }
    kept += 1;
    out.push(line);
  }
  // 两种「扔掉」分别说 —— 「都是框架内部」套在超出上限的帧上是假话，
  // 那些是自己的代码，人可能正想看
  const why = [
    overflow ? `另有 ${overflow} 帧` : "",
    internal ? `${internal} 帧框架内部` : "",
  ].filter(Boolean);
  if (why.length) out.push(`    …（${why.join("，")}）`);
  return out.join("\n");
}

/**
 * detail 是个网络异常时，在栈前面补一句人话。
 *
 * 为什么必须在这儿补：全仓几十处 `logWarn(scope, "中文说明", e)` 把原始 Error
 * 直接丢进 detail，栈的第一行是 undici 那句光秃秃的 `TypeError: fetch failed`
 * —— 用户在控制台展开明细看到的就是它，而那句话**什么都没说**（云备份、IG、
 * 卡片抓取、更新检查全都是这一句）。挨个调用点去套 whyNetwork 要改几十处、
 * 还会漏；在这一个出口补，所有调用点一次都有了，小手机那版（同一份服务端
 * 源码打包）也跟着有。
 *
 * 只在真是网络错时补：挖到了网络码，或者消息就是 `fetch failed`。
 * 判「挖到了网络码」而不是「有 code」，是因为业务错误也常带 code
 * （比如 GitHub 的 `HTTP 404`），那种补一句「先看能不能出网」是误导。
 *
 * 栈照旧留在后面 —— 那句话是给人看的，栈是给「到底哪一行发的请求」看的，
 * 两个都要。
 */
const NET_CODE = /^(?:UND_ERR_|ECONN|ENOTFOUND$|EAI_AGAIN$|ENET|EHOSTUNREACH$|EPIPE$|ETIMEDOUT$|CERT_|ERR_TLS)/;

function netHint(e) {
  const msg = String(e?.message ?? "");
  const hit =
    netCodes(e).some((c) => NET_CODE.test(c)) || /^fetch failed$/i.test(msg.trim());
  return hit ? whyNetwork(e) : "";
}

/** detail 可能是 Error / 对象 / 长字符串，统一压成可读的短文本。 */
function stringifyDetail(detail) {
  if (detail == null) return undefined;
  let text;
  if (typeof detail === "string") {
    text = detail;
  } else if (detail instanceof Error) {
    const hint = netHint(detail);
    const stack = detail.stack ?? `${detail.name}: ${detail.message}`;
    text = hint ? `${hint}\n${stack}` : stack;
  } else {
    try {
      text = JSON.stringify(detail, null, 2);
    } catch {
      text = String(detail);
    }
  }
  // 字符串那一支也要过一遍：上游有时候是把 `e.stack` 当字符串传进来的
  text = tidyStack(text);
  // 上游偶尔会回几十 KB 的 HTML 错误页，截断避免把内存和前端都撑爆。
  // 排在整理**之后**：整理会缩短文本，先截的话有用的那几帧可能正好被切掉
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断）` : text;
}

const CONSOLE_FN = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
  critical: console.error,
};

/**
 * stdout 那一行开头的时间。
 *
 * 网页控制台每行左边本来就有时间（panels/console.jsx 的 fmtTime），但 .bat
 * 窗口这一份以前只有 `[来源] 内容` —— 于是从黑框里拷出来的日志是一段没有
 * 时间轴的文本，「这两行之间隔了多久」「这条是十分钟前的还是刚才的」全看不
 * 出来，排查时正是最要紧的那个信息。
 *
 * 只有本地时分秒，不带日期也不带毫秒：这是给人现场看的，日期在窗口里翻不了
 * 几屏就重复，毫秒只有对时序较真时才用得上，而那种场合该看网页控制台
 * （那边有毫秒）。格式和网页那份的前半段一致，两边对照时不用换算。
 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 记一条日志。
 * @param {"debug"|"info"|"warn"|"error"|"critical"} level
 *   不认识的级别降级成 info（老调用方传什么都不会炸）
 * @param {string} scope 来源标签，例如 "桥接" / "LLM" / "视觉"
 * @param {string} message 一句话说清发生了什么
 * @param {unknown} [detail] 需要展开才看的原始内容（错误栈、响应体…）
 */
export function log(level, scope, message, detail) {
  const lv = LEVELS.includes(level) ? level : "info";
  const entry = {
    id: ++seq,
    ts: new Date().toISOString(),
    level: lv,
    scope: scope ?? "系统",
    message: String(message ?? ""),
    detail: stringifyDetail(detail),
  };

  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);

  (CONSOLE_FN[lv] ?? console.log)(
    `${stamp()} [${entry.scope}] ${entry.message}${entry.detail ? `\n  ${entry.detail}` : ""}`
  );

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      /* 某个订阅者炸了不该影响别人 */
    }
  }
  return entry;
}

export const logDebug = (scope, message, detail) => log("debug", scope, message, detail);
export const logInfo = (scope, message, detail) => log("info", scope, message, detail);
export const logWarn = (scope, message, detail) => log("warn", scope, message, detail);
export const logError = (scope, message, detail) => log("error", scope, message, detail);
/** 服务本身出问题了（不是「某件事没做成」）。分不清就用 logError，见 LEVELS。 */
export const logCritical = (scope, message, detail) =>
  log("critical", scope, message, detail);

/**
 * 取历史日志快照。
 * @param {{since?: number, limit?: number}} [opts] since = 只要 id 大于它的
 */
export function getLogs({ since, limit } = {}) {
  let out = ring;
  if (Number.isFinite(since)) out = out.filter((e) => e.id > since);
  if (Number.isFinite(limit) && limit > 0 && out.length > limit) {
    out = out.slice(out.length - limit);
  }
  return out.slice();
}

export function clearLogs() {
  ring.length = 0;
  const entry = log("info", "系统", "日志已清空");
  return entry;
}

/** 订阅新日志，返回退订函数。 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function subscriberCount() {
  return subscribers.size;
}