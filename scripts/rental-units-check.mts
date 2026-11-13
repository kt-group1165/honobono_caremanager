/**
 * 利用票 (第6表) の福祉用具貸与行に単位数が入っているか — 居宅介護支援事業所別 (2026-11-13 H 依頼)
 *
 *   npm run check:rental-units              # 基準値と比べる (悪化したら exit 1)
 *   npm run check:rental-units -- --update  # 基準値を書き直す (★ 悪化したまま更新しない)
 *   env MONTH=2026-06 (既定)
 *
 * ★ 母数 = 「その月に利用票 (kaigo_report_documents report_type=service-usage) がある人の 貸与行 (category 17/67)」。
 *   貸与契約の全件ではない。利用票が無い人の貸与はここに出ない
 * ★ 事業所 = その利用者の、その月に有効な 居宅介護支援事業所の割当 (client_office_assignments) が 1 つのときの事業所。
 *   0 件 / 2 件以上は「(居宅の割当なし)」「(居宅の割当が複数)」に入れる
 * ★ 投入済 = manual_units > 0 (単価) または rental_month_actual_units > 0 (実額)。_units_source (出どころ) 別にも数える
 *
 * 基準値方式 (0 を目指す検査ではない):
 *   ・未投入が 事業所ごとに基準値より増えたら FAIL
 *   ・出どころ別の投入済が 基準値より減ったら FAIL (埋めた行が消えた / 出どころが外れた)
 *   ・母数 (貸与行) が変わったのは「データが変わった」として表示だけ (落とさない)
 * 負のコントロール: 投入済の 1 行の _units_source を外すと FAIL すること / KY 単独の判定 (planKySingle) の境界
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planKySingle, verifyKySingle } from "../migrations/_ky_single_rental.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASELINE = join(HERE, "rental-units-baseline.json");
const UPDATE = process.argv.includes("--update");
const MONTH = process.env.MONTH ?? "2026-06";

type Svc = { category?: string | null; manual_units?: number | null; rental_month_actual_units?: number | null; _units_source?: string | null };
type Doc = { id: string; user_id: string; content: { services?: Svc[] } | null };
type Office = { id: string; name: string };
type Asg = { client_id: string; office_id: string; start_date: string | null; end_date: string | null };
type Area = { 貸与行: number; 未投入: number; bySource: Record<string, number> };
type Unmatched = { rows: number; docs: number; byMark: Record<string, number> };
type Baseline = { _readme: string[]; month: string; areas: Record<string, Area>; total: Area; unmatched?: Unmatched };

function restGet(): (q: string) => Promise<unknown[]> {
  const env = Object.fromEntries(
    readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
  );
  const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error(".env.local に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無い");
  return async (q: string) => {
    const r = await fetch(`${url}/rest/v1/${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const t = await r.text();
    if (!r.ok) throw new Error(`REST ${r.status}: ${t}`);
    return JSON.parse(t) as unknown[];
  };
}
async function getAll<T>(get: (q: string) => Promise<unknown[]>, q: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const page = await get(`${q}&limit=1000&offset=${off}`) as T[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const isRental = (s: Svc) => ["17", "67"].includes(String(s.category ?? ""));
const filled = (s: Svc) => Number(s.manual_units) > 0 || Number(s.rental_month_actual_units) > 0;
/** 出どころを月の部分を伏せて束ねる (fukuyogu_meisai_202606 → fukuyogu_meisai_*) */
const sourceKey = (s: Svc) => {
  const v = String(s._units_source ?? "");
  if (!v) return "(出どころ無し)";
  return v.replace(/_\d{4}-?\d{2}(-?\d{2})?$/, "_*");
};

function tally(docs: Doc[], areaOf: (userId: string) => string): { areas: Record<string, Area>; total: Area } {
  const areas: Record<string, Area> = {};
  const total: Area = { 貸与行: 0, 未投入: 0, bySource: {} };
  for (const d of docs) {
    const a = areaOf(d.user_id);
    for (const s of d.content?.services ?? []) {
      if (!isRental(s)) continue;
      const r = (areas[a] ??= { 貸与行: 0, 未投入: 0, bySource: {} });
      r.貸与行++; total.貸与行++;
      if (!filled(s)) { r.未投入++; total.未投入++; continue; }
      const k = sourceKey(s);
      r.bySource[k] = (r.bySource[k] ?? 0) + 1;
      total.bySource[k] = (total.bySource[k] ?? 0) + 1;
    }
  }
  return { areas, total };
}

function compare(cur: { areas: Record<string, Area>; total: Area }, base: Baseline): { fails: string[]; notes: string[] } {
  const fails: string[] = [], notes: string[] = [];
  for (const [a, r] of Object.entries(cur.areas)) {
    const b = base.areas[a];
    if (!b) { notes.push(`${a}: 基準値に無い事業所 (貸与行 ${r.貸与行} / 未投入 ${r.未投入})`); continue; }
    if (r.未投入 > b.未投入) fails.push(`${a}: 未投入 ${b.未投入} → ${r.未投入} (増えた)`);
    if (r.貸与行 !== b.貸与行) notes.push(`${a}: 母数 (貸与行) ${b.貸与行} → ${r.貸与行} (データが変わった)`);
  }
  for (const [k, n] of Object.entries(base.total.bySource)) {
    const c = cur.total.bySource[k] ?? 0;
    if (c < n) fails.push(`出どころ ${k}: 投入済 ${n} → ${c} (減った = 埋めた行が消えた / 出どころが外れた)`);
  }
  return { fails, notes };
}

