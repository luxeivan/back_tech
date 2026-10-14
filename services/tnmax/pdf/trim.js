// Обрезка PNG по границам контента (убирает белые поля страницы).
// Чистый JS без зависимостей: decode (8bit, colorType 0/2/4/6, no interlace) → bbox → crop → encode (RGB).
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function decodePng(buffer) {
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer.toString("ascii", 1, 4) !== "PNG") {
    return null;
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = 0;
  let interlace = 0;
  const idatParts = [];

  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === "IDAT") {
      idatParts.push(buffer.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    pos = dataStart + len + 4;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !channels || !idatParts.length) {
    return null;
  }

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const lines = Buffer.alloc(height * stride);
  let rawPos = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const lineOff = y * stride;
    const prevOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[rawPos++];
      const a = x >= channels ? lines[lineOff + x - channels] : 0;
      const b = y > 0 ? lines[prevOff + x] : 0;
      const c = y > 0 && x >= channels ? lines[prevOff + x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = rb; break;
        case 1: val = rb + a; break;
        case 2: val = rb + b; break;
        case 3: val = rb + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      lines[lineOff + x] = val & 0xff;
    }
  }

  const rgb = Buffer.alloc(width * height * 3);
  const pxCount = width * height;
  for (let i = 0; i < pxCount; i++) {
    const s = i * channels;
    const p = i * 3;
    if (colorType === 0) {
      rgb[p] = rgb[p + 1] = rgb[p + 2] = lines[s];
    } else if (colorType === 2) {
      rgb[p] = lines[s];
      rgb[p + 1] = lines[s + 1];
      rgb[p + 2] = lines[s + 2];
    } else {
      const alpha = lines[s + channels - 1];
      for (let k = 0; k < 3; k++) {
        const ch = colorType === 4 ? lines[s] : lines[s + k];
        rgb[p + k] = Math.round((ch * alpha + 255 * (255 - alpha)) / 255);
      }
    }
  }

  return { width, height, rgb };
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    rgb.copy(raw, dst + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 2; // colorType RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function trimWhiteMargins(buffer, { threshold = 248, margin = 8 } = {}) {
  const img = decodePng(buffer);
  if (!img) return buffer;

  let minX = img.width;
  let maxX = -1;
  let minY = img.height;
  let maxY = -1;

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 3;
      if (img.rgb[p] < threshold || img.rgb[p + 1] < threshold || img.rgb[p + 2] < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return buffer; // полностью белая страница — не трогаем

  minX = Math.max(0, minX - margin);
  maxX = Math.min(img.width - 1, maxX + margin);
  minY = Math.max(0, minY - margin);
  maxY = Math.min(img.height - 1, maxY + margin);

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (w === img.width && h === img.height) return buffer;

  const out = Buffer.alloc(w * h * 3);
  const rowBytes = w * 3;
  for (let y = 0; y < h; y++) {
    const srcOff = ((minY + y) * img.width + minX) * 3;
    img.rgb.copy(out, y * rowBytes, srcOff, srcOff + rowBytes);
  }
  return encodePng(w, h, out);
}

module.exports = { trimWhiteMargins, decodePng, encodePng };
