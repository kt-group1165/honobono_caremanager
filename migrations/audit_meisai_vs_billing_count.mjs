// ============================================================================
// 稼働データ (MEISAI) の回数 と 介護請求(明細付)_一覧.CSV の回数 を突き合わせる。
//
//   両方とも ほのぼのが出したものなので、**本来は一致するはず**。
//   ズレる = ほのぼの側で
//     ・保険外 (自費) に回した
//     ・請求から漏れた
//     ・月遅れ / 返戻 で保留した
//   のいずれか。新システムは MEISAI を実績の正としているので、
//   ズレはそのまま伝送の不一致になる。
//
//   実証: 四街道 秋山久子 — MEISAI 11 回 / 請求 7 回。
//   職員 金香蘭 の 4 回だけ落ちていたが、同職員の他 16 名 79 件は請求されており
//   資格等の理由ではない → **ほのぼの側の請求漏れ**の疑い (24,376 円)。
//
//   ⚠ 突合キーに 利用者番号だけを使ってはいけない。**事業者エントリごとに番号が振られる**ので
//     別人が同じ番号を持つ (東郷で 髙橋邦子 の稼働が別人の請求と結合して 稼働31/請求62 になった)。
//     事業者名 + 利用者番号 + サービスコード で突き合わせること。
//
//   node migrations/audit_meisai_vs_billing_count.mjs           # 全拠点
//   AREA_DIR=四街道 node migrations/audit_meisai_vs_billing_count.mjs
// ============================================================================
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const ONLY = process.env.AREA_DIR || "";
const MONTH = "2026/06";
const sjis = new TextDecoder("shift_jis");
// 事業者名の表記ゆれ (*Hana四街道訪問介護 / *Hana四街道（四街道 …) を吸収する
const norm = (s) => (s || "").normalize("NFKC").replace(/[\s　*＊(（].*$/, "").trim();

function parseLine(line) {
  const o = []; let c = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else { if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; }
  }
  o.push(c);
  return o;
}
function readCsv(p) {
  const lines = sjis.decode(readFileSync(p)).split(/\r?\n/).filter((l) => l !== "");
  const header = parseLine(lines[0]).map((h) => h.trim());
  const idx = {}; header.forEach((h, i) => (idx[h] = i));
  return { idx, rows: lines.slice(1).map(parseLine) };
}
function walk(dir, out = []) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

let totalSites = 0, totalDiff = 0, totalUnitsGap = 0;
const SITES = readdirSync(path.join(KAIGO, "伝送データ")).filter((d) =>
  existsSync(path.join(KAIGO, "サービス実績データ", d, "202606")),
);

for (const site of SITES.sort()) {
  if (ONLY && site !== ONLY) continue;
  const dir = path.join(KAIGO, "サービス実績データ", site, "202606");
  const files = walk(dir);
  const listPath = files.find((f) => path.basename(f) === "介護請求(明細付)_一覧.CSV");
  const meisaiPaths = files.filter((f) => /^MEISAI/i.test(path.basename(f)));
  if (!listPath || !meisaiPaths.length) continue;
  totalSites++;

  // 請求側: 利用者番号|サービスコード -> 回数 / 単位
  const L = readCsv(listPath);
  const g = (n) => L.idx[n];
  //   ⚠ 一覧CSV は **同じ明細行を 2 回持つことがある** (東郷: 髙橋邦子 31回 が 2 行 → 62 回に見えた)。
  //     明細書番号 + サービスコード + 回数 で重複を落としてから数える。
  const billed = new Map();
  const seenRow = new Set();
  for (const c of L.rows) {
    if ((c[g("提供年月")] || "") !== MONTH) continue;
    // 同じ実績が複数の明細書に載る。**請求年月が空 = まだ国保連に出していない控え**
    // (東郷 髙橋邦子: 明細書603 状態=国保対象/請求2026-06 と 明細書839 状態=発行済/請求年月空 の 2 本)。
    // 伝送に出るのは請求年月が入っている方だけなので、空の行は数えない。
    if (!(c[g("請求年月")] || "").trim()) continue;
    const code = (c[g("サービスコード")] || "").trim();
    if (!/^11[0-5]/.test(code)) continue; // 基本サービスのみ (加算は別集計)
    const dedup = `${(c[g("明細書番号")] || "").trim()}|${code}|${(c[g("回数")] || "").trim()}|${(c[g("単位数")] || "").trim()}`;
    if (seenRow.has(dedup)) continue;
    seenRow.add(dedup);
    const k = `${norm(c[g("事業所名")])}|${(c[g("利用者番号")] || "").trim()}|${code}`;
    const n = Number(c[g("回数")] || 0);
    const prev = billed.get(k) ?? { n: 0, unit: 0, name: (c[g("利用者名")] || "").trim() };
    prev.n += n;
    // 単位数は**行合計**なので 1 回あたりに割り戻す
    if (n > 0) prev.unit = Math.round(Number(c[g("単位数")] || 0) / n);
    billed.set(k, prev);
  }

  // 稼働側
  const acted = new Map();
  for (const mp of meisaiPaths) {
    const M = readCsv(mp);
    const iu = M.idx["利用者番号"], iC = M.idx["サービスコード"], iS = M.idx["職員名"], iN = M.idx["利用者名"], iD = M.idx["日付"], iB = M.idx["事業所番号"];
    if (iu == null || iC == null) continue;
    for (const c of M.rows) {
      const code = (c[iC] || "").trim();
      if (!/^11[0-5]/.test(code)) continue;
      if (iB != null && (c[iB] || "") === "9999999999") continue; // 障害エントリ
      const k = `${norm(c[0])}|${(c[iu] || "").trim()}|${code}`;
      const prev = acted.get(k) ?? { n: 0, name: (c[iN] || "").trim(), staff: {}, dates: [] };
      prev.n++;
      const s = (c[iS] || "").trim();
      prev.staff[s] = (prev.staff[s] || 0) + 1;
      prev.dates.push((c[iD] || "").trim());
      acted.set(k, prev);
    }
  }

  const diffs = [];
  for (const [k, a] of acted) {
    const b = billed.get(k);
    const bn = b?.n ?? 0;
    if (a.n === bn) continue;
    const unit = b?.unit ?? 0;
    diffs.push({ k, name: a.name, meisai: a.n, billed: bn, unit, staff: a.staff, unmatched: !b });
  }
  if (!diffs.length) continue;

  console.log(`\n=== ${site} — 稼働と請求で回数が違う ${diffs.length} 件 ===`);
  for (const d of diffs.sort((x, y) => Math.abs(y.meisai - y.billed) - Math.abs(x.meisai - x.billed))) {
    const gap = (d.meisai - d.billed) * d.unit;
    totalUnitsGap += gap;
    console.log(
      `  ${(d.name + "            ").slice(0, 12)} ${d.k.split("|")[2]} 稼働${d.meisai} 請求${d.billed}` +
        ` 差${d.meisai - d.billed}` +
        (d.unmatched ? "  ← 請求側に無し" : ` (${d.unit}単位/回 → ${gap > 0 ? "+" : ""}${gap}単位)`),
    );
  }
  totalDiff += diffs.length;
}
console.log(`\n────────────────────────────────────`);
console.log(`対象 ${totalSites} 拠点 / 回数違い ${totalDiff} 件 / 単位差 合計 ${totalUnitsGap.toLocaleString()} 単位`);
if (!totalDiff) console.log("すべて一致。");
