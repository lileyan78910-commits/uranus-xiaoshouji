/**
 * 不靠 ffmpeg，把 iMessage 的 `.caf` 语音条换个模型认得的壳。
 *
 * 平时这事归 media.js:toMp3ForStt（过一遍 ffmpeg 转 mp3）。可 Worker 里起
 * 不了子进程，没有 ffmpeg —— 小手机后端就是这么个环境。好在 caf 只是个
 * 容器，里面的东西多半不用解码：
 *
 *  - `opus`（现在 iPhone 录的语音条就是它）：把一个个 Opus 包原样拆出来，
 *    重新装进 Ogg 页里，就是一个标准的 `audio/ogg` —— Gemini 那十三种里有它。
 *  - `lpcm`（未压缩 PCM）：补一个 WAV 头就是 `audio/wav`。
 *
 * 别的编码（AMR、AAC……）这里不管，返回 null，上层照旧按原格式碰运气。
 *
 * 只转封装、不转码，所以永远是毫秒级，也不挑平台。
 */

const MAGIC = 0x63616666; // "caff"

/**
 * @param {Uint8Array} buf 原始 caf 字节
 * @returns {{buffer: Buffer, mimeType: string, duration?: number} | null}
 *   认不出 / 不支持的编码 / 文件坏了 → null
 */
export function remuxCaf(buf) {
  try {
    const caf = parseCaf(buf);
    if (!caf) return null;
    if (caf.desc.formatID === "opus") return cafOpusToOgg(caf);
    if (caf.desc.formatID === "lpcm") return cafPcmToWav(caf);
    return null;
  } catch {
    return null;
  }
}

/** caf 里装的是什么编码（`opus` / `lpcm` / `samr`……），不是 caf 返回 null。只给日志用 */
export function cafFormat(buf) {
  try {
    return parseCaf(buf)?.desc.formatID ?? null;
  } catch {
    return null;
  }
}

function fourcc(v, o) {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

function parseCaf(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 8 || v.getUint32(0) !== MAGIC) return null;
  let o = 8;
  let desc = null;
  let pakt = null;
  let data = null;
  while (o + 12 <= buf.length) {
    const type = fourcc(v, o);
    const size = Number(v.getBigInt64(o + 4));
    const body = o + 12;
    // data 块的长度可以写 -1，意思是「一直到文件末尾」
    const end = size < 0 ? buf.length : Math.min(buf.length, body + size);
    if (type === "desc") {
      desc = {
        sampleRate: v.getFloat64(body),
        formatID: fourcc(v, body + 8),
        formatFlags: v.getUint32(body + 12),
        bytesPerPacket: v.getUint32(body + 16),
        framesPerPacket: v.getUint32(body + 20),
        channels: v.getUint32(body + 24),
        bitsPerChannel: v.getUint32(body + 28),
      };
    } else if (type === "pakt") {
      pakt = { body, end };
    } else if (type === "data") {
      // 前 4 字节是 edit count，之后才是音频
      data = buf.subarray(body + 4, end);
    }
    if (size < 0) break;
    o = end;
  }
  if (!desc || !data) return null;
  return { buf, v, desc, pakt, data };
}

/** caf 的包长表：大端、每字节 7 位、最高位表示「后面还有」 */
function readVarint(buf, pos) {
  let n = 0;
  for (;;) {
    const b = buf[pos.i++];
    if (b === undefined) throw new Error("pakt 截断");
    n = n * 128 + (b & 0x7f);
    if (!(b & 0x80)) return n;
  }
}

function packetTable(caf) {
  const { v, buf, desc, pakt } = caf;
  if (!pakt) throw new Error("没有 pakt");
  const count = Number(v.getBigInt64(pakt.body));
  const priming = v.getInt32(pakt.body + 16);
  const pos = { i: pakt.body + 24 };
  const sizes = [];
  for (let k = 0; k < count; k++) {
    sizes.push(desc.bytesPerPacket || readVarint(buf, pos));
    if (!desc.framesPerPacket) readVarint(buf, pos); // 每包帧数，不定长时才有；时长下面按 TOC 算
  }
  return { sizes, priming };
}

// ---------------------------------------------------------------- Opus → Ogg

/** 一个 Opus 包有多少个 48kHz 采样（RFC 6716 §3.1 的 TOC 字节） */
function opusSamples(pkt) {
  if (!pkt.length) return 0;
  const toc = pkt[0];
  const config = toc >> 3;
  let frame;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3]; // SILK
  else if (config < 16) frame = [480, 960][config & 1]; // Hybrid
  else frame = [120, 240, 480, 960][config & 3]; // CELT
  const c = toc & 3;
  const frames = c === 0 ? 1 : c === 3 ? (pkt[1] ?? 0) & 0x3f : 2;
  return frame * frames;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

