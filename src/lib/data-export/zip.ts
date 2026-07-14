// ─── 依存追加なしの ZIP writer (無圧縮 STORE 方式) ──────────────────────────
// jszip 等の外部依存を増やさないため、ZIP コンテナを自前で組み立てる。
// 圧縮はしない (method 0 = STORE)。CSV/JSON をテーブルごとに 1 entry として格納する。
// ファイル名は ASCII (テーブル名) のみを想定するが、UTF-8 flag (bit 11) は立てておく。

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS 形式の日時 (ZIP header 用) */
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export interface ZipEntry {
  /** entry 名 (ASCII 推奨: 例 "clients.csv") */
  name: string;
  data: Uint8Array;
}

/**
 * entries を無圧縮 ZIP にまとめて Blob を返す。
 * 4GB 超 / 65535 entry 超 (ZIP64 が必要な規模) は想定外のため throw する。
 */
export function buildZip(entries: ZipEntry[]): Blob {
  if (entries.length > 0xffff) throw new Error("ZIP entry 数が上限 (65535) を超えています");
  const now = dosDateTime(new Date());
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let totalSize = 0;

  const u16 = (v: number, view: DataView, at: number) => view.setUint16(at, v, true);
  const u32 = (v: number, view: DataView, at: number) => view.setUint32(at, v, true);

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    totalSize += size;
    if (size > 0xffffffff || totalSize > 0xffffffff) {
      throw new Error("ZIP サイズが 4GB を超えるため出力できません (テーブルを分けて出力してください)");
    }

    // Local file header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    u32(0x04034b50, lv, 0); // signature
    u16(20, lv, 4); // version needed
    u16(0x0800, lv, 6); // flags: UTF-8 filename
    u16(0, lv, 8); // method: STORE
    u16(now.time, lv, 10);
    u16(now.date, lv, 12);
    u32(crc, lv, 14);
    u32(size, lv, 18); // compressed size (= raw)
    u32(size, lv, 22); // uncompressed size
    u16(nameBytes.length, lv, 26);
    u16(0, lv, 28); // extra length
    lfh.set(nameBytes, 30);
    chunks.push(lfh, entry.data);

    // Central directory header (46 bytes + name)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    u32(0x02014b50, cv, 0);
    u16(20, cv, 4); // version made by
    u16(20, cv, 6); // version needed
    u16(0x0800, cv, 8);
    u16(0, cv, 10);
    u16(now.time, cv, 12);
    u16(now.date, cv, 14);
    u32(crc, cv, 16);
    u32(size, cv, 20);
    u32(size, cv, 24);
    u16(nameBytes.length, cv, 28);
    // extra/comment/disk/int-attr = 0, ext-attr = 0
    u32(offset, cv, 42); // local header offset
    cdh.set(nameBytes, 46);
    central.push(cdh);

    offset += lfh.length + size;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);

  // End of central directory (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  u32(0x06054b50, ev, 0);
  u16(entries.length, ev, 8);
  u16(entries.length, ev, 10);
  u32(centralSize, ev, 12);
  u32(offset, ev, 16);

  return new Blob([...chunks, ...central, eocd] as BlobPart[], { type: "application/zip" });
}
