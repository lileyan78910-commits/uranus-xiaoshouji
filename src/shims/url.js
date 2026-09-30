/**
 * 冒充 `node:url`。server 里只用它把 `import.meta.url` 转成路径，好算出
 * 仓库根（data/、assets/ 都挂在根下面）。打包进 Worker 之后 import.meta.url
 * 不是个像样的 file:// 地址，这里一律当成在虚拟根 /app/server/src/ 底下，
 * 于是 ROOT = /app，数据落在虚拟文件系统的 /app/data。
 */

const FAKE_FILE = "/app/server/src/index.js";

export function fileURLToPath(u) {
  const s = String(u?.href ?? u ?? "");
  if (!s.startsWith("file://")) return FAKE_FILE;
  const p = decodeURIComponent(new URL(s).pathname);
  return p.startsWith("/app/") ? p : FAKE_FILE;
}

export function pathToFileURL(p) {
  return new URL("file://" + encodeURI(String(p).replaceAll("\\", "/")));
}

const _URL = globalThis.URL;
const _URLSearchParams = globalThis.URLSearchParams;
export { _URL as URL, _URLSearchParams as URLSearchParams };

export default { fileURLToPath, pathToFileURL, URL: _URL, URLSearchParams: _URLSearchParams };
