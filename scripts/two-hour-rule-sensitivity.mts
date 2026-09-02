/**
 * 訪問介護「2時間ルール」— 障害側 合算しきい値の感度分析
 *
 * ⚠ READ ONLY。DB にも CSV にも書き込まない。MEISAI (稼働データ) を読むだけ。
 *
 * ── 何を見るのか ────────────────────────────────────────────────────────
 *   `migrations/import_meisai_shougai_records.mjs` の `buildDailySessions` は
 *   同一利用者・同日・同一種別の提供を「間隔がしきい値以下なら 1 回に合算」する。
 *     同一職員   MERGE_GAP_MINUTES            既定 120 分 (未満)
 *     別職員     MERGE_GAP_DIFF_STAFF_MINUTES 既定  60 分 (以下)
 *   この 120/60 は **実データ 11 組から類推した経験則**で、告示・解釈通知の
 *   裏取りが未了 (memory project_2hour_rule_gap)。
 *
 *   そこで「しきい値を振ったら合算の判定が何組変わるか」= **不確かさの金額影響の
 *   大きさ**を出す。0 組しか動かないなら裏取りは急がない。動くなら急ぐ。
 *
 * ⚠ この script は **合算するかどうかの組数**までしか出さない。
 *   合算後の単位数がいくら変わるかは、段の積み上げ (convertSession) を通さないと
 *   出ないので **未算出**。金額そのものではなく「感度の有無」を見るためのもの。
 *
 * 使い方: npx tsx scripts/two-hour-rule-sensitivity.mts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const ROOT = fileURLToPath(new URL("../サービス実績データ", import.meta.url));
/** 障害の居宅介護 (身体 021001 / 家事 021002) だけを対象にする */
const KIND_CODES = new Set(["021001", "021002"]);

type Row = { area: string; client: string; date: string; kind: string; staff: string; s: number; e: number };

const toMin = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec((s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/^MEISAI/i.test(e)) out.push(p);
  }
  return out;
};

const rows: Row[] = [];
let filesRead = 0;
for (const f of walk(ROOT)) {
  const txt = iconv.decode(readFileSync(f), "Shift_JIS");
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) continue;
  const hdr = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  const at = (name: string) => hdr.indexOf(name);
  const iCode = at("サービスコード"), iStaff = at("職員名"), iClient = at("利用者名");
  const iDate = at("日付"), iS = at("算定開始時刻"), iE = at("算定終了時刻");
  const iS2 = at("派遣開始時間"), iE2 = at("派遣終了時間");
  if (iCode < 0 || iDate < 0 || iClient < 0) continue;
  filesRead++;
  const area = f.slice(ROOT.length + 1).split(/[\\/]/)[0];
  for (const ln of lines.slice(1)) {
    const c = ln.split(",").map((v) => v.replace(/^"|"$/g, "").trim());
    const kind = c[iCode] ?? "";
    if (!KIND_CODES.has(kind)) continue;
    const s = toMin(c[iS] || c[iS2] || ""), e = toMin(c[iE] || c[iE2] || "");
    if (s == null || e == null || e <= s) continue;
    rows.push({
      area, client: c[iClient] ?? "", date: (c[iDate] ?? "").replace(/\//g, "-"),
      kind, staff: iStaff >= 0 ? (c[iStaff] ?? "") : "", s, e,
    });
  }
}
console.log(`MEISAI ファイル ${filesRead} 本 / 居宅介護 (021001・021002) の行 ${rows.length} 件 (分母)`);
if (rows.length === 0) {
  console.log("⚠ 対象行が 0 件のため感度分析は行いません (母数 0)。");
  process.exit(0);
}

// 同一 利用者×日×種別 でまとめ、開始時刻順に隣接ペアの間隔を出す
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.area}|${r.client}|${r.date}|${r.kind}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}
const multi = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log(`同一 利用者×日×種別 の組: ${groups.size} / うち 2 件以上ある組: ${multi.length}`);

type Pair = { gap: number; sameStaff: boolean; area: string; client: string; date: string };
const pairs: Pair[] = [];
for (const [, v] of multi) {
  const sorted = v.slice().sort((a, b) => a.s - b.s || a.e - b.e);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    pairs.push({
      gap: cur.s - prev.e,
      sameStaff: !!prev.staff && prev.staff === cur.staff,
      area: cur.area, client: cur.client, date: cur.date,
    });
  }
}
console.log(`隣接ペア: ${pairs.length} 組 (分母)`);
if (pairs.length === 0) {
  console.log("⚠ 隣接ペアが 0 組のため、しきい値を振っても何も動きません。");
  process.exit(0);
}

// 間隔の分布
const bucket = new Map<number, number>();
for (const p of pairs) bucket.set(p.gap, (bucket.get(p.gap) ?? 0) + 1);
console.log("\n間隔の分布 (分 → 組数):");
for (const [g, n] of [...bucket.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(g).padStart(4)} 分: ${n} 組${g < 0 ? "  ⚠ 負 = 時間が重なっている" : ""}`);
}
const same = pairs.filter((p) => p.sameStaff).length;
console.log(`  同一職員 ${same} 組 / 別職員 ${pairs.length - same} 組`);

// 実装と同じ判定: 同一職員は「limit − 1 以下」(= 未満)、別職員は「limit 以下」
const merges = (p: Pair, sameLimit: number, diffLimit: number) =>
  p.sameStaff ? p.gap <= sameLimit - 1 : p.gap <= diffLimit;

console.log("\n=== 感度: しきい値を振ると合算される組数がどう変わるか ===");
const BASE_SAME = 120, BASE_DIFF = 60;
const baseCount = pairs.filter((p) => merges(p, BASE_SAME, BASE_DIFF)).length;
console.log(`  現行 (同一${BASE_SAME}分 / 別職員${BASE_DIFF}分): 合算 ${baseCount} 組 / ${pairs.length} 組`);
for (const [s, d] of [[90, 60], [150, 60], [120, 90], [120, 30], [90, 90], [150, 150]] as const) {
  const n = pairs.filter((p) => merges(p, s, d)).length;
  const diff = n - baseCount;
  console.log(
    `  同一${String(s).padStart(3)}分 / 別職員${String(d).padStart(3)}分: 合算 ${String(n).padStart(3)} 組` +
      `  (現行との差 ${diff > 0 ? "+" : ""}${diff} 組)`,
  );
}

// どのペアが「揺れる」か = しきい値次第で判定が変わるもの
const fragile = pairs.filter((p) => {
  const variants = [[90, 60], [120, 60], [150, 60], [120, 90], [120, 30]] as const;
  const set = new Set(variants.map(([s, d]) => merges(p, s, d)));
  return set.size > 1;
});
console.log(`\n★ しきい値次第で判定が変わるペア: ${fragile.length} 組 / ${pairs.length} 組 (分母)`);
for (const p of fragile.slice(0, 15)) {
  console.log(`    ${p.area} ${p.client} ${p.date}  間隔 ${p.gap} 分  ${p.sameStaff ? "同一職員" : "別職員"}`);
}
if (fragile.length > 15) console.log(`    … 他 ${fragile.length - 15} 組`);

console.log("\n⚠ ここで出るのは **合算するかどうかの組数**まで。合算後の単位数の差は");
console.log("   段の積み上げ (convertSession) を通さないと出ないため **未算出**。");
console.log("⚠ 閾値 120/60 は実データ 11 組から類推した **経験則**で、告示・解釈通知の");
console.log("   裏取りは未了。制度解釈は user 判断 (この script は判断材料のみ)。");
