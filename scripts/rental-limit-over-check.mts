/**
 * 区分支給限度を超えた人の貸与 — KY 8222 と別表がずれる行を見張る (2026-11-13 H 依頼)
 *
 *   npm run check:rental-limit-over              # 基準値と比べる (悪化したら exit 1)
 *   npm run check:rental-limit-over -- --update  # 基準値を書き直す (★ 悪化したまま更新しない)
 *   env MONTH=2026-06 (既定)
 *
 * なぜ: 限度を超えた人では KY 8222 (給付管理票) は ★「基準内の単位」しか持たない。別表 (第7表) のサービス単位とずれる。
 *   2026-11-13 ムツミ (氏名は DB で引く) 車いす: 別表 サービス単位 600 / 超過 70 / 基準内 530 = KY 530。利用票の行の値は 600 が正しい。
 *   → ① KY 単独 (ky8222_single_*) で入れた値は 限度を超えた人では ★ 小さく入る (実害)
 *   → ② 第7表の行の「総費用」は基準内の金額なので 単位×単価 ≠ 総費用 になる (事業所まとめの差額で負の行も出る。表示だけ)
 *
 * 数えるもの (DB の第7表 service-usage-detail と 利用票 service-usage):
 *   A. 第7表の貸与の行 (コード 17/67) で |floor(単位 × 単価) − 総費用| > 1 の行 = 限度超過の行
 *   B. 利用票の KY 単独の行 (_units_source = ky8222_single_*) を 人が限度を超えたか で分ける
 *      限度を超えた = 第7表の 限度額対象の単位の合計 (limitSubjectUnitsOfDetail) > 限度額 (第7表 or 利用票の limit_amount)
 *      第7表が無い / 限度額が無い人は「判定できない」
 *
 * 基準値方式 (0 を目指す検査ではない): A の行数 / B の「限度を超えた人の KY 単独の行」が 基準値より増えたら FAIL。
 *   B が増える = 小さく入った疑いのある値が増えた。KY 単独の行が減るのは (別表で上書きされた) 良い方向なので落とさない
 * 負のコントロール: A の 1 行の総費用を 単位×単価 に直すと A が 1 減ること / B の判定で 限度額を 0 にすると「限度を超えた」が増えること
 * ★ この検査が見ていないもの: 利用票の行の値が正しいか (check:riyouhyou-units) / 第7表が無い人 / 総合事業・障害
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { limitSubjectUnitsOfDetail } from "@/lib/usage-limit-total";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASELINE = join(HERE, "rental-limit-over-baseline.json");
const UPDATE = process.argv.includes("--update");
const MONTH = process.env.MONTH ?? "2026-06";

type Item = { service_code?: string | null; service_content?: string | null; service_units?: number | string | null; unit_price?: number | string | null; total_cost?: number | string | null; provider_name?: string | null };
type Svc = { category?: string | null; content?: string | null; _units_source?: string | null; rental_month_actual_units?: number | null; manual_units?: number | null };
type DetailDoc = { user_id: string; items: Item[] | null; limit_amount: number | string | null };
type UsageDoc = { user_id: string; services: Svc[] | null; limit_amount: number | string | null; user_name: string | null };
type Result = { rentalItems: number; overRows: number; kySingle: number; kyOver: number; kyNotOver: number; kyUnknown: number };
type Baseline = { _readme: string[]; month: string } & Result;

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

const isRentalCode = (c: unknown) => /^(17|67)/.test(String(c ?? ""));
/** 限度超過の行 = 単位 × 単価 と 総費用 が 1 円より大きくずれる貸与の行 (単価・総費用の無い行は判定しない) */
export function isOverLimitRentalItem(it: Item): boolean {
  if (!isRentalCode(it.service_code)) return false;
  const u = Number(it.service_units), p = Number(it.unit_price), c = Number(it.total_cost);
  if (!Number.isFinite(u) || !Number.isFinite(p) || !Number.isFinite(c) || !p || it.total_cost == null) return false;
  return Math.abs(Math.floor(u * p) - c) > 1;
}
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