/**
 * 一页 Ogg。packets 里每个包都在这页收尾（语音条的包都很小，一页装几个
 * 包、段表不超 255 项由调用方保证）。
 */
function oggPage(packets, { serial, seq, granule, bos = false, eos = false }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const v = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  page[5] = (bos ? 2 : 0) | (eos ? 4 : 0);
  v.setBigInt64(6, BigInt(granule), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) {
    page.set(p, o);
    o += p.length;
  }
  v.setUint32(22, oggCrc(page), true);
  return page;
}

function cafOpusToOgg(caf) {
  const { desc, data } = caf;
  const { sizes, priming } = packetTable(caf);
  const channels = Math.max(1, Math.min(2, desc.channels || 1));
  // caf 的 priming 按它自己的采样率记，Ogg Opus 的 pre-skip 一律按 48k
  const preSkip = Math.max(0, Math.round((priming * 48000) / (desc.sampleRate || 48000)));

  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = channels;
  hv.setUint16(10, preSkip, true);
  hv.setUint32(12, Math.round(desc.sampleRate) || 48000, true);

  const vendor = new TextEncoder().encode("uranus");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages = [
    oggPage([head], { serial, seq: 0, granule: 0, bos: true }),
    oggPage([tags], { serial, seq: 1, granule: 0 }),
  ];

  let seq = 2;
  let granule = 0;
  let off = 0;
  let batch = [];
  let lacing = 0;
  const flush = (eos) => {
    pages.push(oggPage(batch, { serial, seq: seq++, granule, eos }));
    batch = [];
    lacing = 0;
  };
  for (let k = 0; k < sizes.length; k++) {
    const pkt = data.subarray(off, off + sizes[k]);
    off += sizes[k];
    if (pkt.length !== sizes[k]) break; // data 比包长表短：到此为止
    const segs = Math.floor(pkt.length / 255) + 1;
    if (batch.length && (lacing + segs > 255 || batch.length >= 50)) flush(false);
    batch.push(pkt);
    lacing += segs;
    granule += opusSamples(pkt);
  }
  if (!batch.length && pages.length === 2) return null;
  if (batch.length) flush(true);
  else pages[pages.length - 1][5] |= 4; // 不会走到：最后一页总有包

  const total = pages.reduce((s, p) => s + p.length, 0);
  const out = Buffer.alloc(total);
  let o = 0;
  for (const p of pages) {
    out.set(p, o);
    o += p.length;
  }
  return { buffer: out, mimeType: "audio/ogg", duration: Math.max(0, granule - preSkip) / 48000 };
}

// ---------------------------------------------------------------- PCM → WAV

