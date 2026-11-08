"use strict";
// What a slide has to be before its review copy is made (utils/studio-review-
// worker.js): one still image, PNG or JPEG, with nothing see-through, of a
// sane size. The speaker approves the file itself, and sees a copy of it: a
// transparent picture would show as a flat colour in the copy but as the
// picture wherever it's posted, and an animated PNG shows its first frame in
// the copy but its last in a browser. So both are refused, with what to do.
//
//   check(buffer) → { ok: true, type, width, height, marked } or { ok: false, why }
//   marked: the PNG carries the app's own mark (made with the graphics system)
//
// The graphics system marks its PNGs with a tEXt chunk (MARK below, written
// by public/app/film-craft.js), so a set it made can't come back as an
// "upload" while the system is switched off.

const zlib = require("zlib");

const MAX_SIDE = 3000;
const MAX_PIXELS = 6000000;
const MARK_KEY = "Software";
const MARK_VALUE = "TOJ Studio graphics";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const no = (why) => ({ ok: false, why });

function sizeOk(w, h) {
  if (!(w > 0 && h > 0)) return "its size can't be read";
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) return `it's ${w}×${h}: export it at the kit's size (1080 wide), ${MAX_SIDE} pixels a side at most`;
  return null;
}

// Each PNG row starts with a filter byte; undo it to read the pixels.
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;
      const v = raw[p++];
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error("bad filter");
      out[row + x] = r & 0xff;
    }
  }
  return out;
}

function checkPng(buf) {
  let p = 8;
  let ihdr = null;
  const idat = [];
  let trns = null;
  let marked = false;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (p + 12 + len > buf.length) return no("the file is cut short");
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === "acTL" || type === "fcTL" || type === "fdAT") return no("it's an animated PNG: a slide is one still");
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "tEXt") {
      const z = data.indexOf(0);
      if (z > 0 && data.toString("latin1", 0, z) === MARK_KEY && data.toString("latin1", z + 1) === MARK_VALUE) marked = true;
    } else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!ihdr) return no("it isn't a PNG that can be read");
  const bad = sizeOk(ihdr.w, ihdr.h);
  if (bad) return no(bad);
  const see = "it has see-through parts: export it flattened, with no transparency, so the copy shows what will post";
  if (trns) return no(see);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!channels || ![1, 2, 4, 8, 16].includes(ihdr.depth)) return no("it isn't a PNG that can be read");
  if (ihdr.color === 4 || ihdr.color === 6) {
    // An alpha channel can still be fully opaque (a canvas export always has
    // one): read it. Interlaced ones are refused rather than read.
    if (ihdr.interlace) return no("it's an interlaced PNG with an alpha channel: export it without either");
    if (ihdr.depth !== 8 && ihdr.depth !== 16) return no("it isn't a PNG that can be read");
    let raw;
    try {
      raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (ihdr.w * channels * (ihdr.depth / 8) + 1) * ihdr.h + 1 });
    } catch (e) {
      return no("its pixels can't be read");
    }
    const bpp = channels * (ihdr.depth / 8);
    let px;
    try {
      px = unfilter(raw, ihdr.w, ihdr.h, bpp);
    } catch (e) {
      return no("its pixels can't be read");
    }
    const aw = ihdr.depth / 8;
    for (let i = bpp - aw; i < px.length; i += bpp) {
      if (px[i] !== 255 || (aw === 2 && px[i + 1] !== 255)) return no(see);
    }
  }
  return { ok: true, type: "png", width: ihdr.w, height: ihdr.h, marked };
}

function checkJpeg(buf) {
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return no("it isn't a JPEG that can be read");
    const m = buf[p + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    const len = buf.readUInt16BE(p + 2);
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = buf.readUInt16BE(p + 5);
      const w = buf.readUInt16BE(p + 7);
      const bad = sizeOk(w, h);
      return bad ? no(bad) : { ok: true, type: "jpeg", width: w, height: h, marked: false };
    }
    p += 2 + len;
  }
  return no("its size can't be read");
}

function check(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return no("it isn't an image that can be read");
  if (buf.subarray(0, 8).equals(PNG_SIG)) return checkPng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return checkJpeg(buf);
  return no("it isn't a PNG or a JPEG");
}

module.exports = { check, MAX_SIDE, MAX_PIXELS, MARK_KEY, MARK_VALUE };
