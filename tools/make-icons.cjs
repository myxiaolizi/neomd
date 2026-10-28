/**
 * 生成 Neo MD 应用图标（PNG + ICO），无第三方依赖。
 * 设计：圆角方形蓝色渐变底 + 白色 N 字标。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'build');
fs.mkdirSync(OUT_DIR, { recursive: true });

/** 生成指定尺寸的 RGBA 像素 */
function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const pad = size * 0.02;
  const x0 = pad;
  const y0 = pad;
  const x1 = size - pad;
  const y1 = size - pad;

  const inRounded = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 || (x >= x0 + radius && x <= x1 - radius) || (y >= y0 + radius && y <= y1 - radius);
  };

  // N 字形笔画（归一化坐标 0..1）
  const strokes = [
    // 左竖
    [0.3, 0.26, 0.3, 0.74],
    // 右竖
    [0.7, 0.26, 0.7, 0.74],
    // 斜线
    [0.3, 0.26, 0.7, 0.74],
  ];

  const distToSeg = (px_, py_, x1s, y1s, x2s, y2s) => {
    const dx = x2s - x1s;
    const dy = y2s - y1s;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px_ - x1s) * dx + (py_ - y1s) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1s + t * dx;
    const cy = y1s + t * dy;
    return Math.hypot(px_ - cx, py_ - cy);
  };

  const strokeWidth = 0.075;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5)) {
        px[i] = 0;
        px[i + 1] = 0;
        px[i + 2] = 0;
        px[i + 3] = 0;
        continue;
      }
      // 渐变底色 #1677FF -> #4A9BFF（对角）
      const t = (x / size) * 0.5 + (y / size) * 0.5;
      let r = Math.round(22 + (74 - 22) * t);
      let g = Math.round(119 + (155 - 119) * t);
      let b = Math.round(255 + (255 - 255) * t);

      // N 字
      const nx = x / size;
      const ny = y / size;
      let onStroke = false;
      for (const [ax, ay, bx, by] of strokes) {
        if (distToSeg(nx, ny, ax, ay, bx, by) <= strokeWidth / 2) {
          onStroke = true;
          break;
        }
      }
      if (onStroke) {
        r = 255;
        g = 255;
        b = 255;
      }
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** PNG 编码（无压缩优化，使用 zlib 默认级别） */
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunks = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  chunks.push(sig);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** ICO 容器：内嵌多个 PNG 尺寸 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dirs = [];
  let offset = 6 + entries.length * 16;
  const blobs = [];
  for (const { size, png } of entries) {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size;
    d[1] = size >= 256 ? 0 : size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4); // color planes
    d.writeUInt16LE(32, 6); // bits per pixel
    d.writeUInt32LE(png.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = SIZES.map((size) => ({ size, png: encodePng(size, renderIcon(size)) }));

fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(entries));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), entries[entries.length - 1].png);
fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), encodePng(512, renderIcon(512)));

// 网页 favicon
const webPublic = path.join(__dirname, '..', 'apps', 'web', 'public');
fs.mkdirSync(webPublic, { recursive: true });
fs.writeFileSync(path.join(webPublic, 'favicon.svg'), buildSvg());
fs.writeFileSync(path.join(webPublic, 'icon-192.png'), encodePng(192, renderIcon(192)));
fs.writeFileSync(path.join(webPublic, 'icon-512.png'), encodePng(512, renderIcon(512)));

function buildSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#1677FF"/><stop offset="1" stop-color="#4A9BFF"/>
  </linearGradient></defs>
  <rect x="1" y="1" width="62" height="62" rx="14" fill="url(#g)"/>
  <path d="M19 47V17 M19 17l26 30 M45 47V17" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

console.log('图标已生成:', OUT_DIR);
for (const f of fs.readdirSync(OUT_DIR)) {
  console.log('  ', f, fs.statSync(path.join(OUT_DIR, f)).size, 'bytes');
}