function cafPcmToWav(caf) {
  const { desc, data } = caf;
  const bits = desc.bitsPerChannel;
  const channels = desc.channels || 1;
  const isFloat = (desc.formatFlags & 1) !== 0;
  const little = (desc.formatFlags & 2) !== 0;
  if (![8, 16, 24, 32].includes(bits)) return null;
  const bytes = bits / 8;
  const pcm = Buffer.from(data.subarray(0, data.length - (data.length % (bytes * channels))));
  // WAV 只认小端，caf 默认大端 —— 按采样宽度翻过来
  if (!little && bytes > 1) {
    for (let i = 0; i < pcm.length; i += bytes) pcm.subarray(i, i + bytes).reverse();
  }
  const rate = Math.round(desc.sampleRate);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(isFloat ? 3 : 1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * bytes * channels, 28);
  head.writeUInt16LE(bytes * channels, 32);
  head.writeUInt16LE(bits, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return {
    buffer: Buffer.concat([head, pcm]),
    mimeType: "audio/wav",
    duration: pcm.length / (rate * bytes * channels),
  };
}

// ---------------------------------------------------------------- Ogg Opus → caf

/**
 * 反方向：把 Ogg Opus 装进 caf，发成 iMessage 语音条。
 *
 * 发语音条平时靠 ffmpeg 转 m4a（media.js:toFaststartM4a），Worker 里没有
 * ffmpeg。可 iPhone 自己录的语音条就是 caf 装 Opus —— 让 TTS 直接出
 * Ogg Opus（Fish Audio、ElevenLabs 都能），这里把包原样挪进 caf，不用转码。
 *
 * 包长表（pakt）放在 data **前面**：和 m4a 的 faststart 一个道理，
 * 苹果那头读文件头就能拿到时长。
 *
 * @param {Uint8Array} buf 一个完整的 Ogg Opus 文件
 * @returns {{buffer: Buffer, mimeType: string, duration: number} | null}
 *   不是 Ogg Opus / 文件坏了 / 一个音频包都没有 → null
 */
export function oggOpusToCaf(buf) {
  try {
    const ogg = readOggOpus(buf);
    if (!ogg || !ogg.packets.length) return null;
    return buildOpusCaf(ogg);
  } catch {
    return null;
  }
}

/** 拆 Ogg 页、拼回包。只认第一条逻辑流（TTS 出的也只有一条）。 */
function readOggOpus(buf) {
  const packets = [];
  let serial = null;
  let head = null;
  let pending = [];
  let lastGranule = 0;
  let o = 0;
  while (o + 27 <= buf.length) {
    if (buf[o] !== 0x4f || buf[o + 1] !== 0x67 || buf[o + 2] !== 0x67 || buf[o + 3] !== 0x53) {
      return null;
    }
    const v = new DataView(buf.buffer, buf.byteOffset + o, 27);
    const pageSerial = v.getUint32(14, true);
    const granule = Number(v.getBigInt64(6, true));
    const nseg = buf[o + 26];
    const lacing = buf.subarray(o + 27, o + 27 + nseg);
    let body = o + 27 + nseg;
    const next = body + lacing.reduce((s, n) => s + n, 0);
    if (next > buf.length) break; // 最后一页截断：到此为止
    serial ??= pageSerial;
    if (pageSerial === serial) {
      for (const n of lacing) {
        pending.push(buf.subarray(body, body + n));
        body += n;
        if (n < 255) {
          const pkt = pending.length === 1 ? pending[0] : Buffer.concat(pending);
          pending = [];
          if (!head) {
            if (String.fromCharCode(...pkt.subarray(0, 8)) !== "OpusHead") return null;
            head = { channels: pkt[9] || 1, preSkip: pkt[10] | (pkt[11] << 8) };
          } else if (String.fromCharCode(...pkt.subarray(0, 8)) !== "OpusTags") {
            if (pkt.length) packets.push(pkt);
          }
        }
      }
      if (granule >= 0) lastGranule = granule;
    }
    o = next;
  }
  if (!head) return null;
  return { ...head, packets, lastGranule };
}

/** caf 的包长表编码：大端、每字节 7 位、最高位表示「后面还有」 */
function varint(n) {
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function cafChunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.write(type, 0, "ascii");
  out.writeBigInt64BE(BigInt(body.length), 4);
  out.set(body, 12);
  return out;
}

function buildOpusCaf({ channels, preSkip, packets, lastGranule }) {
  const samples = packets.map(opusSamples);
  const total = samples.reduce((s, n) => s + n, 0);
  // 每包帧数都一样就写进 desc，不一样写 0、逐包记在 pakt 里
  const fixed = samples.every((n) => n === samples[0]) ? samples[0] : 0;
  // Ogg 的最后一页 granule 记着真实结尾，多出来的是编码器补的尾巴
  const end = lastGranule > preSkip && lastGranule <= total ? lastGranule : total;
  const remainder = total - end;
  const valid = Math.max(0, end - preSkip);

  const desc = Buffer.alloc(32);
  desc.writeDoubleBE(48000, 0);
  desc.write("opus", 8, "ascii");
  desc.writeUInt32BE(fixed, 20);
  desc.writeUInt32BE(channels, 24);

  // 声道布局：kAudioChannelLayoutTag_Mono / _Stereo
  const chan = Buffer.alloc(12);
  chan.writeUInt32BE(channels === 2 ? 0x00650002 : 0x00640001, 0);

  const table = [];
  for (let k = 0; k < packets.length; k++) {
    table.push(...varint(packets[k].length));
    if (!fixed) table.push(...varint(samples[k]));
  }
  const pakt = Buffer.alloc(24 + table.length);
  pakt.writeBigInt64BE(BigInt(packets.length), 0);
  pakt.writeBigInt64BE(BigInt(valid), 8);
  pakt.writeInt32BE(preSkip, 16);
  pakt.writeInt32BE(remainder, 20);
  pakt.set(table, 24);

  const data = Buffer.concat([Buffer.alloc(4), ...packets]); // 前 4 字节 edit count = 0

  const fileHead = Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]); // "caff" v1
  return {
    buffer: Buffer.concat([
      fileHead,
      cafChunk("desc", desc),
      cafChunk("chan", chan),
      cafChunk("pakt", pakt),
      cafChunk("data", data),
    ]),
    mimeType: "audio/x-caf",
    duration: valid / 48000,
  };
}