// ── 0) KY 単独の判定 planKySingle / verifyKySingle の境界 (DB 不要。H 指示の負のコントロール含む) ──
{
  const r1 = { category: "17", content: "手すり貸与" };
  const ky1 = [{ serviceKind: "17", plannedUnits: 440 }];
  type C = [Svc[], { serviceKind: string; plannedUnits: number }[], string, string];
  const cases: C[] = [
    [[{ category: "11" }, r1], ky1, "ok:1:440", "利用票の貸与 1 行・KY 1 行 → 埋める"],
    [[r1, { category: "17", content: "歩行器貸与" }], ky1, "x", "★ 負: 利用票の貸与行が 2 行 → 書かない"],
    [[r1], [...ky1, { serviceKind: "17", plannedUnits: 300 }], "x", "KY の貸与行が 2 行 → 書かない"],
    [[r1], [], "x", "KY に貸与行なし → 書かない"],
    [[{ ...r1, rental_month_actual_units: 440 }], ky1, "x", "既に実額あり → 書かない"],
    [[{ ...r1, manual_units: 440 }], ky1, "x", "既に単価あり → 書かない"],
    [[r1], [{ serviceKind: "67", plannedUnits: 440 }], "x", "種類が違う (17 と 67) → 書かない"],
    [[{ category: "67" }], [{ serviceKind: "67", plannedUnits: 100 }], "ok:0:100", "予防 67 同士 → 埋める"],
    [[r1], [{ serviceKind: "17", plannedUnits: 0 }], "x", "KY の単位 0 → 書かない"],
  ];
  const show = (r: ReturnType<typeof planKySingle>) => (r.ok ? `ok:${r.index}:${r.units}` : "x");
  const bad = cases.filter(([s, k, want]) => show(planKySingle(s as never, k)) !== want);
  for (const [s, k, want, label] of bad) console.error(`✗ planKySingle = ${show(planKySingle(s as never, k))} / 期待 ${want} (${label})`);
  const SRC = "ky8222_single_2026-06";
  const vOk = verifyKySingle({ rental_month_actual_units: 440, _units_source: SRC }, 440, SRC);
  const vShift = verifyKySingle({ rental_month_actual_units: 441, _units_source: SRC }, 440, SRC); // ★ 負: KY の値を 1 ずらす
  const vSrc = verifyKySingle({ rental_month_actual_units: 440, _units_source: "betsuhyou_2026-06" }, 440, SRC);
  if (bad.length || !vOk || vShift || vSrc) { console.error(`✗ FAIL: KY 単独の判定の境界が崩れている (読み直し 一致 ${vOk} / 1 ずれ ${vShift} / 出どころ違い ${vSrc})`); process.exit(1); }
  console.log(`KY 単独の判定: 境界 ${cases.length} 件 OK / 負のコントロール 貸与 2 行の人 → 書かない・KY を 1 ずらす → 読み直しで不一致 ✓`);
}

