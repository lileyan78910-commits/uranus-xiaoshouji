/**
 * 位置推送：对方在「查找」里把位置共享给了线路那个号，就定时去问一次对方在哪，
 * 交给 imessage.js 拼成一句系统提示送给模型。
 *
 * 走的是 Photon 的位置接口（location_service：ListSharedFriendLocations），
 * Spectrum 没暴露它，所以和 chatbg.js / poll.js 一样自己开 gRPC（铸币、开客户端在
 * photongrpc.js）。
 *
 * ── 为什么是定时问，不是订阅那条 WatchSharedFriendLocations 流 ──
 *
 * 用户要的就是「每隔 N 秒推一次」：推一次就是一整轮模型调用，频率得由用户说了算，
 * 而不是由对方手机多久上报一次决定。流推得再勤，最后也得按 N 秒掐一遍；那不如
 * 直接每 N 秒问一次。N 最小一分钟，所以这里每次都是**用完就关**的短连接
 * （同 card.js:fetchCardDetail），不常驻，token 走 photongrpc 的缓存，不会多铸。
 *
 * ── 按号码一个个问，不用 list() ──
 *
 * `locations.list()` 不带号码，**共享线路**上网关不知道该路由到哪个实例，
 * 直接回 FAILED_PRECONDITION「No instance routed for this request」—— 实测过，
 * 共享线路上位置推送因此一次都没成过。`locations.get(address)` 带着号码，
 * 路由得过去；对方没共享时抛 NotFoundError（「Address is not currently sharing
 * a location」），那是正常答案，不算失败。反正也只推给这个角色的聊天对象
 * （见 imessage.js:locPeersOf），按号码问正好省掉「拿全表再过滤」。
 *
 * 只用在云端模式。本地 Mac 模式没有 Photon 可连。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";
import { closeClients, createLineClients } from "./photongrpc.js";

/** 一次查询的超时。定位接口背后是真去问「查找」，给宽一点。 */
const QUERY_TIMEOUT_MS = 15_000;

/**
 * 开起来之后第一次问要等多久。
 *
 * 不立刻问：刚连上那一刻主连接还在补消息、主动消息还在回表，别再叠一轮模型调用。
 * 也不等满一个周期：用户刚打开开关，想马上看到效果。
 */
const FIRST_DELAY_MS = 20_000;

/** onlyWhenMoved 下，挪了多少米以内算「没动」。GPS 在室内飘个几十米很正常。 */
export const LOCATION_MOVE_M = 100;

/** 这个错误是不是「对方没在共享位置」—— 那是正常答案，不是接口坏了。 */
export function isNotSharing(e) {
  return e?.name === "NotFoundError" || /not currently sharing/i.test(String(e?.message ?? ""));
}

/** 在一条线路上挨个问这几个号码。没共享的跳过；别的错误照抛（算这条线路没问到）。 */
async function getEach(client, addresses) {
  const out = [];
  for (const address of addresses) {
    try {
      const loc = await client.locations.get(address);
      if (loc) out.push(loc.address ? loc : { ...loc, address });
    } catch (e) {
      if (!isNotSharing(e)) throw e;
    }
  }
  return out;
}

