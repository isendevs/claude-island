// Draws the app icon (pixel Clawd on a dark rounded square) and saves it as
// build/icon.ico. Pure Node.js: we write the PNG and ICO bytes ourselves.
// Run: node build/make-icon.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CLAWD = [
  ".########.",
  ".#.####.#.",
  "##########",
  ".########.",
  ".#.#..#.#.",
];
const BG = [26, 26, 26, 255];
const ORANGE = [217, 119, 87, 255];
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function draw(size) {
  const px = new Uint8Array(size * size * 4); // RGBA, starts fully transparent
  const set = (x, y, c) => px.set(c, (y * size + x) * 4);

  // Rounded square background.
  const r = Math.round(size * 0.22);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(r - x, 0, x - (size - 1 - r));
      const dy = Math.max(r - y, 0, y - (size - 1 - r));
      if (dx * dx + dy * dy <= r * r) set(x, y, BG);
    }
  }

  // Clawd, as big as fits in ~80% of the width, centered.
  const p = Math.max(1, Math.floor((size * 0.8) / CLAWD[0].length));
  const ox = Math.floor((size - CLAWD[0].length * p) / 2);
  const oy = Math.floor((size - CLAWD.length * p) / 2);
  CLAWD.forEach((row, cy) =>
    [...row].forEach((cell, cx) => {
      if (cell !== "#") return;
      for (let y = 0; y < p; y++) for (let x = 0; x < p; x++) set(ox + cx * p + x, oy + cy * p + y, ORANGE);
    }),
  );
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  // Each row starts with a "filter" byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// An .ico file is a small table of contents followed by the images (PNG is allowed inside).
const images = SIZES.map((s) => png(s, draw(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map((img, i) => {
  const e = Buffer.alloc(16);
  e[0] = SIZES[i] === 256 ? 0 : SIZES[i]; // 0 means 256
  e[1] = SIZES[i] === 256 ? 0 : SIZES[i];
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(img.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.length;
  return e;
});

fs.writeFileSync(path.join(__dirname, "icon.ico"), Buffer.concat([header, ...entries, ...images]));
fs.writeFileSync(path.join(__dirname, "icon-preview.png"), images[images.length - 1]);
console.log(`Wrote build/icon.ico (${SIZES.join(", ")} px)`);
