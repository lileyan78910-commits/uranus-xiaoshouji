/**
 * 冒充 tar-fs，只有 `pack`，够云备份打包用（cloudbackup.js 的 packSnapshot）。
 *
 * 真的 tar-fs 靠 fs 的文件描述符和流一个个读文件，Worker 的虚拟文件系统没有这些；
 * 这里的文件本来就整个在 KV 里，直接读出来拼成 tar。只认 packSnapshot 用到的那几个
 * 选项：`entries`、`finalize: false` + `finish(pack)` 钩子、`pack.entry()`。
 *
 * 解包（extract）不做：小手机不支持从包恢复，那几条路由在 src/index.js 里就拦掉了。
 */
import { Readable } from "node:stream";
import path from "node:path";
import fs from "./fs.js";

/*
 * Durable Object 一次最多 128MB 内存，包连原始文件带 gzip 要在内存里各放一份。
 * 聊天和记忆一般几 MB，远到不了；真到了就明说，别等 OOM 把整个后端拖挂。
 */
const MAX_RAW = 40 * 1024 * 1024;

const enc = new TextEncoder();

function octal(n, width) {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name, size, type = "0") {
  const h = new Uint8Array(512);
  const put = (str, at, len) => h.set(enc.encode(str).subarray(0, len), at);
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8); // 算校验和时这 8 位按空格算
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

const pad = (size) => new Uint8Array((512 - (size % 512)) % 512);

/** 名字超过 100 字节（中文文件名很容易）就先垫一条 PAX 头，把完整路径放那里。 */
function headers(name, size) {
  if (enc.encode(name).length <= 100) return [header(name, size)];
  const body = (len) => `${len} path=${name}\n`;
  let rec = body(0);
  // 长度字段把自己也算进去，位数变了要再算一遍
  for (let len = enc.encode(rec).length; ; len = enc.encode(rec).length) {
    const next = body(len);
    if (next === rec) break;
    rec = next;
  }
  const pax = enc.encode(rec);
  const short = `PaxHeaders/${path.posix.basename(name)}`.slice(0, 99);
  return [header(short, pax.length, "x"), pax, pad(pax.length), header(short, size)];
}

function toBytes(data) {
  if (typeof data === "string") return enc.encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function pack(cwd, opts = {}) {
  const stream = new Readable({ read() {} });
  let raw = 0;

  const p = {
    entry(h, data) {
      const bytes = toBytes(data ?? new Uint8Array(0));
      for (const part of headers(h.name, bytes.length)) stream.push(part);
      stream.push(bytes);
      stream.push(pad(bytes.length));
    },
    finalize() {
      stream.push(new Uint8Array(1024));
      stream.push(null);
    },
  };

  // 下一拍再开始：调用方要先把流接进 pipeline
  queueMicrotask(() => {
    try {
      for (const rel of opts.entries ?? []) {
        const bytes = toBytes(fs.readFileSync(path.join(cwd, rel)));
        raw += bytes.length;
        if (raw > MAX_RAW) {
          throw new Error(
            `要备份的内容超过 ${MAX_RAW / 1024 / 1024}MB，小手机的内存打不下这么大的包。少勾几块再试`
          );
        }
        p.entry({ name: rel.replace(/\\/g, "/") }, bytes);
      }
      if (opts.finalize === false) opts.finish?.(p);
      else p.finalize();
    } catch (e) {
      stream.destroy(e);
    }
  });

  return stream;
}

export function extract() {
  throw new Error("小手机不支持从备份包恢复");
}

export default { pack, extract };