// ── 1) 実データ ──
const get = restGet();
const offices = await getAll<Office>(get, "offices?select=id,name&service_type=eq.居宅介護支援&order=id.asc");
const nameById = new Map(offices.map((o) => [o.id, o.name]));
const [y, m] = MONTH.split("-").map(Number);
const first = `${MONTH}-01`, last = `${MONTH}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
const asg = (await getAll<Asg>(get, `client_office_assignments?select=client_id,office_id,start_date,end_date&office_id=in.(${[...nameById.keys()].join(",")})&order=id.asc`))
  .filter((r) => (!r.start_date || r.start_date <= last) && (!r.end_date || r.end_date >= first));
const officesOf = new Map<string, Set<string>>();
for (const r of asg) { const s = officesOf.get(r.client_id) ?? new Set<string>(); s.add(r.office_id); officesOf.set(r.client_id, s); }
const areaOf = (uid: string) => {
  const s = officesOf.get(uid);
  if (!s || s.size === 0) return "(居宅の割当なし)";
  if (s.size > 1) return "(居宅の割当が複数)";
  return nameById.get([...s][0]) ?? "(不明)";
};
const docs = await getAll<Doc>(get, `kaigo_report_documents?select=id,user_id,content&report_type=eq.service-usage&report_month=eq.${MONTH}&order=id.asc`);
const cur = tally(docs, areaOf);
// ★ 名前があるのに種類 (category) が空の行 = マスタに無い名前の行 (2026-11-14 H)。種類・単位が入らないので 限度額・単位の集計から抜ける。
//   印 _name_unmatched (unreadable = 印字の途中で切れた名前 / kind-only = 種類名だけの保険外らしい行)。印の無いものは 印を付ける前に入った行 (2026-06 の 5 行など)
const unmatched: Unmatched = { rows: 0, docs: 0, byMark: {} };
for (const d of docs) {
  const rs = (d.content?.services ?? []).filter((s) => (s as { content?: string }).content && s.category == null);
  if (!rs.length) continue;
  unmatched.docs++; unmatched.rows += rs.length;
  for (const s of rs) { const m = String((s as { _name_unmatched?: string })._name_unmatched ?? "(印なし)"); unmatched.byMark[m] = (unmatched.byMark[m] ?? 0) + 1; }
}
console.log(`名前があるのに種類が空の行 (限度額・単位の集計から抜ける行) ${unmatched.rows} 行 / ${unmatched.docs} 帳票 ${JSON.stringify(unmatched.byMark)}`);

console.log(`\n母数: ${MONTH} に利用票がある人の 貸与行 (category 17/67) ${cur.total.貸与行} 行 / 帳票 ${docs.length} 件 (貸与契約の全件ではない)`);
console.log(`投入済 ${cur.total.貸与行 - cur.total.未投入} 行 (${((1 - cur.total.未投入 / Math.max(cur.total.貸与行, 1)) * 100).toFixed(1)}%) / 未投入 ${cur.total.未投入} 行`);
console.log(`出どころ別: ${JSON.stringify(cur.total.bySource)}`);
console.log("\n貸与行  未投入  充足率  事業所 (居宅介護支援)");
for (const [a, r] of Object.entries(cur.areas).sort((p, q) => q[1].未投入 - p[1].未投入))
  console.log(`${String(r.貸与行).padStart(6)} ${String(r.未投入).padStart(7)} ${((1 - r.未投入 / Math.max(r.貸与行, 1)) * 100).toFixed(1).padStart(6)}%  ${a}`);

if (UPDATE) {
  const readme = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline)._readme : [
    "基準値方式。未投入が増えたら / 出どころ別の投入済が減ったら落ちる。0 を目指す検査ではない。",
    "なぜこの数か (2026-11-13): 他社の用具事業者の貸与の単位は 別表 (第7表) PDF か 提供票一覧からしか取れず、13 拠点ぶんが未取得だから。",
    "  埋まっているのは ケアサポ明細 (fukuyogu_meisai_*) 1,204 行と 高品・木更津の別表 (betsuhyou_*) 286 行 (+ KY 単独 ky8222_single_* を流した分)。",
    "  13 拠点の別表 (または居宅側の提供票 CSV) が入れば未投入は大きく減る。減ったら --update で締める。",
    "母数は「その月に利用票がある人の貸与行」。貸与契約の全件ではない。",
  ];
  writeFileSync(BASELINE, JSON.stringify({ _readme: readme, month: MONTH, areas: cur.areas, total: cur.total, unmatched } satisfies Baseline, null, 2) + "\n");
  console.log(`\n基準値を書き直した: ${BASELINE}`);
  process.exit(0);
}
if (!existsSync(BASELINE)) { console.error("\n✗ 基準値ファイルが無い。--update で作る"); process.exit(1); }
const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
if (base.month !== MONTH) { console.error(`\n✗ 基準値の月 ${base.month} ≠ ${MONTH}`); process.exit(1); }

// ── 負のコントロール: 投入済の 1 行の _units_source を外すと FAIL すること ──
const victim = docs.flatMap((d) => (d.content?.services ?? []).filter((s) => isRental(s) && filled(s) && s._units_source)).at(0);
let negOk = false;
if (victim) {
  const saved = victim._units_source;
  victim._units_source = null;
  negOk = compare(tally(docs, areaOf), base).fails.length > 0;
  victim._units_source = saved;
}
console.log(`\n■ 負のコントロール: 投入済の 1 行の _units_source を外す → ${victim ? (negOk ? "✓ FAIL になった" : "✗ 鳴らない (検査が効いていない)") : "✗ 出どころ付きの行が無く実施できない"}`);

const { fails, notes } = compare(cur, base);
if (!negOk) fails.push("負のコントロールが鳴らない");
// 名前があるのに種類が空の行が 増えたら落とす (基準値に無い = 古い基準値のときは 件数を出すだけ)
if (base.unmatched && unmatched.rows > base.unmatched.rows) fails.push(`名前があるのに種類が空の行 ${base.unmatched.rows} → ${unmatched.rows} (増えた。中身を見て、名前の照合で通せるものか 本当に読めないものかを分ける)`);
if (!base.unmatched) notes.push(`名前があるのに種類が空の行は 基準値に無い (--update で入る)。今 ${unmatched.rows} 行`);
for (const n of notes) console.log(`  ○ ${n}`);
console.log("\n★ この検査が見ていないもの: 値が正しいか (KY との突合は check:riyouhyou-units) / 利用票が無い人の貸与 / 2026-06 以外の月 (MONTH で指定)");
if (fails.length) { console.log("✗ FAIL"); for (const f of fails) console.log("  " + f); process.exit(1); }
console.log("✓ PASS (基準値より悪化なし・負のコントロール確認済み)");
