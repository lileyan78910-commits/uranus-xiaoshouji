/**
 * 冒充 `iconv-lite`，只给 express 的 body-parser / raw-body 用。
 *
 * 真包的 package.json 有个 browser 字段，打包时把它的流模块换成空对象，
 * 而 Worker 里 process.versions.node 又有值，它照样去调那个空对象 ——
 * 于是 express 一收请求体就 TypeError。body-parser 只用到三个函数，
 * 用 TextDecoder 就够了。
 */

function decoderName(enc) {
  const e = String(enc ?? "utf-8").toLowerCase();
  return e === "utf8" ? "utf-8" : e;
}

export function encodingExists(enc) {
  try {
    new TextDecoder(decoderName(enc));
    return true;
  } catch {
    return false;
  }
}

export function getDecoder(enc) {
  const d = new TextDecoder(decoderName(enc));
  return {
    write: (buf) => d.decode(buf, { stream: true }),
    end: () => d.decode() || undefined,
  };
}

export function decode(buf, enc) {
  return new TextDecoder(decoderName(enc)).decode(buf);
}

export function encode(str) {
  return Buffer.from(new TextEncoder().encode(String(str)));
}

export default { encodingExists, getDecoder, decode, encode };
