// Small real images for tests: a PNG (opaque, see-through, animated or
// marked by the graphics system) and a JPEG header, built byte by byte.
const zlib = require("zlib");

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

// color: 2 = RGB, 6 = RGBA. alpha: the alpha of every pixel (RGBA only).
function png(w = 4, h = 4, { color = 6, alpha = 255, animated = false, mark = false, rgb = [200, 40, 40] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = color;
  const bpp = color === 6 ? 4 : 3;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * bpp);
    for (let x = 0; x < w; x++) {
      row[1 + x * bpp] = rgb[0];
      row[2 + x * bpp] = rgb[1];
      row[3 + x * bpp] = rgb[2];
      if (bpp === 4) row[4 + x * bpp] = alpha;
    }
    rows.push(row);
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (mark) parts.push(chunk("tEXt", Buffer.from("Software\0TOJ Studio graphics", "latin1")));
  if (animated) parts.push(chunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])));
  parts.push(chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function jpeg(w = 4, h = 4) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

module.exports = { png, jpeg };
