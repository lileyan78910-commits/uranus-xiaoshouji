/**
 * 冒充 `@spectrum-ts/core/authoring`：整包照转，只把 `ensureM4a` 换掉。
 *
 * iMessage 那个 provider 发语音条前会过一遍 ensureM4a：不是 m4a 就拿 ffmpeg
 * 转。Worker 里没有 ffmpeg，一转就炸。可我们这边发的已经是 caf（TTS 出 Ogg
 * Opus、换壳成 caf，见 core/server/src/caf.js:oggOpusToCaf）—— iPhone 自己录
 * 的语音条就是这个格式，本来就不用转。所以 caf 原样放行，其余照旧交给原版。
 *
 * 用相对路径引原版，是为了绕开 wrangler.toml 里的 alias（不然会引回自己）。
 */
import { ensureM4a as original } from "../../node_modules/@spectrum-ts/core/dist/authoring.js";

export * from "../../node_modules/@spectrum-ts/core/dist/authoring.js";

export async function ensureM4a(buffer, mimeType) {
  if (String(mimeType ?? "").toLowerCase() === "audio/x-caf" || isCaf(buffer)) return { buffer };
  return original(buffer, mimeType);
}

function isCaf(buf) {
  return buf?.length >= 4 && buf[0] === 0x63 && buf[1] === 0x61 && buf[2] === 0x66 && buf[3] === 0x66;
}
