// make-ico.js — build icon.ico from icon.icns, dependency-free (fs + path only).
// Apple's .icns packs each icon size as its own chunk; the ones we want carry a
// raw PNG payload. We pull those out and repackage them verbatim into a Windows
// .ico (PNG-compressed entries are valid on Vista+, which is why >256px is
// dropped). Runtime asset for the tray + window icon. Run: npm run make-ico.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'icon.icns');   // resolve off the script, never cwd
const OUT = path.join(__dirname, '..', 'icon.ico');

// Chunk types Apple uses for PNG-backed reps; everything else is skipped.
const WHITELIST = new Set(['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic11', 'ic12', 'ic13']);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const die = (msg) => { console.error(msg); process.exit(1); };

// --- Step 1: parse the ICNS container (all multi-byte fields big-endian) ---
const buf = fs.readFileSync(SRC);
if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'icns') die('make-ico: not an icns file (bad magic) — ' + SRC);
// bytes 4-7 are the total-file length; we walk chunk-by-chunk regardless of it.

const kept = [];          // survivors: { type, size, data }
const seen = new Set();   // pixel sizes already kept — first in file order wins
let off = 8;
while (off + 8 <= buf.length) {
  const type = buf.toString('ascii', off, off + 4);
  const len = buf.readUInt32BE(off + 4);              // len INCLUDES the 8-byte chunk header
  if (len < 8 || off + len > buf.length) die(`make-ico: corrupt icns chunk '${type}' at ${off} (len ${len})`);
  const payload = buf.slice(off + 8, off + len);
  off += len;

  if (!WHITELIST.has(type)) { console.log(`  ${type}: ${payload.length}B — skipped (not whitelisted)`); continue; }
  if (payload.length < 24 || !payload.slice(0, 8).equals(PNG_SIG)) { console.log(`  ${type}: ${payload.length}B — skipped: not PNG`); continue; }
  // IHDR is the first PNG chunk after the 8-byte signature: 4-byte length (13) +
  // 'IHDR' + width + height, so width/height sit at payload offsets 16/20.
  const width = payload.readUInt32BE(16);
  const height = payload.readUInt32BE(20);
  if (width !== height) { console.log(`  ${type}: ${width}x${height} ${payload.length}B — skipped (non-square)`); continue; }
  if (width > 256) { console.log(`  ${type}: ${width}px ${payload.length}B — skipped (>256)`); continue; }
  if (seen.has(width)) { console.log(`  ${type}: ${width}px ${payload.length}B — skipped (duplicate size)`); continue; }
  seen.add(width);
  kept.push({ type, size: width, data: payload });
  console.log(`  ${type}: ${width}px ${payload.length}B — kept`);
}

if (!kept.length) die('make-ico: no PNG icons ≤256px found in icon.icns');
kept.sort((a, b) => a.size - b.size);   // ascending by pixel size

// --- Step 3: assemble icon.ico (all multi-byte fields little-endian) ---
const N = kept.length;
const dir = Buffer.alloc(6);            // ICONDIR
dir.writeUInt16LE(0, 0);               // reserved
dir.writeUInt16LE(1, 2);               // type: 1 = icon
dir.writeUInt16LE(N, 4);               // image count

let dataOff = 6 + 16 * N;              // first blob follows ICONDIR + all 16-byte entries
const entries = kept.map((img) => {
  const e = Buffer.alloc(16);          // ICONDIRENTRY
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);   // width — 0 means 256
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);   // height — 0 means 256
  e.writeUInt8(0, 2);                  // palette color count — none
  e.writeUInt8(0, 3);                  // reserved
  e.writeUInt16LE(1, 4);               // color planes
  e.writeUInt16LE(32, 6);              // bits per pixel
  e.writeUInt32LE(img.data.length, 8); // raw PNG byte length
  e.writeUInt32LE(dataOff, 12);        // absolute offset of this image's data
  dataOff += img.data.length;
  return e;
});

const ico = Buffer.concat([dir, ...entries, ...kept.map((i) => i.data)]);
fs.writeFileSync(OUT, ico);
console.log(`make-ico: wrote icon.ico — sizes [${kept.map((i) => i.size).join(', ')}], ${ico.length} bytes`);
