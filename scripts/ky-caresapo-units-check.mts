/**
 * 居宅側の給付管理票 (KY 8222) のケアサポ行 × 福祉用具側の明細書 (KDS0031 明細書明細付) — 人ごとの貸与の単位 (2026-11-13 H 依頼)
 *
 *   npm run check:ky-caresapo-units                     # MONTH=2026-07 (既定)。基準値と比べる
 *   npm run check:ky-caresapo-units -- --update         # 基準値を書き直す (★ 悪化したまま更新しない)
 *   env MONTH=2026-06 で別の月も見られる (基準値は月ごと)
 *
 * なぜ: どちらも ほのぼのの出力で、★ 当方 DB に頼らない。利用票がまだ無い月 (2026-07) でも ほのぼのの数字を先に持っておける。
 *   KY 8222 も KDS0031 も「基準内 (保険請求) の単位」なので、限度超過の人でもずれない (KY 単独の値が小さく入る型とは別)。
 * 対象: KY の貸与 (種類 17/67) の行のうち 提供事業所がケアサポ (1272400050) の行。
 *   ケアサポ以外 (誉田・リンクス など) は ほのぼのの実出力が手元に無いので見ない (★ 実出力待ち・HANDOVER の次に出すもの)
 *
 * 突き合わせ: キー = (保険者番号 6 桁, 被保番)。
 *   KY 側 = その人の ケアサポ行の 給付計画単位数 の合計 (scripts/_ky-parse.mjs)
 *   明細書側 = 伝送データ/ケアサポ/福祉用具/<全月>/ほのぼのから/KDS0031_*.CSV の 提供年月 = MONTH の行のうち
 *              サービス種類 17/67 の「サービス単位数」の合計。月遅れ (処理月が後のファイル) も足す。月遅れぶんは別に数える
 *
 * ★ KDS0031 の読み方は order-app の scripts/_honobono-sync-core.mts (readKds0031 / C / EXPECTED_HEADER) から必要な列だけ写した。
 *   ★ 向こうが変わったらこちらも見る。order-app を import しないのは、隣のアプリを import した script で Vercel が落ちた前例があるため
 *   (memory feedback_cross_repo_script_breaks_vercel・2026-11-09〜11 に order/kaigo の本番が止まった)
 *
 * 基準値方式 (0 を目指す検査ではない): 「単位が違う人」「片側にしか居ない人」が基準値より増えたら FAIL
 * 負のコントロール: KY 側の 1 人の値を 1 ずらすと「単位が違う人」が 1 増えること
 * ★ この検査が見ていないもの: ケアサポ以外の貸与事業所 / 当方 DB の利用票の値 (check:riyouhyou-units・check:rental-units)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ky8222ByPerson, kyRentalLines } from "./_ky-parse.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MONTH = process.env.MONTH ?? "2026-07";
const YM = MONTH.replace("-", "");
const BASELINE = join(HERE, "ky-caresapo-units-baseline.json");
const UPDATE = process.argv.includes("--update");
const CARESAPO = "1272400050";
const KDS_BASE = join(ROOT, "伝送データ", "ケアサポ", "福祉用具");

// ── KDS0031 (order-app scripts/_honobono-sync-core.mts から写した。必要な列だけ) ──
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const C = { SVC_MONTH: 1, PROVIDER: 3, INSURER: 4, INSURED: 6, NAME: 12, CARE_OFFICE: 24, SVC_KIND: 62, SVC_UNITS: 69 } as const;
const EXPECTED_HEADER: [number, string][] = [[1, "提供年月"], [4, "保険者番号"], [6, "被保険者番号"], [12, "利用者名"], [69, "サービス単位数"]];
// 列 24 は居宅介護支援事業所番号 (order-app の C.CARE_OFFICE と同じ位置)。見出しの文言は確かめていないので値の形 (10 桁) で検算する
const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC").trim();
const ymOf = (s: string) => { const m = nfkc(s).match(/^(\d{4})[/-](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, "0")}` : ""; };
const nInsurer = (s: string | null | undefined) => { const d = nfkc(s).replace(/\D/g, ""); return d.length === 8 && d.startsWith("00") ? d.slice(2) : d; };
const nInsured = (s: string | null | undefined) => nfkc(s).toUpperCase();
const toInt = (s: string | null | undefined) => { const n = parseInt(nfkc(s), 10); return Number.isFinite(n) ? n : 0; };

function readKds0031(path: string): string[][] {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  for (const [i, want] of EXPECTED_HEADER) if (!(header[i] ?? "").includes(want)) throw new Error(`★ ${path} のヘッダー列 ${i} が「${want}」を含まない (実際: ${header[i]})。帳票が違う`);
  const rows = lines.slice(1).map(parseCsvLine);
  const bad = rows.filter((r) => r.length !== header.length).length;
  if (bad) throw new Error(`★ ${path}: 列数が ${header.length} でない行が ${bad} 行`);
  return rows;
}

type Person = { ky: number | null; kds: number | null; kdsLate: number; name: string };
type Result = { people: number; same: number; diff: number; kyOnly: number; kdsOnly: number; lateRows: number };
type Baseline = { _readme: string[]; months: Record<string, Result> };

// ── 自社の居宅 (KY を持っている居宅) ──
type KyLine = { insurer: string; insured: string; kyotakuOffice: string; providerNumber: string; plannedUnits: number };
const kyMap = ky8222ByPerson(join(ROOT, "伝送データ"), YM) as Map<string, KyLine[]>;
const ourKyotaku = new Set<string>(); for (const [, ls] of kyMap) for (const l of ls) ourKyotaku.add(nfkc(l.kyotakuOffice));
if (!ourKyotaku.size) { console.error(`✗ ${YM} の KY 8222 が 1 本も無い`); process.exit(1); }

// ── 明細書側 ──
const people = new Map<string, Person>();
const get = (k: string) => people.get(k) ?? people.set(k, { ky: null, kds: null, kdsLate: 0, name: "" }).get(k)!;
let kdsFiles = 0, lateRows = 0, otherKyotakuRows = 0, badCareOffice = 0;
const otherKyotakuPeople = new Set<string>();
for (const m of existsSync(KDS_BASE) ? readdirSync(KDS_BASE).filter((d) => /^\d{6}$/.test(d)).sort() : []) {
  const dir = join(KDS_BASE, m, "ほのぼのから");
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.startsWith("KDS0031") && x.toUpperCase().endsWith(".CSV"))) {
    kdsFiles++;
    const late = m > YM; // 処理月 (フォルダ) が提供月より後 = 月遅れ
    for (const r of readKds0031(join(dir, f))) {
      if (ymOf(r[C.SVC_MONTH]) !== MONTH) continue;
      if (nfkc(r[C.PROVIDER]) && nfkc(r[C.PROVIDER]) !== CARESAPO) continue;
      if (!/^(17|67)/.test(nfkc(r[C.SVC_KIND]))) continue;
      // ★ ケアサポは他社の居宅の利用者にも貸す。KY は自社の居宅の分しか無いので、担当の居宅が自社の人だけ比べる
      const co = nfkc(r[C.CARE_OFFICE]);
      if (!/^\d{10}$/.test(co)) badCareOffice++;
      if (!ourKyotaku.has(co)) { otherKyotakuRows++; otherKyotakuPeople.add(`${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}`); continue; }
      const p = get(`${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}`);
      p.kds = (p.kds ?? 0) + toInt(r[C.SVC_UNITS]);
      p.name ||= nfkc(r[C.NAME]);
      if (late) { p.kdsLate += toInt(r[C.SVC_UNITS]); lateRows++; }
    }
  }
}
if (!kdsFiles) { console.error(`✗ KDS0031 が 1 本も無い (${KDS_BASE})`); process.exit(1); }

// ── KY 側 ──
for (const [, lines] of kyMap) {
  for (const l of kyRentalLines(lines) as KyLine[]) {
    if (l.providerNumber !== CARESAPO) continue;
    const p = get(`${nInsurer(l.insurer)}|${nInsured(l.insured)}`);
    p.ky = (p.ky ?? 0) + Number(l.plannedUnits);
  }
}

function tally(ps: Map<string, Person>): { r: Result; diffs: string[]; onlies: string[] } {
  const r: Result = { people: ps.size, same: 0, diff: 0, kyOnly: 0, kdsOnly: 0, lateRows };
  const diffs: string[] = [], onlies: string[] = [];
  for (const [k, p] of ps) {
    if (p.ky != null && p.kds != null) {
      if (p.ky === p.kds) r.same++;
      else { r.diff++; diffs.push(`${k} ${p.name} KY ${p.ky} / 明細書 ${p.kds}${p.kdsLate ? ` (うち月遅れ ${p.kdsLate})` : ""}`); }
    } else if (p.ky != null) { r.kyOnly++; onlies.push(`${k} KY だけ ${p.ky}`); }
    else { r.kdsOnly++; onlies.push(`${k} ${p.name} 明細書だけ ${p.kds}${p.kdsLate ? ` (うち月遅れ ${p.kdsLate})` : ""}`); }
  }
  return { r, diffs, onlies };
}
const { r: cur, diffs, onlies } = tally(people);
console.log(`${MONTH}: KDS0031 ${kdsFiles} 本 / ケアサポの貸与がある人 ${cur.people} (KY・明細書の和集合)`);
console.log(`  自社の居宅 ${ourKyotaku.size} 事業所 / 他社の居宅の人 (比べない) ${otherKyotakuPeople.size} 名 ${otherKyotakuRows} 行${badCareOffice ? ` / ★ 居宅番号が 10 桁でない行 ${badCareOffice} (列の位置を疑う)` : ""}`);
console.log(`  単位が同じ ${cur.same} / 違う ${cur.diff} / KY だけ ${cur.kyOnly} / 明細書だけ ${cur.kdsOnly} / 明細書の月遅れの行 ${cur.lateRows}`);
for (const d of diffs.slice(0, 25)) console.log(`    ≠ ${d}`);
for (const d of onlies.slice(0, 25)) console.log(`    ◇ ${d}`);

// ── 負のコントロール ──
let negOk = false;
{
  const victim = [...people].find(([, p]) => p.ky != null && p.kds != null && p.ky === p.kds);
  if (victim) {
    const shifted = new Map(people); shifted.set(victim[0], { ...victim[1], ky: (victim[1].ky ?? 0) + 1 });
    const n = tally(shifted).r.diff;
    negOk = n === cur.diff + 1;
    console.log(`\n■ 負のコントロール: 一致している 1 人の KY を 1 ずらす → 違う ${cur.diff} → ${n} ${negOk ? "✓" : "✗ 増えない"}`);
  } else console.log("\n■ 負のコントロール: 一致している人が居ないので実施できない");
}
console.log("★ この検査が見ていないもの: ケアサポ以外の貸与事業所 (実出力待ち) / 当方 DB の利用票の値");

const base: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {
  _readme: [
    "基準値方式。月ごとに「単位が違う人」「KY だけ」「明細書だけ」が増えたら落ちる。0 を目指す検査ではない",
    "KY 8222 (居宅が作る給付管理票の計画単位) と KDS0031 (ケアサポの請求明細) は どちらも ほのぼのの出力。差は ほのぼの内の食い違い (計画と実績の差・月途中の開始/終了・返戻 など)",
  ],
  months: {},
};
if (UPDATE) {
  base.months[MONTH] = cur;
  writeFileSync(BASELINE, JSON.stringify(base, null, 2) + "\n");
  console.log(`\n基準値を書き直した: ${BASELINE} (${MONTH})`);
  process.exit(negOk ? 0 : 1);
}
const b = base.months[MONTH];
if (!b) { console.error(`\n✗ ${MONTH} の基準値が無い。--update で作る`); process.exit(1); }
const fails: string[] = [];
if (!negOk) fails.push("負のコントロールが鳴らない");
if (cur.diff > b.diff) fails.push(`単位が違う人 ${b.diff} → ${cur.diff}`);
if (cur.kyOnly > b.kyOnly) fails.push(`KY だけ ${b.kyOnly} → ${cur.kyOnly}`);
if (cur.kdsOnly > b.kdsOnly) fails.push(`明細書だけ ${b.kdsOnly} → ${cur.kdsOnly}`);
console.log(`\n基準値 (${MONTH}): 同じ ${b.same} / 違う ${b.diff} / KY だけ ${b.kyOnly} / 明細書だけ ${b.kdsOnly}`);
if (fails.length) { console.log("✗ FAIL"); for (const f of fails) console.log("  " + f); process.exit(1); }
console.log("✓ PASS (基準値より悪化なし・負のコントロール確認済み)");
