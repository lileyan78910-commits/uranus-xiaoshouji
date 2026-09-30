/**
 * 让 Worker 里的「本地时间」变成部署时配的时区。
 *
 * Worker 永远跑在 UTC，`process.env.TZ` 也改不了它。可桌面版到处是
 * `getHours()` / `new Date(y, m, d)` / 不带 timeZone 的 Intl.DateTimeFormat ——
 * 在本机它们跟着电脑的时区走，在这里全成了 UTC：提示词里的「现在几点」
 * 慢八小时，定时日记、主动消息的「每天几点」也全错。
 *
 * 所以把这几处换掉：
 *
 *  - `Date`：换成一个子类，本地的 get / set、按年月日构造、解析不带时区的
 *    字符串，都按 `tz` 算。UTC 那一套、`getTime()`、`toISOString()` 不动。
 *  - `Intl.DateTimeFormat` 和 `toLocale*String`：没传 timeZone 就补上 `tz`。
 *    `resolvedOptions().timeZone` 于是也报 `tz` —— 桌面版的 serverTimeZone()
 *    就是这么读的。
 */

const NativeDate = Date;
const NativeDTF = Intl.DateTimeFormat;

export function installTimeZone(tz) {
  if (!tz || tz === "UTC") return;
  try {
    new NativeDTF("en-US", { timeZone: tz });
  } catch {
    console.warn(`时区 ${tz} 认不出来，按 UTC 走`);
    return;
  }
  if (globalThis.Date.__uranusTz) return;

  // ---------------------------------------------------------------- 偏移量

  const parts = new NativeDTF("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const cache = new Map();
  /** 在 UTC 时刻 t，这个时区比 UTC 快多少毫秒。按 15 分钟一格缓存 */
  const offsetAt = (t) => {
    if (!Number.isFinite(t)) return 0;
    const key = Math.floor(t / 900_000);
    let off = cache.get(key);
    if (off === undefined) {
      const p = {};
      for (const { type, value } of parts.formatToParts(new NativeDate(key * 900_000))) p[type] = +value;
      off = NativeDate.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - key * 900_000;
      if (cache.size > 4096) cache.clear();
      cache.set(key, off);
    }
    return off;
  };
  /** 「墙上时间」（当成 UTC 记的毫秒数）→ 真正的 UTC 时刻。夏令时两次逼近 */
  const fromWall = (wall) => {
    let t = wall - offsetAt(wall);
    t = wall - offsetAt(t);
    return t;
  };
  const wallOf = (d) => {
    const t = NativeDate.prototype.getTime.call(d);
    return new NativeDate(t + offsetAt(t));
  };

  // ---------------------------------------------------------------- Date

  // 带时间、不带 Z / ±hh:mm 的 ISO 串按规范是本地时间；只有日期的按 UTC
  const LOCAL_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
  const parseLocal = (s) => {
    const str = String(s).trim();
    if (LOCAL_ISO.test(str)) return fromWall(NativeDate.parse(`${str.replace(" ", "T")}Z`));
    return NativeDate.parse(str);
  };

  class TzDate extends NativeDate {
    constructor(...args) {
      if (args.length === 0) super();
      else if (args.length === 1) {
        const a = args[0];
        super(typeof a === "string" ? parseLocal(a) : a instanceof NativeDate ? a.getTime() : a);
      } else {
        const [y, m, d = 1, h = 0, mi = 0, s = 0, ms = 0] = args.map(Number);
        const wall = NativeDate.UTC(y, m, d, h, mi, s, ms);
        // Date.UTC 把 0–99 年当 1900+，和本地构造器一致，不用另处理
        super(fromWall(wall));
      }
    }
    static parse(s) {
      return parseLocal(s);
    }
    getTimezoneOffset() {
      return -offsetAt(this.getTime()) / 60_000;
    }
    toString() {
      if (Number.isNaN(this.getTime())) return "Invalid Date";
      return `${this.toDateString()} ${this.toTimeString()}`;
    }
    toDateString() {
      const w = wallOf(this);
      return w.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+).*$/, "$1 $3 $2 $4");
    }
    toTimeString() {
      const w = wallOf(this);
      const off = -this.getTimezoneOffset();
      const sign = off >= 0 ? "+" : "-";
      const a = Math.abs(off);
      const hh = String(Math.floor(a / 60)).padStart(2, "0");
      const mm = String(a % 60).padStart(2, "0");
      return `${w.toISOString().slice(11, 19)} GMT${sign}${hh}${mm} (${tz})`;
    }
  }

  const GETTERS = ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"];
  for (const name of GETTERS) {
    const utc = NativeDate.prototype[`getUTC${name}`];
    Object.defineProperty(TzDate.prototype, `get${name}`, {
      value() {
        return utc.call(wallOf(this));
      },
      writable: true,
      configurable: true,
    });
  }
  // getYear 是老古董，有人用就给它
  Object.defineProperty(TzDate.prototype, "getYear", {
    value() {
      return this.getFullYear() - 1900;
    },
    writable: true,
    configurable: true,
  });

  const SETTERS = ["FullYear", "Month", "Date", "Hours", "Minutes", "Seconds", "Milliseconds"];
  for (const name of SETTERS) {
    const utc = NativeDate.prototype[`setUTC${name}`];
    Object.defineProperty(TzDate.prototype, `set${name}`, {
      value(...args) {
        const w = wallOf(this);
        const wall = utc.apply(w, args);
        return NativeDate.prototype.setTime.call(this, Number.isNaN(wall) ? NaN : fromWall(wall));
      },
      writable: true,
      configurable: true,
    });
  }

  // ---------------------------------------------------------------- Intl

  const withTz = (opts) => (opts?.timeZone ? opts : { ...opts, timeZone: tz });

  function DateTimeFormat(locales, options) {
    return new NativeDTF(locales, withTz(options));
  }
  DateTimeFormat.prototype = NativeDTF.prototype;
  DateTimeFormat.supportedLocalesOf = NativeDTF.supportedLocalesOf.bind(NativeDTF);
  Intl.DateTimeFormat = DateTimeFormat;

  for (const m of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
    const orig = NativeDate.prototype[m];
    Object.defineProperty(TzDate.prototype, m, {
      value(locales, options) {
        return orig.call(this, locales, withTz(options));
      },
      writable: true,
      configurable: true,
    });
  }

  Object.defineProperty(TzDate, "__uranusTz", { value: tz });
  globalThis.Date = TzDate;
}