function evaluate(details: DetailDoc[], usages: UsageDoc[]) {
  const detailBy = new Map(details.map((d) => [d.user_id, d]));
  let rentalItems = 0, overRows = 0;
  const overList: string[] = [];
  const nameOf = new Map(usages.map((u) => [u.user_id, u.user_name ?? ""]));
  for (const d of details) for (const it of d.items ?? []) {
    if (!isRentalCode(it.service_code)) continue;
    rentalItems++;
    if (isOverLimitRentalItem(it)) { overRows++; overList.push(`${nameOf.get(d.user_id) ?? d.user_id} ${it.service_content} 単位 ${it.service_units} × ${it.unit_price} / 総費用 ${it.total_cost}`); }
  }
  let kySingle = 0, kyOver = 0, kyNotOver = 0, kyUnknown = 0;
  const kyOverList: string[] = [];
  for (const u of usages) {
    const rows = (u.services ?? []).filter((s) => String(s._units_source ?? "").startsWith("ky8222_single_"));
    if (!rows.length) continue;
    kySingle += rows.length;
    const d = detailBy.get(u.user_id);
    const limit = num(d?.limit_amount) || num(u.limit_amount);
    if (!d || !(d.items ?? []).length || !limit) { kyUnknown += rows.length; continue; }
    const used = limitSubjectUnitsOfDetail(d.items ?? []);
    if (used > limit) { kyOver += rows.length; for (const s of rows) kyOverList.push(`${u.user_name} ${s.content} KY 単独 ${s.rental_month_actual_units ?? s.manual_units} (限度 ${limit} / 第7表 ${used} = 超過 ${used - limit})`); }
    else kyNotOver += rows.length;
  }
  // 2 つの判定が噛み合っているか: A の行の人は B の基準 (第7表の限度額対象の合計 > 限度額) でも「限度を超えた」になるはず
  const usageBy = new Map(usages.map((u) => [u.user_id, u]));
  const aPeople = details.filter((d) => (d.items ?? []).some(isOverLimitRentalItem));
  const aNotOver = aPeople.filter((d) => { const limit = num(d.limit_amount) || num(usageBy.get(d.user_id)?.limit_amount); return !limit || !(limitSubjectUnitsOfDetail(d.items ?? []) > limit); })
    .map((d) => `${nameOf.get(d.user_id) ?? d.user_id} (限度 ${num(d.limit_amount) || num(usageBy.get(d.user_id)?.limit_amount) || "なし"} / 第7表 ${limitSubjectUnitsOfDetail(d.items ?? [])})`);
  return { result: { rentalItems, overRows, kySingle, kyOver, kyNotOver, kyUnknown } satisfies Result, overList, kyOverList, aPeople: aPeople.length, aNotOver };
}

const get = restGet();
const details = await getAll<DetailDoc>(get, `kaigo_report_documents?select=user_id,items:content->items,limit_amount:content->limit_amount&report_type=eq.service-usage-detail&report_month=eq.${MONTH}&order=id`);
const usages = await getAll<UsageDoc>(get, `kaigo_report_documents?select=user_id,services:content->services,limit_amount:content->limit_amount,user_name:content->>user_name&report_type=eq.service-usage&report_month=eq.${MONTH}&order=id`);
const { result: cur, overList, kyOverList, aPeople, aNotOver } = evaluate(details, usages);

console.log(`母数: ${MONTH} の第7表 ${details.length} 件 (貸与の行 ${cur.rentalItems}) / 利用票 ${usages.length} 件`);
console.log(`A. 限度超過の貸与の行 (単位×単価 ≠ 総費用) ${cur.overRows} 行`);
for (const l of overList.slice(0, 30)) console.log(`    ${l}`);
console.log(`B. KY 単独の行 ${cur.kySingle} = 限度を超えた人 ${cur.kyOver} / 超えていない ${cur.kyNotOver} / 判定できない (第7表か限度額が無い) ${cur.kyUnknown}`);
for (const l of kyOverList) console.log(`    ★ ${l}`);
console.log(`A と B の判定の噛み合い: A の行がある人 ${aPeople} 名のうち B の基準でも限度を超えた ${aPeople - aNotOver.length} 名${aNotOver.length ? ` / 超えていない判定 ${aNotOver.length} 名 (↓ B の基準が甘い疑い)` : ""}`);
for (const l of aNotOver) console.log(`    ⚠ ${l}`);

