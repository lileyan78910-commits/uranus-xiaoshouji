/**
 * 小手机里用不上的重依赖（canvas、ffmpeg、spectrum SDK、nodemailer、express……）
 * 统一换成这个空壳：能 import，但一用就报一句看得懂的错。
 *
 * 这些都是桌面版才有的功能分支（画转账卡片、转码、本地线路、发邮件、起 HTTP 服务），
 * 小手机的主流程不会走到；真走到了，报错比悄悄什么都不做好查。
 */

function unavailable() {
  throw new Error("这个功能在小手机（Cloudflare Worker）上用不了");
}

const stub = new Proxy(unavailable, {
  get(_t, key) {
    if (key === "then") return undefined; // 别让 await import() 把它当 Promise
    if (key === Symbol.toPrimitive) return () => "[小手机不支持的模块]";
    return stub;
  },
  apply: unavailable,
  construct: unavailable,
});

export default stub;
