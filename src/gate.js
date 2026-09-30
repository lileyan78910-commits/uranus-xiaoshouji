/**
 * 小手机控制台的登录凭证。
 *
 * 控制台要先在 Uranus 的登录服务上登录（账号密码或 Discord），拿到一张签过名的
 * 凭证，之后每个请求都带着它（`x-uranus-pass`）。这里用写死的公钥验签，不联网，
 * 所以后端离了登录服务也照样验得动。
 *
 * 凭证有效期 1 小时，控制台快到期时自动续；账号被停用就续不上了。
 */

// 登录服务签凭证那把私钥对应的公钥（Ed25519）
const PUBLIC_KEY = "CC-IKbLyNXvxVey1PVkbwhaiuu_yQvkSAVqh3Jh8xqw";

// 两边时钟对不太齐时的余量
const SKEW = 300;

let key = null;

function unb64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * 验一张凭证。对的话回载荷 `{ sub, name, via, iat, exp }`，不对回 null。
 * @param {string|null} pass
 */
export async function verifyPass(pass) {
  const m = /^up1\.([\w-]+)\.([\w-]+)$/.exec(pass ?? "");
  if (!m) return null;
  key ??= await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: PUBLIC_KEY }, { name: "Ed25519" }, false, [
    "verify",
  ]);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("Ed25519", key, unb64url(m[2]), new TextEncoder().encode(`up1.${m[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(unb64url(m[1])));
  } catch {
    return null;
  }
  const now = Date.now() / 1000;
  if (!(claims.exp > now - SKEW) || !(claims.iat < now + SKEW)) return null;
  return claims;
}
