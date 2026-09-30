/**
 * 让全局 setTimeout / setInterval 返回带 `unref()` 的对象。
 *
 * 桌面版代码（还有 Photon SDK 自己）到处写 `setTimeout(...).unref()`。Node 里
 * 那是个 Timeout 对象，Worker 里全局的 setTimeout 可能只回一个数字，一调
 * `.unref()` 就 TypeError。这里包一层：返回的对象能 unref / ref / hasRef，
 * 也能当数字用，clearTimeout 两种都认。
 *
 * Worker 里 unref 本身没意义（没有「进程等不等定时器」这回事），空实现就行。
 */
export function installTimers() {
  const probe = globalThis.setTimeout(() => {}, 0);
  const native = typeof probe?.unref === "function";
  globalThis.clearTimeout(probe);
  if (native) return;

  const wrap = (set, clear) => {
    const make = (id) => ({
      id,
      unref() { return this; },
      ref() { return this; },
      hasRef() { return false; },
      refresh() { return this; },
      [Symbol.toPrimitive]() { return id; },
    });
    const idOf = (t) => (t && typeof t === "object" ? t.id : t);
    return {
      set: (fn, ms, ...args) => make(set(fn, ms, ...args)),
      clear: (t) => clear(idOf(t)),
    };
  };

  const t = wrap(globalThis.setTimeout.bind(globalThis), globalThis.clearTimeout.bind(globalThis));
  const i = wrap(globalThis.setInterval.bind(globalThis), globalThis.clearInterval.bind(globalThis));
  globalThis.setTimeout = t.set;
  globalThis.clearTimeout = t.clear;
  globalThis.setInterval = i.set;
  globalThis.clearInterval = i.clear;
}