/** 两个经纬度之间的距离（米，haversine）。 */
export function distanceM(a, b) {
  const R = 6_371_000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 这一条有没有能用的坐标。 */
export function hasFix(loc) {
  return Number.isFinite(loc?.latitude) && Number.isFinite(loc?.longitude);
}

/**
 * 跟上一次推给模型的那份比，算不算「动了」。
 *
 * 没推过 → 算动了（第一次总要说一声）。地址文字变了也算：同一栋楼里换了个
 * 门牌不重要，但「某某路」变成「某某机场」哪怕坐标差得不多也值得说。
 */
export function hasMoved(prev, next, thresholdM = LOCATION_MOVE_M) {
  if (!prev || !hasFix(prev)) return true;
  if (!hasFix(next)) return false;
  if (distanceM(prev, next) >= thresholdM) return true;
  // 同一种地址才比：反向地理编码时有时无，一次只给短的、一次只给长的，
  // 拿短的去比长的永远不等，人没动也会被当成「动了」
  const s = (v) => String(v ?? "").trim();
  for (const field of ["shortAddress", "longAddress"]) {
    const a = s(prev[field]);
    const b = s(next[field]);
    if (a && b) return a !== b;
  }
  return false;
}

/** 「3 分钟前」这种。拿不到时间就空串。 */
function agoText(ts, now) {
  const t = ts instanceof Date ? ts.getTime() : Number(new Date(ts ?? NaN));
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
}

/**
 * 一份位置 → 给模型的那句提示。
 *
 * `{{user}}` 留字面量，由 prompt.js:applyVars 替换（和 card.js 那几条一样）。
 * 坐标也带上：地址解析不出来的时候（荒郊野外、刚开始定位）模型至少还有个数；
 * 精度只留 5 位小数（米级），再多是假精度。时间给相对的 —— 服务器的时区和
 * 用户的时区未必一样，写「16:45」反而会说错。
 */
export function locationHint(loc, now = Date.now()) {
  if (!hasFix(loc)) return "";
  const addr = String(loc.longAddress || loc.shortAddress || "").trim();
  const coord = `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
  const acc = Number.isFinite(loc.accuracy) && loc.accuracy > 0 ? `，误差约 ${Math.round(loc.accuracy)} 米` : "";
  const ago = agoText(loc.locationTimestamp, now);
  const where = addr ? `${addr}（${coord}${acc}）` : `${coord}${acc ? `（${acc.slice(1)}）` : ""}`;
  return `[系统提示:「查找」里{{user}}现在的位置：${where}${ago ? `，${ago}定位` : ""}]`;
}

/**
 * 定时问一次「谁在给这条线路共享位置、在哪」。
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectSecret
 * @param {string} opts.label 日志里显示的角色名
 * @param {number} opts.intervalMs 两次之间隔多久
 * @param {() => Iterable<string>} [opts.addresses] 每次到点现取：问哪几个号码（见文件头「按号码一个个问」）。
 *   不给就退回 list()；给了但是空的，这一轮不连 Photon，直接交一个空数组
 * @param {(list: object[]) => void | Promise<void>} opts.onLocations 每问到一次就给一次（可能是空数组）
 * @returns {{stop: () => void, intervalMs: number}}
 */
export function watchFriendLocations({ projectId, projectSecret, label, intervalMs, onLocations, addresses }) {
  const scope = label ? `位置推送·${label}` : "位置推送";
  let stopped = false;
  let timer = null;
  /** 连着失败几次了。只有第一次记 warn，后面的记 debug，恢复了再说一声 */
  let fails = 0;

  const schedule = (wait) => {
    if (stopped) return;
    timer = setTimeout(tick, wait);
    timer.unref?.();
  };

  async function tick() {
    timer = null;
    if (stopped) return;
    let opened = [];
    try {
      const want = addresses ? [...new Set(addresses())].filter(Boolean) : null;
      if (want && !want.length) {
        if (!stopped) await onLocations([]);
        return;
      }
      opened = await createLineClients(projectId, projectSecret, { timeout: QUERY_TIMEOUT_MS });
      const all = [];
      let lastErr = null;
      let okCount = 0;
      for (const { client, instanceId } of opened) {
        try {
          for (const loc of want ? await getEach(client, want) : await client.locations.list()) {
            // 专线多条线路时同一个人可能两条上都问得到，留先问到的那份
            if (!all.some((x) => x?.address && x.address === loc?.address)) all.push(loc);
          }
          okCount += 1;
        } catch (e) {
          // 专线多条线路时，一条问不到不耽误别的；全都问不到才算这次失败
          lastErr = e;
          logDebug(scope, `线路 ${instanceId} 上没问到位置：${String(e?.message ?? e)}`);
        }
      }
      if (!okCount && lastErr) throw lastErr;
      if (fails) logInfo(scope, "位置接口恢复了");
      fails = 0;
      if (!stopped) await onLocations(all);
    } catch (e) {
      fails += 1;
      const msg = `问位置失败：${String(e?.message ?? e)}`;
      if (fails === 1) logWarn(scope, `${msg}（到点会接着问，恢复前不再重复报）`);
      else logDebug(scope, `${msg}（连着第 ${fails} 次）`);
    } finally {
      await closeClients(opened);
      // 放在 finally 里：上面「没人可问」那条是直接 return 的
      schedule(intervalMs);
    }
  }

  schedule(Math.min(FIRST_DELAY_MS, intervalMs));
  logDebug(scope, `开始了，每 ${Math.round(intervalMs / 1000)} 秒问一次`);

  return {
    intervalMs,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
