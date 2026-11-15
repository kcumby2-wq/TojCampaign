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

// Each PNG row starts with a filter byte; undo it, a row at a time (two rows
// held, not the picture), and stop at the first pixel that isn't opaque.
// aw: the alpha sample's width in bytes (1 here: 16-bit alpha is refused).
function allOpaque(raw, width, height, bpp, aw) {
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    if (p + 1 + stride > raw.length) throw new Error("short");
    const f = raw[p];
    const s = p + 1;
    p = s + stride;
    if (f === 0) raw.copy(cur, 0, s, s + stride);
    else if (f === 1) {
      for (let x = 0; x < bpp; x++) cur[x] = raw[s + x];
      for (let x = bpp; x < stride; x++) cur[x] = (raw[s + x] + cur[x - bpp]) & 255;
    } else if (f === 2) {
      for (let x = 0; x < stride; x++) cur[x] = (raw[s + x] + prev[x]) & 255;
    } else if (f === 3) {
      for (let x = 0; x < bpp; x++) cur[x] = (raw[s + x] + (prev[x] >> 1)) & 255;
      for (let x = bpp; x < stride; x++) cur[x] = (raw[s + x] + ((cur[x - bpp] + prev[x]) >> 1)) & 255;
    } else if (f === 4) {
      for (let x = 0; x < bpp; x++) cur[x] = (raw[s + x] + prev[x]) & 255;
      for (let x = bpp; x < stride; x++) {
        const a = cur[x - bpp], b = prev[x], c = prev[x - bpp];
        const pa = b > c ? b - c : c - b, pb = a > c ? a - c : c - a, d = a + b - c - c, pc = d < 0 ? -d : d;
        cur[x] = (raw[s + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else throw new Error("bad filter");
    for (let i = bpp - aw; i < stride; i += bpp) if (cur[i] !== 255) return false;
    const t = prev; prev = cur; cur = t;
  }
  return true;
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
    if (type === "IHDR") {
      // One header, first, of the size the format says: a second one could
      // tell this check one size and a browser another.
      if (ihdr || idat.length || len !== 13) return no("it isn't a PNG that can be read");
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    }
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
    // 16-bit alpha is refused rather than read: reading it is slow, and no
    // export the kit names makes one.
    if (ihdr.depth === 16) return no("it's a 16-bit PNG with an alpha channel: export it at 8 bits, flattened");
    if (ihdr.depth !== 8) return no("it isn't a PNG that can be read");
    let raw;
    try {
      raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (ihdr.w * channels * (ihdr.depth / 8) + 1) * ihdr.h + 1 });
    } catch (e) {
      return no("its pixels can't be read");
    }
    let opaque;
    try {
      opaque = allOpaque(raw, ihdr.w, ihdr.h, channels, 1);
    } catch (e) {
      return no("its pixels can't be read");
    }
    if (!opaque) return no(see);
  }
  return { ok: true, type: "png", width: ihdr.w, height: ihdr.h, marked };
}

// Reads every marker to the end of the picture (EOI), through the coded
// data of each scan (a stuffed 0xFF00 or a restart marker is data). Exactly
// one frame header (SOF) before the end: a second could tell this check one
// size and a viewer another, or give the review copy another picture.
// Anything after the end (a phone's second image) isn't read.
function checkJpeg(buf) {
  let p = 2;
  let size = null;
  let ended = false;
  while (p + 2 <= buf.length) {
    if (buf[p] !== 0xff) return no("it isn't a JPEG that can be read");
    const m = buf[p + 1];
    if (m === 0xff) { p += 1; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
    if (m === 0xd9) { ended = true; break; }
    if (p + 4 > buf.length) return no("the file is cut short");
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) return no("the file is cut short");
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (size || len < 8) return no("it isn't a JPEG that can be read");
      size = { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
    }
    p += 2 + len;
    if (m === 0xda) {
      // The scan's coded data, up to the next marker that isn't data.
      for (;;) {
        const q = buf.indexOf(0xff, p);
        if (q < 0 || q + 1 >= buf.length) return no("the file is cut short");
        const n = buf[q + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { p = q + 2; continue; }
        p = q;
        break;
      }
    }
  }
  if (!size) return no("its size can't be read");
  if (!ended) return no("the file is cut short");
  const bad = sizeOk(size.w, size.h);
  return bad ? no(bad) : { ok: true, type: "jpeg", width: size.w, height: size.h, marked: false };
}

function check(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return no("it isn't an image that can be read");
  try {
    if (buf.subarray(0, 8).equals(PNG_SIG)) return checkPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return checkJpeg(buf);
  } catch (e) {
    // A header that ends early, or a field out of range: not readable.
    return no("it isn't an image that can be read");
  }
  return no("it isn't a PNG or a JPEG");
}

module.exports = { check, MAX_SIDE, MAX_PIXELS, MARK_KEY, MARK_VALUE };