// ── 負のコントロール ──
let negOk = true;
{
  const victim = details.find((d) => (d.items ?? []).some(isOverLimitRentalItem));
  if (victim) {
    const items = (victim.items ?? []).map((it) => ({ ...it }));
    const i = items.findIndex(isOverLimitRentalItem);
    items[i].total_cost = Math.floor(Number(items[i].service_units) * Number(items[i].unit_price));
    const n = evaluate(details.map((d) => (d === victim ? { ...d, items } : d)), usages).result.overRows;
    const ok1 = n === cur.overRows - 1;
    const zeroLimit = evaluate(details.map((d) => ({ ...d, limit_amount: 1 })), usages.map((u) => ({ ...u, limit_amount: 1 }))).result.kyOver;
    const ok2 = cur.kyNotOver === 0 || zeroLimit > cur.kyOver;
    negOk = ok1 && ok2;
    console.log(`\n■ 負のコントロール: 超過の行を 1 行ふつうに見せる → A ${cur.overRows} → ${n} ${ok1 ? "✓" : "✗ 減らない"} / 限度額を 1 にする → 限度を超えた人の KY 単独 ${cur.kyOver} → ${zeroLimit} ${ok2 ? "✓" : "✗ 増えない"}`);
  } else {
    console.log("\n■ 負のコントロール: 限度超過の行が 1 行も無いので A は実施できない (B だけ)");
  }
}
console.log("★ この検査が見ていないもの: 利用票の行の値が正しいか (check:riyouhyou-units) / 第7表が無い人 (判定できない に入る) / 総合事業・障害");

if (UPDATE) {
  const readme = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline)._readme : [
    "基準値方式。A (限度超過の貸与の行) / B (限度を超えた人の KY 単独の行) が増えたら落ちる。0 を目指す検査ではない。",
    "A は表示だけの問題 (第7表の行ごとの総費用。請求の割り振りは GendoAllocationPanel)。直すなら over_limit_units と一緒に関係を先に決める (H 判断: 今は直さない)",
    "B は実害: KY 8222 は基準内の単位しか持たないので、限度を超えた人に KY 単独で入れた値は小さい。直すか残すかを B の行ごとに決める",
  ];
  writeFileSync(BASELINE, JSON.stringify({ _readme: readme, month: MONTH, ...cur } satisfies Baseline, null, 2) + "\n");
  console.log(`\n基準値を書き直した: ${BASELINE}`);
  process.exit(negOk ? 0 : 1);
}
if (!existsSync(BASELINE)) { console.error("\n✗ 基準値ファイルが無い。--update で作る"); process.exit(1); }
const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
const fails: string[] = [];
if (!negOk) fails.push("負のコントロールが鳴らない");
if (cur.overRows > base.overRows) fails.push(`A. 限度超過の貸与の行 ${base.overRows} → ${cur.overRows} (増えた)`);
if (cur.kyOver > base.kyOver) fails.push(`B. 限度を超えた人の KY 単独の行 ${base.kyOver} → ${cur.kyOver} (増えた = 小さく入った疑いのある値が増えた)`);
console.log(`\n基準値: A ${base.overRows} / B 限度を超えた人の KY 単独 ${base.kyOver} (KY 単独 ${base.kySingle})`);
if (cur.overRows < base.overRows || cur.kyOver < base.kyOver) console.log("  ○ 減った。--update で締めてよい");
if (fails.length) { console.log("✗ FAIL"); for (const f of fails) console.log("  " + f); process.exit(1); }
console.log("✓ PASS (基準値より悪化なし・負のコントロール確認済み)");
