/**
 * 利用票 (第6表) の単位数 × 回数 を 伝送 KY (給付管理票 8222) の 給付計画単位数 と突合する
 * (READ ONLY — DB 書込なし)。基準値方式。
 *
 *   npm run check:riyouhyou-units                # 判定 (基準値より悪化したら exit 1)
 *   npm run check:riyouhyou-units -- --update    # 基準値を更新 (悪化したまま更新しないこと)
 *   npm run check:riyouhyou-units -- --detail    # 不一致の明細を全部出す
 *   env DOCS_CACHE=<path.json>  利用票を DB でなくファイルから読む (開発用。並行セッション負荷対策)
 *
 * ── 何を確かめるか ────────────────────────────────────────────────
 * 2026-11-12 に backfill_service_usage_units.mjs が kaigo_report_documents
 * (report_type='service-usage') の content.services[].units / category を
 * kaigo_service_codes から投入した (3,216 帳票 / 28,354 行)。その値が正しいかを
 * ★ ほのぼのが実際に伝送した給付管理票 (KY/8222) という独立した材料で確かめる。
 *
 * ── 突合の定義 ────────────────────────────────────────────────────
 *   キー     (提供年月, 保険者番号, 被保険者番号, サービス種類コード)
 *            保険者番号は 8 桁ゼロ埋めにそろえる (KY=00122069 / 利用票=122069)
 *            保険者・被保番は 利用票 content.insurer_number / insured_number
 *            (ほのぼのの利用票から取り込んだ値。当方の認定テーブルを経由しない)
 *   当方     Σ rowMonthlyUnitsOf(units, 回数, unit_type) (サービス種類ごと。画面・印刷と同じ式。
 *            unit_type が「1月につき」「月1回限度」なら 1 回分)。★ 区分支給限度基準額の対象外の加算は足さない
 *            (サービス提供体制強化 / 総合マネジメント体制強化 / 緊急時訪問看護 / 特別管理 / ターミナル。
 *             下の OUTSIDE_LIMIT。給付管理票の計画単位数は限度額の内側だけなので)
 *            回数 = planned_counts の合計。無ければ planned[] の true 数
 *   正       KY 8222 明細行 (合計行 99 を除く) の c[21] 給付計画単位数を種類ごとに合計
 *            (同じ種類で事業所が複数あれば足す)
 *
 * ── 分母 (★ 母数の定義) ──────────────────────────────────────────
 *   「利用票がある」かつ「同じ (年月, 保険者, 被保番) の票が KY にある」利用者の、
 *   どちらか片側にでも現れるサービス種類。ただし下の別掲キーは分母から外す。
 *
 * ── 別掲 (★ 合否に混ぜない) ────────────────────────────────────────
 *   貸与         種類 17 / 67 (福祉用具貸与)。単位は商品ごとの実額で manual_units に入るが
 *                未投入がほとんど。0 一致を FAIL にしない
 *   同一建物減算  名前に「同一建物減算」を含む行がある種類 (率の減算で units=0 のため)
 *   マスタ無し    units が null の行がある種類 (名前がマスタに無い自由記述)
 *   限度額対象外の種類  31 居宅療養管理指導 (KY に出ない)
 *   KY 無し       その (年月, 保険者, 被保番) の票が KY に無い利用票 (2026-08 分など
 *                 KY をまだ受け取っていない月を含む)
 *   被保番なし    content に保険者番号/被保番が無い利用票
 *   利用票なし    KY にあるが利用票が無い票 (逆方向。件数だけ)
 *
 * ── 不一致の型 ────────────────────────────────────────────────────
 *   実績回数で一致  planned でなく actual の回数で数えると一致する
 *   月1回の加算を回数分数えている  科学的介護推進体制 / 個別機能訓練Ⅱ / 生産性向上推進体制 / ADL維持等
 *                 の回数を 1 に丸めると一致 (★ 利用票画面の単位計も同じだけ過大になる)
 *   実績回数+月1回の加算で一致  上の 2 つを両方当てると一致
 *   30日超の日を除けば一致  短期入所の「30日超…」行 (算定不可の日) を引くと一致
 *   限度額で頭打ち  当方の全種類合計が content.limit_amount を超え、KY 側の票合計は限度内
 *   片側のみ        種類が片方にしか無い
 *   当方>KY / 当方<KY  上のどれでもない
 *
 * ── 負のコントロール ──────────────────────────────────────────────
 *   一致したキーの行の units を 1 だけずらしたコピーで再計算し、一致数が減ることを
 *   確かめてから合否を出す。鳴らなければ検査自体が効いていないので exit 1。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { findKyFiles, readKy8222Lines } from "./_ky-parse.mjs";
import { resolveByBetsuhyouHeader } from "../migrations/_client_resolve.mjs";
import { normName } from "../migrations/_name_normalize.mjs";
import { selectBundlePersons, applyKohiToItems } from "../migrations/_parse_careplan_bundle_pdf.mjs";
import { usageLimitUnits } from "@/lib/usage-limit-total";
import { rowMonthlyUnitsOf, isMonthlyUnitType, dedupeMonthlyCounts, riyouhyouRowKey, markedCountOf, dayCountOf } from "@/lib/riyouhyou-row-units";
import { rentalMonthlyUnits, type RentalRowLike } from "@/lib/rental-units";
import { recordMonthActualUnits, splitInsuranceRecords, type EquipmentRecordLike } from "@/lib/equipment-record-units";
import { planEquipmentImport, EQUIPMENT_IMPORT_SOURCE, type MergeRow, type MergePlan, type ImportChoice } from "@/lib/equipment-import-merge";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASELINE = join(HERE, "riyouhyou-units-baseline.json");
const UPDATE = process.argv.includes("--update");
// ★ CHECK_MONTH=2026-07 で その月だけを読み、基準値と比べずに結果だけ出す (2026-11-14 H 依頼: 2 か月目の一致率を 1 か月目と比べる)
const CHECK_MONTH = process.env.CHECK_MONTH ?? "";
if (CHECK_MONTH && !/^\d{4}-\d{2}$/.test(CHECK_MONTH)) { console.error("CHECK_MONTH は YYYY-MM"); process.exit(1); }
if (CHECK_MONTH && UPDATE) { console.error("CHECK_MONTH と --update は同時に使わない (基準値を 1 か月ぶんで上書きしてしまう)"); process.exit(1); }
const DETAIL = process.argv.includes("--detail");

type Svc = {
  content?: string; units?: number | null; category?: string | null; manual_units?: number | null; unit_type?: string | null;
  planned?: boolean[]; actual?: boolean[]; planned_counts?: number[]; actual_counts?: number[];
};
type Doc = {
  id: string; user_id: string; report_month: string;
  content: { services?: Svc[]; insurer_number?: string; insured_number?: string; user_name?: string; limit_amount?: number | string | null; equipment_records?: unknown[] } | null;
};

// ── 1. 利用票 ───────────────────────────────────────────────────
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
async function loadDocs(): Promise<Doc[]> {
  if (process.env.DOCS_CACHE) return (JSON.parse(readFileSync(process.env.DOCS_CACHE, "utf8")) as Doc[]).filter((d) => !CHECK_MONTH || d.report_month === CHECK_MONTH);
  const get = restGet();
  const out: Doc[] = [];
  for (let off = 0; ; off += 1000) {
    const d = await get(`kaigo_report_documents?select=id,user_id,report_month,content&report_type=eq.service-usage${CHECK_MONTH ? `&report_month=eq.${CHECK_MONTH}` : ""}&order=id.asc&limit=1000&offset=${off}`) as Doc[];
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}

// ── 1b. unit_type (行に unit_type が無いときだけ使う。名前 × 対象月に有効な世代で引く) ──
type CodeRow = { service_name: string; unit_type: string | null; valid_from: string; valid_until: string | null; system: string };
async function loadUnitTypes(docs: Doc[]): Promise<CodeRow[]> {
  if (process.env.CODES_CACHE) return JSON.parse(readFileSync(process.env.CODES_CACHE, "utf8")) as CodeRow[];
  const names = [...new Set(docs.flatMap((d) => (d.content?.services ?? []).map((s) => s.content).filter((n): n is string => !!n)))];
  const get = restGet();
  const out: CodeRow[] = [];
  // ⚠ 1 回に引く名前が多いと応答ヘッダが溢れて fetch が落ちる (100 件で実際に失敗)。25 件ずつ
  for (let i = 0; i < names.length; i += 25) {
    const list = names.slice(i, i + 25).map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
    out.push(...await get(`kaigo_service_codes?select=service_name,unit_type,valid_from,valid_until,system&system=in.(${encodeURIComponent("介護,総合事業")})&service_name=in.(${encodeURIComponent(list)})`) as CodeRow[]);
  }
  return out;
}
let codeRows: CodeRow[] = [];
const unitTypeCache = new Map<string, string | null>();
/** 行の unit_type。行に持っていればそれ、無ければマスタ (対象月に有効な世代)。世代で値が割れたら null (従来の数え方) */
function unitTypeOf(s: Svc, reportMonth: string): string | null {
  if (s.unit_type != null) return s.unit_type;
  const name = s.content ?? "";
  const ck = `${name}|${reportMonth}`;
  if (unitTypeCache.has(ck)) return unitTypeCache.get(ck)!;
  const first = `${reportMonth}-01`;
  const hits = codeRows.filter((c) => c.service_name === name && (c.system === "介護" || c.system === "総合事業") && c.valid_from <= first && (!c.valid_until || c.valid_until >= first));
  const types = new Set(hits.map((c) => c.unit_type));
  const v = types.size === 1 ? [...types][0] : null;
  unitTypeCache.set(ck, v);
  return v;
}

const RENTAL = new Set(["17", "67"]);
// 区分支給限度基準額の対象外 (給付管理票の計画単位数に入らない)。2026-11-12 に実データで決めた:
//   外すと一致が増えるもの  サービス提供体制強化加算 / 総合マネジメント体制強化加算 /
//                           緊急時訪問看護加算 / 特別管理加算 / ターミナルケア加算
//   ★ 「通所リハ提供体制加算」(リハビリテーション提供体制加算) は限度額の内側。
//     「提供体制」で引くとこれまで外れて通所リハが 310 → 112 一致に落ちる。「サービス提供体制」で引くこと
//   ★ 訪問看護体制強化加算 も内側 (外すと訪問看護が 501 → 426 一致に落ちる)
const OUTSIDE_LIMIT = /サービス提供体制|総合マネジメント|緊急時|特別管理|ターミナル/;
// 居宅療養管理指導 (31) は種類ごと限度額の対象外で、KY に 1 行も出ない
const OUTSIDE_LIMIT_KINDS = new Set(["31"]);
// 短期入所の連続 30 日超の日 (算定不可・自費)。KY には入らない
const OVER30 = /^(30|３０)日超/;
// 月 1 回算定の加算 (単位数は「1 月につき」)。利用票では日ごとに印が付いて回数が 2 以上になっていることがある。
// 2026-11-12 実測: 回数を 1 に丸めると KY と一致する例が多数 (科学的介護 40×3 → 40 など)
const MONTHLY = /科学的介護推進体制|個別機能訓練加算Ⅱ|生産性向上推進体制|ＡＤＬ維持等|ADL維持等/;
// KY の保険者番号は 8 桁ゼロ埋め (00122069)、利用票は 6 桁 (122069)。両側を 8 桁にそろえる
const normInsurer = (v: unknown) => { const t = String(v ?? "").trim(); return t ? t.padStart(8, "0") : ""; };
const sum = (a: number[]) => a.reduce((s, x) => s + (Number(x) || 0), 0);
const plannedCount = (s: Svc) =>
  Array.isArray(s.planned_counts) ? sum(s.planned_counts) : (s.planned ?? []).filter(Boolean).length;
const actualCount = (s: Svc) =>
  Array.isArray(s.actual_counts) ? sum(s.actual_counts) : (s.actual ?? []).filter(Boolean).length;

type OurKind = { planned: number; actual: number; over30: number; over30Actual: number; plannedMonthly1: number; actualMonthly1: number; aside: string | null; rows: number; nullUnits: number };
type OurDoc = { doc: Doc; ym: string; insurer: string; insured: string; kinds: Map<string, OurKind>; limit: number | null };

/**
 * @param capMonthly true = unit_type が「1月につき」等なら回数を月 1 回に (画面と同じ rowMonthlyUnitsOf)。
 *                   false = 従来の units × 回数 (負のコントロール用。2026-11-12 初版の基準値と同じ値になるはず)
 * @param dedupe     true = 月 1 回のコードが同じ (事業所, サービス) で複数行なら 2 行目以降を数えない
 *                   (画面・印刷の合計と同じ dedupeMonthlyCounts)。既定は capMonthly と同じ
 */
function buildOurs(docs: Doc[], unitShift?: (s: Svc) => number, capMonthly = true, dedupe = capMonthly): OurDoc[] {
  const out: OurDoc[] = [];
  for (const d of docs) {
    const c = d.content ?? {};
    const kinds = new Map<string, OurKind>();
    const svcs = c.services ?? [];
    const utRow = (s: Svc) => (capMonthly ? unitTypeOf(s, d.report_month) : null);
    const pEff = dedupe ? dedupeMonthlyCounts(svcs, riyouhyouRowKey, plannedCount, utRow) : svcs.map(plannedCount);
    const aEff = dedupe ? dedupeMonthlyCounts(svcs, riyouhyouRowKey, actualCount, utRow) : svcs.map(actualCount);
    for (const [i, s] of svcs.entries()) {
      const kind = (s.category ?? "").trim() || "(種類不明)";
      const k = kinds.get(kind) ?? { planned: 0, actual: 0, over30: 0, over30Actual: 0, plannedMonthly1: 0, actualMonthly1: 0, aside: null, rows: 0, nullUnits: 0 };
      k.rows++;
      kinds.set(kind, k);
      if (OUTSIDE_LIMIT.test(s.content ?? "")) continue; // 限度額対象外の加算は計画単位数に入らない
      if (s.units == null) k.nullUnits++;
      if (RENTAL.has(kind)) k.aside = "貸与";
      else if (OUTSIDE_LIMIT_KINDS.has(kind)) k.aside = "限度額対象外の種類";
      else if ((s.content ?? "").includes("同一建物減算")) k.aside ??= "同一建物減算";
      else if (s.units == null) k.aside ??= "マスタ無し";
      const u = (s.units ?? 0) + (unitShift ? unitShift(s) : 0);
      // ★ 画面・印刷と同じ式 (src/lib/riyouhyou-row-units.ts)。回数の取り方だけ違う:
      //   画面は印の数 (boolean)、ここは planned_counts の合計 (1 日 2 回を 2 と数える。KY と同じ)
      const ut = utRow(s);
      k.planned += rowMonthlyUnitsOf(u, pEff[i], ut);
      k.actual += rowMonthlyUnitsOf(u, aEff[i], ut);
      if (OVER30.test(s.content ?? "")) k.over30 += rowMonthlyUnitsOf(u, pEff[i], ut);
      if (OVER30.test(s.content ?? "")) k.over30Actual += rowMonthlyUnitsOf(u, aEff[i], ut);
      // 型の分類用。名前で月 1 回とみなす初版の規則に unit_type を足す
      // (capMonthly=false の負のコントロールでは ut=null なので初版の分類そのまま)
      const m1 = MONTHLY.test(s.content ?? "") || isMonthlyUnitType(ut);
      k.plannedMonthly1 += u * (m1 ? Math.min(1, plannedCount(s)) : plannedCount(s));
      k.actualMonthly1 += u * (m1 ? Math.min(1, actualCount(s)) : actualCount(s));
    }
    const lim = Number(c.limit_amount);
    out.push({
      doc: d, ym: (d.report_month ?? "").replace("-", ""),
      insurer: normInsurer(c.insurer_number), insured: String(c.insured_number ?? "").trim(),
      kinds, limit: Number.isFinite(lim) && lim > 0 ? lim : null,
    });
  }
  return out;
}

// ── 2. KY ───────────────────────────────────────────────────────
type KyTicket = { area: string; files: Set<string>; kinds: Map<string, number> };
function loadKy(): Map<string, KyTicket> {
  const base = join(ROOT, "伝送データ");
  const tickets = new Map<string, KyTicket>();
  const areas = existsSync(base) ? findKyFiles(base).filter((p) => /[\\/]居宅[\\/]/.test(p)) : [];
  for (const p of areas) {
    const area = p.slice(base.length + 1).split(/[\\/]/)[0];
    for (const l of readKy8222Lines(p)) {
      const key = `${l.ym}|${normInsurer(l.insurer)}|${l.insured}`;
      // 同じ票が複数バッチにある (再請求) ときは後のファイルで丸ごと差し替える
      let t = tickets.get(key);
      if (t && !t.files.has(p)) { t = undefined; }
      if (!t) { t = { area, files: new Set([p]), kinds: new Map() }; tickets.set(key, t); }
      t.kinds.set(l.serviceKind, (t.kinds.get(l.serviceKind) ?? 0) + l.plannedUnits);
    }
  }
  return tickets;
}

// ── 3. 突合 ─────────────────────────────────────────────────────
type Result = {
  denomTickets: number; denomKeys: number; match: number;
  mismatches: { key: string; area: string; name: string; kind: string; ours: number; ky: number; type: string }[];
  aside: Record<string, number>; asideKeysByReason: Record<string, number>;
  byArea: Map<string, { keys: number; match: number }>;
  noKyByMonth: Record<string, number>; kyOnlyTickets: number;
  /** キーごとの結果 ("一致" または不一致の型)。月 1 回の扱いの有無で比べるのに使う */
  status: Map<string, string>;
};

// ★ 基準値の対象の月 (2026-11-13)。基準値の合計は月を分けていないので、新しい月の利用票が入ると
//   それだけで不一致が増えて FAIL する。基準値に無い月は別掲にして件数だけ出し、中身を確かめてから --update で取り込む
const baselineMonths: Set<string> | null = (() => {
  if (UPDATE || CHECK_MONTH || !existsSync(BASELINE)) return null;
  const m = (JSON.parse(readFileSync(BASELINE, "utf8")) as { months?: string[] }).months;
  return m ? new Set(m) : null;
})();

function compare(ours: OurDoc[], ky: Map<string, KyTicket>): Result {
  const r: Result = { denomTickets: 0, denomKeys: 0, match: 0, mismatches: [], aside: {}, asideKeysByReason: {}, byArea: new Map(), noKyByMonth: {}, kyOnlyTickets: 0, status: new Map() };
  const bump = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
  const seen = new Set<string>();
  if (baselineMonths) ours = ours.filter((o) => {
    if (baselineMonths.has(o.doc.report_month)) return true;
    bump(r.aside, "基準値に無い月 (--update で取り込む)");
    return false;
  });
  for (const o of ours) {
    if (!o.insurer || !o.insured) { bump(r.aside, "被保番なし(利用票)"); continue; }
    const tk = `${o.ym}|${o.insurer}|${o.insured}`;
    const t = ky.get(tk);
    if (!t) { bump(r.aside, "KY無し(利用票)"); bump(r.noKyByMonth, o.doc.report_month); continue; }
    if (seen.has(tk)) { bump(r.aside, "同じ票に利用票が2件"); continue; }
    seen.add(tk);
    r.denomTickets++;
    const area = r.byArea.get(t.area) ?? { keys: 0, match: 0 };
    r.byArea.set(t.area, area);
    const ourTotal = [...o.kinds.values()].reduce((s, k) => s + k.planned, 0);
    const kyTotal = [...t.kinds.values()].reduce((s, v) => s + v, 0);
    for (const kind of new Set([...o.kinds.keys(), ...t.kinds.keys()])) {
      const ok = o.kinds.get(kind), kv = t.kinds.get(kind);
      const asideReason = RENTAL.has(kind) ? "貸与" : OUTSIDE_LIMIT_KINDS.has(kind) ? "限度額対象外の種類"
        : ok?.aside ?? (kind === "(種類不明)" ? "マスタ無し" : null);
      if (asideReason) { bump(r.asideKeysByReason, asideReason); continue; }
      r.denomKeys++; area.keys++;
      const ourV = ok?.planned ?? 0, kyV = kv ?? 0;
      // 利用票に行はあるが計画回数が 0 で KY に欄が無い = 0 同士なので一致
      if (ok && (kv != null ? ourV === kyV : ourV === 0)) { r.match++; area.match++; r.status.set(`${tk}|${kind}`, "一致"); continue; }
      let type: string;
      if (ok && kv == null && ok.actual === 0) type = "実績0回でKYに欄が無い";
      else if (!ok || kv == null) type = !ok ? "片側のみ(KYだけ)" : "片側のみ(利用票だけ)";
      else if (ok.actual === kyV) type = "実績回数で一致";
      else if (ok.over30 > 0 && ourV - ok.over30 === kyV) type = "30日超の日を除けば一致";
      else if (ok.over30Actual > 0 && ok.actual - ok.over30Actual === kyV) type = "実績回数+30日超を除けば一致";
      else if (ok.plannedMonthly1 !== ourV && ok.plannedMonthly1 === kyV) type = "月1回の加算を回数分数えている";
      else if (ok.actualMonthly1 === kyV) type = "実績回数+月1回の加算で一致";
      else if (o.limit != null && ourTotal > o.limit && kyTotal <= o.limit && ourV > kyV) type = "限度額で頭打ち";
      else type = ourV > kyV ? "当方>KY" : "当方<KY";
      r.status.set(`${tk}|${kind}`, type);
      r.mismatches.push({ key: `${tk}|${kind}`, area: t.area, name: o.doc.content?.user_name ?? "", kind, ours: ourV, ky: kyV, type });
    }
  }
  const docKeys = new Set(ours.map((o) => `${o.ym}|${o.insurer}|${o.insured}`));
  const docMonths = new Set(ours.map((o) => o.ym));
  for (const k of ky.keys()) if (docMonths.has(k.split("|")[0]) && !docKeys.has(k)) r.kyOnlyTickets++;
  return r;
}

// ── main ────────────────────────────────────────────────────────
// 0) 画面・印刷と共有の式 rowMonthlyUnitsOf の境界 (DB 不要)。
//   ★ unit_type 未設定 (null/undefined) は従来どおり units × 回数。既存帳票は unit_type を持たないので、
//     ここが月 1 回側に倒れると印刷が一斉に過少になる (2026-11-12 H 指摘)
{
  const cases: [number | null | undefined, number, string | null | undefined, number, string][] = [
    [40, 3, null, 120, "unit_type=null は従来どおり"],
    [40, 3, undefined, 120, "unit_type=undefined は従来どおり"],
    [40, 3, "1回につき", 120, "1回につき"],
    [40, 3, "1月につき", 40, "1月につき は 1 回"],
    [40, 3, "月1回限度", 40, "月1回限度 は 1 回"],
    [40, 0, "1月につき", 0, "印 0 なら 0"],
    [-600, 30, "1月につき", -600, "定期巡回の同一建物減算 (負) も 1 回"],
    [-600, 30, null, -18000, "負の units でも null は従来どおり"],
    [null, 3, "1月につき", 0, "units 未設定は 0"],
    [270, 2, " 1月につき ", 270, "前後の空白"],
  ];
  const bad = cases.filter(([u, n, t, want]) => rowMonthlyUnitsOf(u, n, t) !== want);
  for (const [u, n, t, want, label] of bad) console.error(`✗ rowMonthlyUnitsOf(${u}, ${n}, ${JSON.stringify(t)}) = ${rowMonthlyUnitsOf(u, n, t)} / 期待 ${want} (${label})`);
  if (bad.length) { console.error("✗ FAIL: 共有の式 rowMonthlyUnitsOf の境界が崩れている"); process.exit(1); }
  console.log(`共有の式 rowMonthlyUnitsOf: 境界 ${cases.length} 件 OK (unit_type 未設定は従来どおり units × 回数)`);
  // 画面・印刷の回数 dayCountOf / markedCountOf (2026-11-13: 以前は印の日数で、訪看・訪問リハの 1 日 2〜3 回を 1 回と数えていた)
  {
    const T = true, F = false;
    type CC = [boolean[], (number | null)[] | null, number, string];
    const cc: CC[] = [
      [[T, T, T], [3, 3, 3], 9, "訪問リハ 1 日 3 回 × 3 日"],
      [[T, F, T], [2, 2, 2], 4, "印の無い日は 回数配列に値があっても 0 (印を外した日)"],
      [[T, T], null, 2, "回数配列が無い行は 1 日 1 回"],
      [[T, T], [0, 2], 3, "その日の値が 0 なら 1 (印を新しく付けた日)"],
      [[T, T], [null, 2], 3, "その日の値が null なら 1"],
      [[T, T, T, T, T, T, T, T, T], [2, 2, 2, 2, 2, 2, 2, 2, 2], 18, "送迎減算 片道 = 1 日 2 回 × 9 日"],
      [[F, F], [3, 3], 0, "印が 1 つも無ければ 0"],
    ];
    type CountFn = (m: boolean[], c: (number | null)[] | null) => number;
    const runC = (fn: CountFn) => cc.filter(([m, c, want]) => fn(m, c) !== want);
    const badC = runC(markedCountOf);
    for (const [m, c, want, label] of badC) console.error(`✗ markedCountOf(${JSON.stringify(m)}, ${JSON.stringify(c)}) = ${markedCountOf(m, c)} / 期待 ${want} (${label})`);
    const dOk = dayCountOf([T, F], [3, 3], 0) === 3 && dayCountOf([T, F], [3, 3], 1) === 0 && dayCountOf(undefined, undefined, 0) === 0;
    if (badC.length || !dOk) { console.error("✗ FAIL: 画面・印刷の回数 markedCountOf / dayCountOf の境界が崩れている"); process.exit(1); }
    // 負のコントロール: 直す前の実装 (印の日数) / 回数配列を印と無関係に足す
    const negMarks: CountFn = (m) => m.filter(Boolean).length;
    const negSumAll: CountFn = (m, c) => (c ? c.reduce<number>((t, x) => t + Number(x ?? 0), 0) : m.filter(Boolean).length);
    const nM = runC(negMarks).length, nS = runC(negSumAll).length;
    if (!nM || !nS) { console.error(`✗ FAIL: 負のコントロールが鳴らない (印の日数 ${nM} / 配列を全部足す ${nS})`); process.exit(1); }
    console.log(`画面・印刷の回数 markedCountOf: 境界 ${cc.length} 件 OK / 負のコントロール 印の日数で数える→${nM}・配列を印と無関係に足す→${nS} 件 落ちる ✓`);
  }
  // 利用票画面の区分支給限度の判定 usageLimitUnits (案 A・2026-11-13): 第7表があれば第7表の限度額対象の合計、無ければ利用票の行
  {
    type LC = [number, { service_content: string; service_units: number }[] | null, number, string, string];
    const it = (c: string, u: number) => ({ service_content: c, service_units: u });
    const lc: LC[] = [
      [5000, null, 5000, "services", "第7表が無い → 利用票の行"],
      [5000, [], 5000, "services", "第7表が空 → 利用票の行"],
      [5000, [it("手すり貸与", 1150), it("身体介護１", 4880)], 6030, "service-usage-detail", "第7表がある → 第7表の合計 (まとめ行の貸与も入る)"],
      [5000, [it("身体介護１", 4880), it("訪問介護処遇改善加算Ⅱ２", 1328)], 4880, "service-usage-detail", "処遇改善は対象外"],
      [5000, [it("身体介護１", 9549), it("訪問介護同一建物減算１", -955)], 9549, "service-usage-detail", "同一建物減算は対象外 (KY 4/4)"],
      [5000, [it("通所介護送迎減算", -846), it("通所介護Ⅰ１１", 5106)], 4260, "service-usage-detail", "送迎減算は対象 (KY と一致)"],
      [5000, [it("居宅療養小規模事業所加算", 26), it("緊急時訪問看護加算Ⅱ１", 574), it("訪看Ⅰ３", 823)], 823, "service-usage-detail", "居宅療養・緊急時訪問看護は対象外"],
      [5000, [it("通所リハ提供体制加算４", 336), it("通所リハサービス提供体制加算Ⅰ", 308), it("通所リハⅢ２６３", 981)], 1317, "service-usage-detail", "★ 通所リハ提供体制加算は対象 / サービス提供体制は対象外 ((氏名は DB で引く)・KY)"],
    ];
    type LF = (u: number, d: { service_content: string; service_units: number }[] | null) => { units: number; source: string };
    const runL = (fn: LF) => lc.filter(([u, d, want, src]) => { const r = fn(u, d); return r.units !== want || r.source !== src; });
    const badL = runL(usageLimitUnits);
    for (const [u, d, want, src, label] of badL) { const r = usageLimitUnits(u, d); console.error(`✗ usageLimitUnits = ${r.units}/${r.source} / 期待 ${want}/${src} (${label})`); }
    if (badL.length) { console.error("✗ FAIL: 利用票画面の限度額の判定 usageLimitUnits の境界が崩れている"); process.exit(1); }
    // 負のコントロール: 第7表を見ない (従来) / 対象外を除かない
    const negIgnore: LF = (u) => ({ units: u, source: "services" });
    const negNoExempt: LF = (u, d) => (d && d.length ? { units: d.reduce((t, x) => t + x.service_units, 0), source: "service-usage-detail" } : { units: u, source: "services" });
    const nI = runL(negIgnore).length, nE = runL(negNoExempt).length;
    if (!nI || !nE) { console.error(`✗ FAIL: 負のコントロールが鳴らない (第7表を見ない ${nI} / 対象外を除かない ${nE})`); process.exit(1); }
    console.log(`利用票画面の限度額の判定 usageLimitUnits: 境界 ${lc.length} 件 OK / 負のコントロール 第7表を見ない→${nI}・対象外を除かない→${nE} 件 落ちる ✓`);
  }
  // 別表の公費欄を明細に当てる applyKohiToItems — 名前で決まらないときの金額当て (2026-11-13 ケイティサービス 8 名)
  //   公費額 + 本人負担 = その事業所 (番号 + 種類 2 桁) の Σ(総費用 − 保険請求)。1 つに決まるときだけ当てる
  {
    const it = (no: string, name: string, code: string, cost: number, ins: number) => ({ provider_number: no, provider_name: name, service_code: code, total_cost: cost, insurance_claim: ins, user_copay: cost - ins });
    const kohi = (prefix: string, claim: number) => ({ rows: [{ providerNamePrefix: prefix, kohiClaim: claim, honninFutan: 0 }], total: { kohiClaim: claim } });
    // 老健の 1 名 型: 老健の デイケア (16) と ショート (22) が同じ番号。名前は「…ﾃﾞｲｹ」と「…ﾃﾞ」で当たらない
    const kito = () => [it("1", "*KTやわた", "111411", 30000, 27000), it("2", "*辰巳ﾅｰｼﾝｸﾞ･ｳﾞｨﾗﾃﾞ", "161111", 50000, 39735), it("2", "*介護老人保健施設辰巳ｼｮｰﾄ", "221111", 40000, 28938)];
    type KC = [string, ReturnType<typeof kito>, ReturnType<typeof kohi>, number, string];
    const kc: KC[] = [
      ["種類で分けると 1 つに決まる → 当てる", kito(), kohi("*辰巳ﾅｰｼﾝｸﾞ･ｳﾞｨﾗﾃﾞｲｹ", 10265), 0, "161111"],
      ["名前が全く違う (ちはら台訪介) でも金額で 1 つ → 当てる", [it("3", "(介)ケイ・ティ・グループヘルパーステーションHana", "111111", 49000, 44100), it("4", "*ドットライフ市原", "131111", 20000, 18000)], kohi("ちはら台訪介", 4900), 0, "111111"],
      ["金額が合う事業所が 2 つ → 当てない (警告)", [it("5", "A訪介", "111111", 10000, 9000), it("6", "B通所", "151111", 10000, 9000)], kohi("ちはら台訪介", 1000), 2, ""],
      ["金額が 1 円違う → 当てない (警告)", kito(), kohi("*辰巳ﾅｰｼﾝｸﾞ･ｳﾞｨﾗﾃﾞｲｹ", 10266), 2, ""],
    ];
    const bad = kc.filter(([label, items, k, wantWarn, wantCode]) => {
      const { warn, publicExpenseByProvider } = applyKohiToItems(items, k);
      const ok = warn.length === wantWarn && (wantCode ? publicExpenseByProvider.length === 1 : publicExpenseByProvider.length === 0);
      if (!ok) console.error(`✗ applyKohiToItems: ${label} / 警告 ${warn.length} (期待 ${wantWarn}) / 当てた ${publicExpenseByProvider.length}`);
      return !ok;
    });
    if (bad.length) { console.error("✗ FAIL: 公費欄の金額当ての境界が崩れている"); process.exit(1); }
    // 負のコントロール: 種類で分けずに番号だけでまとめたら 老健の 1 名の型は当たらないはず (= 種類 2 桁が効いている)
    const merged = kito().map((x) => ({ ...x, service_code: "161111" }));
    if (!applyKohiToItems(merged, kohi("*辰巳ﾅｰｼﾝｸﾞ･ｳﾞｨﾗﾃﾞｲｹ", 10265)).warn.length) { console.error("✗ FAIL: 負のコントロールが鳴らない (番号だけでまとめても当たってしまう)"); process.exit(1); }
    console.log(`公費欄の金額当て applyKohiToItems: 境界 ${kc.length} 件 OK / 負のコントロール 種類で分けない→ 当たらない ✓`);
  }
  // 帳票の合計で月 1 回コードの複数行を畳む dedupeMonthlyCounts
  type R = { provider: string; content: string; n: number; ut: string | null };
  const rows: R[] = [
    { provider: "A", content: "定期巡回", n: 30, ut: "1月につき" },
    { provider: "A", content: "定期巡回", n: 25, ut: "1月につき" },   // 同じキーの 2 行目 → 0
    { provider: "B", content: "定期巡回", n: 3, ut: "1月につき" },    // 事業所が違う → 残す
    { provider: "A", content: "身体介護１", n: 5, ut: "1回につき" },  // 月 1 回でない → そのまま
    { provider: "A", content: "身体介護１", n: 4, ut: "1回につき" },  // 同名でも月 1 回でなければ畳まない
    { provider: "C", content: "加算", n: 0, ut: "1月につき" },        // 回数 0 の行は数えない (次の行を残す)
    { provider: "C", content: "加算", n: 2, ut: "1月につき" },
    { provider: "D", content: "加算", n: 2, ut: null },               // unit_type 不明は畳まない
    { provider: "D", content: "加算", n: 2, ut: null },
  ];
  const got = dedupeMonthlyCounts(rows, riyouhyouRowKey, (r) => r.n, (r) => r.ut);
  const want = [30, 0, 3, 5, 4, 0, 2, 2, 2];
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`✗ FAIL: dedupeMonthlyCounts = ${JSON.stringify(got)} / 期待 ${JSON.stringify(want)}`); process.exit(1); }
  console.log(`dedupeMonthlyCounts: 境界 ${rows.length} 行 OK`);

  // 貸与の月計 rentalMonthlyUnits (src/lib/rental-units.ts・2026-11-13)。この突合は貸与を合否に入れていないが、
  // 画面・印刷と同じ式なのでここで境界を固定する (新しい検査は作らない方針)。
  //   manual_units = 単価 → 印で 1月/半月 按分 / rental_month_actual_units = 別表の実額 → 按分しない / 両方なら単価優先
  {
    const YM = "2026-06"; // 30 日
    const D1 = Array<boolean>(31).fill(false); D1[0] = true;          // 1 日だけ = 1月
    const H = Array<boolean>(31).fill(false); H[15] = true;           // 16 日だけ = 利用 15 日 = 半月
    type C = [Partial<RentalRowLike>, boolean[], boolean[], "planned" | "actual", number, string];
    const rc: C[] = [
      [{ manual_units: 1000 }, D1, D1, "planned", 1000, "単価のみ・1月"],
      [{ manual_units: 1000 }, H, H, "planned", 500, "単価のみ・半月は半分"],
      [{ manual_units: 1001 }, H, H, "planned", 501, "単価のみ・半月の端数は四捨五入"],
      [{ rental_month_actual_units: 550 }, D1, D1, "planned", 550, "実額のみ・1月"],
      [{ rental_month_actual_units: 550 }, H, H, "planned", 550, "★ 実額のみ・半月でも按分しない"],
      [{ rental_month_actual_units: 550 }, D1, H, "actual", 550, "★ 実額のみ・実績側が半月でも按分しない"],
      [{ manual_units: 1000, rental_month_actual_units: 550 }, D1, D1, "planned", 1000, "両方・単価優先"],
      [{ manual_units: 1000, rental_month_actual_units: 550 }, H, H, "planned", 500, "両方・単価優先で按分"],
      [{}, D1, D1, "planned", 0, "どちらも無し"],
      [{ manual_units: 0, rental_month_actual_units: 550 }, D1, D1, "planned", 550, "単価 0 は無し扱い"],
      [{ manual_units: null, rental_month_actual_units: 0 }, D1, D1, "planned", 0, "実額 0 は無し扱い"],
      [{ manual_units: 1000 }, D1, H, "planned", 1000, "単価・予定 1月 / 実績 半月 の予定側"],
      [{ manual_units: 1000 }, D1, H, "actual", 500, "単価・予定 1月 / 実績 半月 の実績側"],
    ];
    const run = (fn: (r: RentalRowLike, ym: string, k: "planned" | "actual") => number) =>
      rc.filter(([row, p, a, k, want]) => fn({ ...row, planned: p, actual: a }, YM, k) !== want);
    const bad = run(rentalMonthlyUnits);
    for (const [row, , , k, want, label] of bad) console.error(`✗ rentalMonthlyUnits(${JSON.stringify(row)}, ${k}) 期待 ${want} (${label})`);
    if (bad.length) { console.error("✗ FAIL: 貸与の月計 rentalMonthlyUnits の境界が崩れている"); process.exit(1); }
    // 負のコントロール: 実額を見る分岐を壊す 2 通り。どちらも境界で鳴らなければ、この境界は効いていない
    const brokenIgnore = run((r, ym, k) => rentalMonthlyUnits({ ...r, rental_month_actual_units: null }, ym, k));
    const brokenProrate = run((r, ym, k) => rentalMonthlyUnits({ ...r, manual_units: Number(r.manual_units) > 0 ? r.manual_units : r.rental_month_actual_units, rental_month_actual_units: null }, ym, k));
    if (!brokenIgnore.length || !brokenProrate.length) { console.error(`✗ FAIL: 負のコントロールが鳴らない (実額を無視 ${brokenIgnore.length} / 実額を按分 ${brokenProrate.length})`); process.exit(1); }
    console.log(`rentalMonthlyUnits: 境界 ${rc.length} 件 OK / 負のコントロール 実額を無視→${brokenIgnore.length} 件・実額を按分→${brokenProrate.length} 件 落ちる ✓`);
  }

  // 用具の実績取込 (order-app → ImportEquipmentRecordModal) の単位 (src/lib/equipment-record-units.ts・2026-11-13)。
  // ★ 本番の取込は 0 件 = 実データ未投入のため境界テストのみ (合格とは言わない)
  {
    const YM = "2026-06"; // 30 日
    const R = (o: Partial<EquipmentRecordLike>): EquipmentRecordLike => ({ date_range_start: "2026-06-01", date_range_end: "2026-06-30", monthly_rental_fee: 10000, ...o });
    const uc: [EquipmentRecordLike, number, string][] = [
      [R({}), 1000, "円 ÷10・まるごと 1 か月"],
      [R({ quantity: 2 }), 2000, "数量 2"],
      [R({ quantity: null }), 1000, "数量 null は 1"],
      [R({ quantity: 0 }), 1000, "数量 0 は 1"],
      [R({ date_range_start: "2026-05-20", date_range_end: "2026-07-10" }), 1000, "月をまたぐ (前後とも外) は満額"],
      [R({ date_range_start: "2026-06-16" }), 500, "月途中開始 (後半だけ) は半額"],
      [R({ date_range_start: "2026-06-15" }), 1000, "15 日開始は前半にかかるので満額"],
      [R({ date_range_end: "2026-06-15" }), 500, "月途中終了 (前半だけ) は半額"],
      [R({ date_range_start: "2026-06-05", date_range_end: "2026-06-25" }), 1000, "月の中だけでも両方の半月なら満額 (order-app と同じ。画面の 16 日ルールとは違う)"],
      [R({ monthly_rental_fee: 3330, date_range_start: "2026-06-16" }), 167, "1 個 333 単位の半額は round(166.5)=167"],
      [R({ monthly_rental_fee: 3330, quantity: 2, date_range_start: "2026-06-16" }), 334, "半額は 1 個ずつ丸めてから × 数量"],
      [R({ date_range_start: "2026-07-01", date_range_end: "2026-07-31" }), 0, "当月に貸与日が無ければ 0"],
    ];
    const pc: [Partial<EquipmentRecordLike>, boolean][] = [
      [{ payment_type: "介護" }, true], [{ payment_type: " 介護 " }, true], [{ payment_type: "自費" }, false],
      [{ payment_type: "特価自費" }, false], [{ payment_type: null }, false], [{ payment_type: "" }, false], [{}, true],
    ];
    const runU = (fn: (r: EquipmentRecordLike, ym: string) => number) => uc.filter(([r, want]) => fn(r, YM) !== want);
    const runP = (fn: (rs: EquipmentRecordLike[]) => EquipmentRecordLike[]) => pc.filter(([o, want]) => fn([R(o)]).length !== (want ? 1 : 0));
    const badU = runU(recordMonthActualUnits);
    const badP = runP((rs) => splitInsuranceRecords(rs).insured);
    for (const [r, want, label] of badU) console.error(`✗ recordMonthActualUnits(${JSON.stringify(r)}) = ${recordMonthActualUnits(r, YM)} / 期待 ${want} (${label})`);
    for (const [o, want] of badP) console.error(`✗ splitInsuranceRecords(${JSON.stringify(o)}) 入れる=${!want} / 期待 ${want}`);
    const sk = splitInsuranceRecords([R({ payment_type: "自費" }), R({ payment_type: "特価自費" }), R({ payment_type: null }), R({ payment_type: "介護" })]).skipped;
    const skOk = sk.自費 === 2 && sk.支払区分不明 === 1 && sk.その他 === 0;
    if (!skOk) console.error(`✗ 入れなかった件数の内訳 ${JSON.stringify(sk)} / 期待 自費 2・不明 1`);
    if (badU.length || badP.length || !skOk) { console.error("✗ FAIL: 用具の実績取込の単位・絞り込みの境界が崩れている"); process.exit(1); }
    // 負のコントロール: ÷10 を外す / 特価自費を通す (includes("介護") 等の緩い判定) / 数量を掛けない
    const negNoDiv = runU((r, ym) => recordMonthActualUnits({ ...r, monthly_rental_fee: r.monthly_rental_fee * 10 }, ym));
    const negLoose = runP((rs) => rs.filter((r) => r.payment_type === undefined || !String(r.payment_type ?? "").startsWith("自費")));
    const negNoQty = runU((r, ym) => recordMonthActualUnits({ ...r, quantity: 1 }, ym));
    if (!negNoDiv.length || !negLoose.length || !negNoQty.length) { console.error(`✗ FAIL: 負のコントロールが鳴らない (÷10 を外す ${negNoDiv.length} / 特価自費を通す ${negLoose.length} / 数量なし ${negNoQty.length})`); process.exit(1); }
    console.log(`用具の実績取込: 境界 単位 ${uc.length} 件・支払区分 ${pc.length} 件 OK / 負のコントロール ÷10 を外す→${negNoDiv.length}・特価自費を通す→${negLoose.length}・数量なし→${negNoQty.length} 件 落ちる ✓ (★ 実データ未投入のため境界テストのみ)`);
  }

  // 取込の貸与行の入れ替え planEquipmentImport (src/lib/equipment-import-merge.ts・2026-11-13 H 判断 A)。
  // ★ 本番の取込は 0 件 = 実データ未検証のため境界テストのみ (合格とは言わない)
  {
    type Row = MergeRow & { id: string };
    const S = "介護ショップケア・サポート千葉";
    const N: Row = { id: "N", category: "11", provider: "訪問介護" };
    const imp: Row = { id: "imp", category: "17", provider: S, _units_source: EQUIPMENT_IMPORT_SOURCE };
    const imp2: Row = { id: "imp2", category: "17", provider: S, _units_source: EQUIPMENT_IMPORT_SOURCE };
    const noSrc: Row = { id: "noSrc", category: "17", provider: "介護ショップケア・サ" };
    const fm: Row = { id: "fm", category: "17", provider: "介護ショップケア・サ", _units_source: "fukuyogu_meisai_202606" };
    const bh: Row = { id: "bh", category: "17", provider: "介護ショップケア・サポ", _units_source: "betsuhyou_2026-06" };
    const other: Row = { id: "other", category: "17", provider: "カシダス千葉" };
    const r67: Row = { id: "r67", category: "67", provider: S };
    const emptyProv: Row = { id: "emptyProv", category: "17", provider: "" };
    type MC = [Row[], ImportChoice | null, string, string];  // 期待: "ok:<id,...>" / "choice:<件数>" / "throw"
    const mc: MC[] = [
      [[N, imp], null, "ok:N,imp2", "印付きのみ → 以前の取込行だけ置き換え"],
      [[N, noSrc], null, "choice:1", "印無しのみ (同じ事業所かもしれない) → 止める"],
      [[N, imp, noSrc], null, "choice:1", "印付き + 印無しの混在 → 止める"],
      [[fm, bh], null, "choice:2", "他の出どころ (ケアサポ明細・別表) → 止める"],
      [[N, r67, imp], null, "ok:N,r67,imp2", "種類 67 は触らない"],
      [[other, imp], null, "ok:other,imp2", "別の事業所の行は触らない"],
      [[], null, "ok:imp2", "空"],
      [[emptyProv], null, "choice:1", "事業所名が空 → 同じかもしれない側 (止める)"],
      [[N, imp, noSrc], "keep_existing", "ok:N,imp,noSrc", "既存を残す → 何も変えない"],
      [[N, imp, noSrc, other], "replace_existing", "ok:N,other,imp2", "置き換える → 重なる行と以前の取込行だけ消す"],
    ];
    type PlanFn = (svc: Row[], rows: Row[], sender: string, ch: ImportChoice | null) => MergePlan<Row>;
    const show = (fn: PlanFn, svc: Row[], ch: ImportChoice | null) => {
      try {
        const p = fn(svc, [imp2], S, ch);
        return p.status === "ok" ? `ok:${p.services.map((r) => r.id).join(",")}` : `choice:${p.conflicts.length}`;
      } catch { return "throw"; }
    };
    const runM = (fn: PlanFn) => mc.filter(([svc, ch, want]) => show(fn, svc, ch) !== want);
    const badM = runM(planEquipmentImport);
    for (const [svc, ch, want, label] of badM) console.error(`✗ planEquipmentImport(${svc.map((r) => r.id).join(",")}, ${ch}) = ${show(planEquipmentImport, svc, ch)} / 期待 ${want} (${label})`);
    let strayThrows = false;
    try { planEquipmentImport<Row>([], [{ id: "x", category: "17", provider: S }], S, null); } catch { strayThrows = true; }
    const bs = planEquipmentImport<Row>([fm, bh, noSrc], [], S, null);
    const bsOk = bs.status === "needs_choice" && bs.bySource["fukuyogu_meisai_*"] === 1 && bs.bySource["betsuhyou_*"] === 1 && Object.keys(bs.bySource).length === 3;
    if (badM.length || !strayThrows || !bsOk) { console.error(`✗ FAIL: 取込の貸与行の入れ替えの境界が崩れている (印の無い取込行で止まる ${strayThrows} / 出どころ別の件数 ${bsOk})`); process.exit(1); }
    // 負のコントロール: 今までの実装 (印を見ずに種類 17 を全部消す) / 二重計上の停止を外す
    const negWipeAll: PlanFn = (svc, rows) => ({ status: "ok", services: [...svc.filter((r) => String(r.category) !== "17"), ...rows], removedImportRows: 0, replacedRows: 0, keptOtherProviderRows: [] });
    const negNoStop: PlanFn = (svc, rows, sender) => planEquipmentImport(svc, rows, sender, "replace_existing");
    const nW = runM(negWipeAll).length, nS = runM(negNoStop).length;
    if (!nW || !nS) { console.error(`✗ FAIL: 負のコントロールが鳴らない (全部消す ${nW} / 停止を外す ${nS})`); process.exit(1); }
    console.log(`取込の貸与行の入れ替え: 境界 ${mc.length} 件 + 印の無い取込行 + 出どころ別件数 OK / 負のコントロール 全部消す→${nW}・停止を外す→${nS} 件 落ちる ✓ (★ 実データ未検証のため境界テストのみ)`);
  }

  // 別表ヘッダだけで client を引く resolveByBetsuhyouHeader (migrations/_client_resolve.mjs・2026-11-13 H 指示)。
  // 第7表の取込と貸与の単位埋めの両方が使う。DB は使わず、表を模した在メモリの sb で境界を見る
  {
    type T = Record<string, unknown>;
    const db: Record<string, T[]> = {
      client_insurance_records: [
        { id: "r1", client_id: "c1", insured_number: "1111111111" }, { id: "r2", client_id: "c2", insured_number: "2222222222" },
        { id: "r3", client_id: "c3", insured_number: "3333333333" }, { id: "r4", client_id: "c4", insured_number: "3333333333" },
        { id: "r5", client_id: "c5", insured_number: "5555555555" },
        { id: "r6", client_id: "c6", insured_number: "4444444444" }, { id: "r7", client_id: "c7", insured_number: "4444444444" },
      ],
      clients: [
        { id: "c1", name: "山田 太郎", deleted_at: null }, { id: "c2", name: "佐藤 花子", deleted_at: null },
        { id: "c3", name: "鈴木 一郎", deleted_at: null }, { id: "c4", name: "鈴木　一郎", deleted_at: null },
        { id: "c5", name: "田中 春子", deleted_at: "2026-01-01" },
        { id: "c6", name: "高橋 次郎", deleted_at: null }, { id: "c7", name: "伊藤 三郎", deleted_at: null },
      ],
      offices: [{ id: "o1", business_number: "1270000001" }],
      client_office_assignments: [{ id: "a1", client_id: "c1", office_id: "o1" }, { id: "a3", client_id: "c3", office_id: "o1" }],
    };
    const mockSb = {
      from(table: string) {
        const filters: [string, unknown[]][] = [];
        const q = {
          select() { return q; }, order() { return q; },
          in(col: string, vals: unknown[]) { filters.push([col, vals]); return q; },
          range(from: number, to: number) {
            const rows = (db[table] ?? []).filter((r) => filters.every(([c, v]) => v.includes(r[c])));
            return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
          },
        };
        return q;
      },
    };
    type E = { key: string; insured: string; name: string; officeNumber?: string | null };
    type BC = [E, string, string]; // 期待: "c1" / "c1!warn" / "c3~note" / "x" (引き当て不能)
    const bc: BC[] = [
      [{ key: "ok", insured: "1111111111", name: "山田 太郎", officeNumber: "1270000001" }, "c1", "被保番+氏名+割当 → 引く"],
      [{ key: "ins", insured: "1111111112", name: "山田 太郎", officeNumber: "1270000001" }, "x", "★ 負: 被保番が 1 桁違う → 引けない"],
      [{ key: "nm", insured: "1111111111", name: "山田 太朗", officeNumber: "1270000001" }, "x", "★ 負: 氏名が 1 文字違う → 引けない"],
      [{ key: "noasg", insured: "2222222222", name: "佐藤 花子", officeNumber: "1270000001" }, "c2!warn", "割当なし → 引くが warn (必須条件にしない)"],
      [{ key: "nooff", insured: "1111111111", name: "山田 太郎", officeNumber: "9999999999" }, "c1!warn", "事業所番号が offices に無い → 引くが warn"],
      [{ key: "noNum", insured: "1111111111", name: "山田 太郎" }, "c1", "事業所番号なし → 従来どおり 2 点で引く"],
      [{ key: "dup", insured: "3333333333", name: "鈴木 一郎", officeNumber: "1270000001" }, "c3~note", "同姓同名 2 人 → 割当で 1 人に絞る"],
      [{ key: "dupNoNum", insured: "3333333333", name: "鈴木 一郎" }, "x", "同姓同名 2 人・事業所番号なし → 引けない"],
      [{ key: "del", insured: "5555555555", name: "田中 春子" }, "x", "削除済みの client → 引けない"],
      [{ key: "coll", insured: "4444444444", name: "高橋 次郎" }, "c6", "同じ被保番の別人がいても氏名で 1 人"],
    ];
    type RB = (sb: never, e: E[], o: { normalizeName: (s: string) => string }) => Promise<{ resolved: Map<string, { clientId?: string; warn?: string; note?: string; reason?: string }> }>;
    const runB = async (fn: RB, norm: (s: string) => string) => {
      const { resolved } = await fn(mockSb as never, bc.map(([e]) => e), { normalizeName: norm });
      const got = (k: string) => { const r = resolved.get(k); return !r?.clientId ? "x" : `${r.clientId}${r.warn ? "!warn" : ""}${r.note ? "~note" : ""}`; };
      return bc.filter(([e, want]) => got(e.key) !== want).map(([e, want, label]) => `${e.key}: ${got(e.key)} / 期待 ${want} (${label})`);
    };
    const rb = resolveByBetsuhyouHeader as unknown as RB;
    const badB = await runB(rb, normName);
    for (const x of badB) console.error(`✗ resolveByBetsuhyouHeader ${x}`);
    if (badB.length) { console.error("✗ FAIL: 別表ヘッダの引き当ての境界が崩れている"); process.exit(1); }
    // 負のコントロール: 氏名を見ない (= 被保番だけで引く) と、氏名 1 文字違い・同姓同名の境界で鳴ること
    const negNoName = await runB(rb, () => "");
    if (!negNoName.some((x) => x.startsWith("nm:"))) { console.error(`✗ FAIL: 負のコントロールが鳴らない (氏名を見ない → ${negNoName.length} 件)`); process.exit(1); }
    console.log(`別表ヘッダの引き当て: 境界 ${bc.length} 件 OK (被保番違い・氏名 1 文字違いは引けない / 割当なしは warn) / 負のコントロール 氏名を見ない→${negNoName.length} 件 落ちる ✓`);
  }

  // 60 ページずつに割って出した束で 同じ人が複数ファイルに出たとき (selectBundlePersons・2026-11-13 H 依頼)
  //   完全 = 別表の行あり・警告なし (割れたかけらは「最終ページの欄が無い」警告が付く)
  {
    type P = { file: string; betsuhyouHeader: { month: string; insured: string; name: string }; betsuhyouItems: { service_code: string; service_units: number }[]; betsuhyouWarn: string[] };
    const H0 = { month: "2026-06", insured: "0000223887", name: "秋葉 政己" };
    const it = (u: number) => [{ service_code: "171003", service_units: u }];
    const full = (file: string, u = 800): P => ({ file, betsuhyouHeader: H0, betsuhyouItems: it(u), betsuhyouWarn: [] });
    const frag = (file: string): P => ({ file, betsuhyouHeader: H0, betsuhyouItems: it(800), betsuhyouWarn: ["別表の最終ページ (種類別支給限度管理の欄) が無い"] });
    type SC = [P[], string, string]; // 期待: "keep:<file>" / "none" と conflicts 数
    const sc: SC[] = [
      [[full("a"), full("b")], "keep:a|same1", "両方完全・同じ中身 → 1 つ (静かに)"],
      [[full("a"), full("b", 801)], "none|conflict1", "★ 両方完全・中身が違う → どれも書かない"],
      [[full("a"), frag("b")], "keep:a|partial1", "完全 + かけら → 完全な方"],
      [[frag("a"), full("b")], "keep:b|partial1", "★ かけらが先・完全が後 → 完全な方 (新しい方ではない)"],
      [[frag("a"), frag("b")], "keep:a|", "かけらしか無い → 1 つ渡す (自己検算の警告で書かれず、取り込めなかった人に出る)"],
      [[full("a")], "keep:a|", "1 ファイルだけ → そのまま"],
    ];
    type Sel = (all: P[]) => { persons: P[]; sameDropped: number; partialDropped: unknown[]; conflicts: unknown[] };
    const show = (fn: Sel, ps: P[]) => {
      const r = fn(ps);
      const keep = r.persons.length ? `keep:${r.persons.map((p) => p.file).join(",")}` : "none";
      const tag = r.conflicts.length ? `conflict${r.conflicts.length}` : r.sameDropped ? `same${r.sameDropped}` : r.partialDropped.length ? `partial${r.partialDropped.length}` : "";
      return `${keep}|${tag}`;
    };
    const runS = (fn: Sel) => sc.filter(([ps, want]) => show(fn, ps) !== want);
    const sel = selectBundlePersons as unknown as Sel;
    const badS = runS(sel);
    for (const [ps, want, label] of badS) console.error(`✗ selectBundlePersons(${ps.map((p) => p.file + (p.betsuhyouWarn.length ? "(かけら)" : "")).join(",")}) = ${show(sel, ps)} / 期待 ${want} (${label})`);
    if (badS.length) { console.error("✗ FAIL: 束の人単位の突き合わせの境界が崩れている"); process.exit(1); }
    // 負のコントロール: 以前の runner と同じ「後のファイルを採る」/ 中身を比べない
    const negLast: Sel = (all) => ({ persons: all.slice(-1), sameDropped: Math.max(all.length - 1, 0), partialDropped: [], conflicts: [] });
    const negNoCompare: Sel = (all) => ({ persons: all.slice(0, 1), sameDropped: Math.max(all.length - 1, 0), partialDropped: [], conflicts: [] });
    const nL = runS(negLast).length, nC = runS(negNoCompare).length;
    if (!nL || !nC) { console.error(`✗ FAIL: 負のコントロールが鳴らない (後のファイルを採る ${nL} / 中身を比べない ${nC})`); process.exit(1); }
    console.log(`束の人単位の突き合わせ: 境界 ${sc.length} 件 OK (中身が違えば書かない / かけらが先でも完全な方) / 負のコントロール 後のファイルを採る→${nL}・中身を比べない→${nC} 件 落ちる ✓`);
  }
}

const docs = await loadDocs();
const ky = loadKy();
codeRows = await loadUnitTypes(docs);
const ours = buildOurs(docs);
const res = compare(ours, ky);

const kyFiles = new Set([...ky.values()].flatMap((t) => [...t.files].map((f) => basename(f))));
console.log("=== 利用票 単位数 × 回数 vs 伝送 KY 8222 給付計画単位数 (READ ONLY) ===");
console.log(`利用票 ${docs.length} 件 / KY 票 ${ky.size} 件 (拠点 ${new Set([...ky.values()].map((t) => t.area)).size}・ファイル名 ${[...kyFiles].join(",")})`);
console.log("\n■ 母数の定義");
console.log("  キー = (提供年月, 保険者番号, 被保険者番号, サービス種類)。利用票と KY の両方に票がある利用者の、どちらかに現れる種類");
console.log(`  分母の票   ${res.denomTickets} 票`);
console.log(`  分母のキー ${res.denomKeys} キー (別掲キーを除く)`);
console.log(`  一致       ${res.match} / ${res.denomKeys} = ${(100 * res.match / Math.max(1, res.denomKeys)).toFixed(1)}%`);
console.log(`  不一致     ${res.mismatches.length}`);
console.log("\n■ 別掲 (合否に入れない)");
for (const [k, v] of Object.entries(res.asideKeysByReason)) console.log(`  キー  ${k.padEnd(12)} ${v}`);
for (const [k, v] of Object.entries(res.aside)) console.log(`  票    ${k.padEnd(12)} ${v}`);
console.log(`  票    KY にあるが利用票なし (利用票のある月のみ) ${res.kyOnlyTickets}`);
if (Object.keys(res.noKyByMonth).length) console.log(`        KY無しの月別: ${JSON.stringify(res.noKyByMonth)}`);

const byType: Record<string, number> = {};
for (const m of res.mismatches) byType[m.type] = (byType[m.type] ?? 0) + 1;
console.log("\n■ 不一致の型");
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v}`);
const byKind: Record<string, number> = {};
for (const m of res.mismatches) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
console.log(`  種類別: ${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ")}`);

console.log("\n■ 拠点別 (KY の置き場所で集計)");
console.log("  拠点        キー   一致   不一致");
const areaMis: Record<string, number> = {};
for (const m of res.mismatches) areaMis[m.area] = (areaMis[m.area] ?? 0) + 1;
for (const [a, v] of [...res.byArea.entries()].sort((x, y) => x[0].localeCompare(y[0], "ja")))
  console.log(`  ${a.padEnd(10, "　")} ${String(v.keys).padStart(5)} ${String(v.match).padStart(6)} ${String(areaMis[a] ?? 0).padStart(7)}`);

const show = DETAIL ? res.mismatches : res.mismatches.slice(0, 25);
console.log(`\n■ 不一致の明細 ${DETAIL ? "(全件)" : "(先頭 25 件。--detail で全件)"}`);
for (const m of show) console.log(`  [${m.type}] ${m.area} ${m.name} ${m.key} 当方 ${m.ours} / KY ${m.ky} (差 ${m.ours - m.ky})`);

// ── 負のコントロール ──
let shifted = false;
const firstMatchKey = (() => {
  for (const o of ours) {
    const t = ky.get(`${o.ym}|${o.insurer}|${o.insured}`);
    if (!t) continue;
    for (const [kind, k] of o.kinds) if (!k.aside && !RENTAL.has(kind) && t.kinds.get(kind) === k.planned && k.planned > 0) return { doc: o.doc.id, kind };
  }
  return null;
})();
let negOk = false;
if (firstMatchKey) {
  // 対象帳票の対象種類で、回数が 1 以上の最初の行だけ units を +1 (他の帳票はそのまま)
  const neg = compare(ours.map((o) => o.doc.id !== firstMatchKey.doc ? o : buildOurs([o.doc], (s) => {
    if (shifted || (s.category ?? "") !== firstMatchKey.kind || plannedCount(s) === 0) return 0;
    shifted = true; return 1;
  })[0]), ky);
  negOk = neg.match === res.match - 1;
  console.log(`\n■ 負のコントロール: 帳票 ${firstMatchKey.doc} 種類 ${firstMatchKey.kind} の 1 行の units を +1 → 一致 ${res.match} → ${neg.match} ${negOk ? "✓ 鳴った" : "✗ 鳴らない (検査が効いていない)"}`);
} else {
  console.log("\n■ 負のコントロール: 一致キーが 1 つも無く実施できない ✗");
}

// ── 負のコントロール 2: 月 1 回の扱いを外す (= 2026-11-12 初版の units × 回数) ──
// 外すと一致が減り、移った分がそのまま元の型に戻ることを確かめる。移り変わりを型ごとに出す
const resOff = compare(buildOurs(docs, undefined, false), ky);
const transitions: Record<string, number> = {};
for (const [k, before] of resOff.status) {
  const after = res.status.get(k) ?? "(分母外)";
  if (before !== after) transitions[`${before} → ${after}`] = (transitions[`${before} → ${after}`] ?? 0) + 1;
}
const monthlyGain = res.match - resOff.match;
const negMonthlyOk = monthlyGain > 0;
console.log(`\n■ 負のコントロール 2: 「1月につき」を月 1 回として扱うのをやめる → 一致 ${res.match} → ${resOff.match} (${negMonthlyOk ? "✓ 鳴った" : "✗ 鳴らない"})`);
console.log("  月 1 回の扱いの有無で結果が変わったキー (外したとき → 今):");
const printTransitions = (t: Record<string, number>) => { for (const [k, v] of Object.entries(t).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(40)} ${v}`); };
printTransitions(transitions);

// ── 負のコントロール 3: 月 1 回のコードの複数行を畳むのをやめる (行ごとには月 1 回のまま) ──
// 2026-11-12 (b) の変更。外すと一致が減り、移った分が元に戻ることを確かめる
const resNoDedupe = compare(buildOurs(docs, undefined, true, false), ky);
const transDedupe: Record<string, number> = {};
for (const [k, before] of resNoDedupe.status) {
  const after = res.status.get(k) ?? "(分母外)";
  if (before !== after) transDedupe[`${before} → ${after}`] = (transDedupe[`${before} → ${after}`] ?? 0) + 1;
}
const negDedupeOk = res.match > resNoDedupe.match;
console.log(`
■ 負のコントロール 3: 同じ (事業所, サービス) の月 1 回コードの複数行を畳むのをやめる → 一致 ${res.match} → ${resNoDedupe.match} (${negDedupeOk ? "✓ 鳴った" : "✗ 鳴らない"})`);
console.log("  畳むかどうかで結果が変わったキー (畳まないとき → 今):");
printTransitions(transDedupe);

// ── 頭打ちの検算 (CAP_CHECK=1 のときだけ。2026-11-14 H 依頼) ─────────────────────────────
//   「限度額で頭打ち」は 3 条件 (当方の票合計 > 限度額 / KY の票合計 <= 限度額 / 当方 > KY) だけで決めていて、
//   差の額が超過分と同じかは見ていない。超過分を 2 通りで出し、差と突き合わせる。
//   ① 計算 (票ごと): 超過 = 当方の限度額対象の合計 − 限度額。
//      限度額対象 = 種類 31 (居宅療養) を除く全種類の planned (OUTSIDE_LIMIT の加算行は buildOurs で既に除いている。貸与も入る)。
//      頭打ちキーの差 (当方 − KY) の合計 == 超過 なら「額まで合う」。限度額対象の行に単位の空き (units null) があれば「計算不能」。
//      ★ 票単位でしか見られない (どの種類に超過を割り振るかは ほのぼのの選択で、計算では決まらない)
//   ② 第7表 (キーごと): ほのぼのが別表に印字した「区分支給限度を超える単位数」(items[].over_limit_units)。
//      service_code の先頭 2 桁 = 種類 で集め、差 (当方 − KY) == その種類の超過 なら「額まで合う」。
//      _over_limit_unallocated (どの行の超過か読めなかった分) があり合わないときは「割り振り不明」。第7表が無い月 (2026-07 など) は「第7表なし」。
//   ★ ①と②が両方ある票では、①の超過と ②の超過合計 (over + unallocated) の食い違いも数える (独立 2 系統が一致しても値は確定しない、の裏返し)
type DetailItem = { service_code?: string | null; service_content?: string | null; over_limit_units?: number | string | null; _over_limit_unallocated?: number | string | null };
type CapKeyIn = { kind: string; ours: number; ky: number };
type CapKind = { planned: number; nullUnits: number; actual?: number; over30?: number; over30Actual?: number; plannedMonthly1?: number; actualMonthly1?: number };
// ★ 「額が合わない」頭打ちに 重なっている型を併記する (2026-11-14 H 依頼)。分類 (型) は変えない = 基準値は動かない。
//   型の判定は if/else if の連鎖で 1 キー 1 型なので、頭打ちに入った時点で 実績回数・30日超 などは見られていない。
//   各キーの単位を下の数え方に置き換えて「差の合計 == 限度額対象の合計 − 限度額」が成り立てば、その数え方が重なっていると見る
const CAP_VARIANTS: [string, (k: CapKind) => number][] = [
  ["実績回数", (k) => k.actual ?? k.planned],
  ["30日超を除く", (k) => k.planned - (k.over30 ?? 0)],
  ["実績回数+30日超を除く", (k) => (k.actual ?? k.planned) - (k.over30Actual ?? 0)],
  ["月1回の加算", (k) => k.plannedMonthly1 ?? k.planned],
  ["実績回数+月1回の加算", (k) => k.actualMonthly1 ?? k.planned],
];
export function capCheckTicket(
  kinds: Map<string, CapKind>, limit: number, capKeys: CapKeyIn[], items: DetailItem[] | null,
): { calc: "額まで合う" | "額が合わない" | "計算不能"; calcExcess: number; diffSum: number; overlaps: string[]; detail: Record<string, "額まで合う" | "額が合わない" | "割り振り不明" | "第7表なし" | "超過情報なし">; detailTotal: number | null } {
  let target = 0, incomplete = false;
  for (const [kind, k] of kinds) { if (OUTSIDE_LIMIT_KINDS.has(kind)) continue; target += k.planned; if (k.nullUnits > 0) incomplete = true; }
  const calcExcess = target - limit;
  const diffSum = capKeys.reduce((s, c) => s + (c.ours - c.ky), 0);
  const calc = incomplete ? "計算不能" : diffSum === calcExcess ? "額まで合う" : "額が合わない";
  const overlaps = calc !== "額が合わない" ? [] : CAP_VARIANTS.filter(([, f]) => {
    let t = 0;
    for (const [kind, k] of kinds) if (!OUTSIDE_LIMIT_KINDS.has(kind)) t += f(k);
    const d = capKeys.reduce((s, c) => s + (f(kinds.get(c.kind) ?? { planned: c.ours, nullUnits: 0 }) - c.ky), 0);
    return t > limit && d === t - limit;
  }).map(([name]) => name);
  const detail: Record<string, "額まで合う" | "額が合わない" | "割り振り不明" | "第7表なし" | "超過情報なし"> = {};
  let detailTotal: number | null = null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  // ★ 処遇改善加算の行にも別表は超過の額を印字するが、限度額の対象外で 人の超過合計には入らない (2026-11-13 段1 で確認)。
  //   入れると第7表の超過が 1 割ほど大きく出る (2026-11-14 CAP_CHECK 初回で 21/21 票が食い違った原因)
  items = items ? items.filter((it) => !/処遇改善/.test(String(it.service_content ?? ""))) : items;
  const unalloc = (items ?? []).reduce((s, it) => s + n(it._over_limit_unallocated), 0);
  const hasOver = (items ?? []).some((it) => n(it.over_limit_units) > 0) || unalloc > 0;
  if (items && hasOver) detailTotal = items.reduce((s, it) => s + n(it.over_limit_units), 0) + unalloc;
  for (const c of capKeys) {
    if (!items || !items.length) { detail[c.kind] = "第7表なし"; continue; }
    if (!hasOver) { detail[c.kind] = "超過情報なし"; continue; }
    const over = items.filter((it) => String(it.service_code ?? "").startsWith(c.kind)).reduce((s, it) => s + n(it.over_limit_units), 0);
    detail[c.kind] = c.ours - c.ky === over ? "額まで合う" : unalloc > 0 ? "割り振り不明" : "額が合わない";
  }
  return { calc, calcExcess, diffSum, overlaps, detail, detailTotal };
}
{ // 境界 (DB 不要)
  const K = (o: Record<string, [number, number?, number?]>) => new Map(Object.entries(o).map(([k, [p, nu, act]]) => [k, { planned: p, nullUnits: nu ?? 0, actual: act ?? p }]));
  const it = (code: string, over: number, un?: number): DetailItem => ({ service_code: code, over_limit_units: over, _over_limit_unallocated: un });
  type Case = [string, ReturnType<typeof K>, number, CapKeyIn[], DetailItem[] | null, string, Record<string, string>];
  const cases: Case[] = [
    ["超過 500 を訪問介護に全部 (計算・第7表とも合う)", K({ "11": [3000], "15": [2500] }), 5000, [{ kind: "11", ours: 3000, ky: 2500 }], [it("111111", 500), it("151111", 0)], "額まで合う", { "11": "額まで合う" }],
    ["差が超過より小さい", K({ "11": [3000], "15": [2500] }), 5000, [{ kind: "11", ours: 3000, ky: 2700 }], [it("111111", 500)], "額が合わない", { "11": "額が合わない" }],
    ["2 種類に割り振り", K({ "11": [3000], "15": [2500] }), 5000, [{ kind: "11", ours: 3000, ky: 2800 }, { kind: "15", ours: 2500, ky: 2200 }], [it("111111", 200), it("151111", 300)], "額まで合う", { "11": "額まで合う", "15": "額まで合う" }],
    ["居宅療養 (31) は限度額対象に数えない", K({ "11": [5300], "31": [900] }), 5000, [{ kind: "11", ours: 5300, ky: 5000 }], null, "額まで合う", { "11": "第7表なし" }],
    ["単位の空きがある = 計算不能", K({ "11": [5300], "17": [0, 1] }), 5000, [{ kind: "11", ours: 5300, ky: 5000 }], null, "計算不能", { "11": "第7表なし" }],
    ["第7表に超過が無い", K({ "11": [5300] }), 5000, [{ kind: "11", ours: 5300, ky: 5000 }], [it("111111", 0)], "額まで合う", { "11": "超過情報なし" }],
    ["処遇改善の行の超過は数えない", K({ "11": [5300] }), 5000, [{ kind: "11", ours: 5300, ky: 5000 }], [it("111111", 300), { service_code: "116275", service_content: "訪問介護処遇改善加算Ⅱ", over_limit_units: 41 }], "額まで合う", { "11": "額まで合う" }],
    ["行に割り振れない超過がある", K({ "11": [5300] }), 5000, [{ kind: "11", ours: 5300, ky: 5000 }], [it("111111", 100, 200)], "額まで合う", { "11": "割り振り不明" }],
  ];
  const bad = cases.filter(([, k, l, c, i, wc, wd]) => { const r = capCheckTicket(k, l, c, i); return r.calc !== wc || JSON.stringify(r.detail) !== JSON.stringify(wd); });
  for (const [label, k, l, c, i] of bad) console.error(`✗ capCheckTicket (${label}) = ${JSON.stringify(capCheckTicket(k, l, c, i))}`);
  // 重なっている型の併記: 種類 11 が頭打ち、種類 15 は予定 2000 / 実績 2200。KY は実績で数えて限度額 5000 に頭打ち
  //   実績合計 3600+2200=5800 → 超過 800 → KY11 = 3600−800 = 2800 / KY15 = 2200。予定で見ると 差 500 ≠ 超過 300 で合わない
  const ov1 = capCheckTicket(K({ "11": [3300, 0, 3600], "15": [2000, 0, 2200] }), 5000, [{ kind: "11", ours: 3300, ky: 2800 }], null);
  // 重ならない例: 実績も予定と同じなのに差が合わない (どの数え方でも説明が付かない)
  const ov2 = capCheckTicket(K({ "11": [3300], "15": [2000] }), 5000, [{ kind: "11", ours: 3300, ky: 2800 }], null);
  const ovWant = JSON.stringify(["実績回数", "実績回数+30日超を除く"]);
  if (ov1.calc !== "額が合わない" || JSON.stringify(ov1.overlaps) !== ovWant || ov2.overlaps.length !== 0) {
    console.error(`✗ 重なっている型の併記: ${ov1.calc} ${JSON.stringify(ov1.overlaps)} (期待 ${ovWant}) / 重ならない例 ${JSON.stringify(ov2.overlaps)} (期待 [])`); process.exit(1);
  }
  // 負のコントロール: 差を見ずに「頭打ちなら合う」とすると 合わない例を見逃す
  const negLoose = cases.filter(([, , , , , wc]) => wc !== "額まで合う").length;
  if (bad.length || !negLoose) { console.error("✗ FAIL: 頭打ちの検算 capCheckTicket の境界が崩れている"); process.exit(1); }
  console.log(`頭打ちの検算 capCheckTicket: 境界 ${cases.length} 件 + 重なっている型の併記 2 件 OK / 負のコントロール 差を見ない→${negLoose} 件 落ちる ✓`);
}
if (process.env.CAP_CHECK === "1") {
  const capByTicket = new Map<string, CapKeyIn[]>();
  for (const m of res.mismatches) if (m.type === "限度額で頭打ち") {
    const tk = m.key.split("|").slice(0, 3).join("|");
    capByTicket.set(tk, [...(capByTicket.get(tk) ?? []), { kind: m.kind, ours: m.ours, ky: m.ky }]);
  }
  const oursByTk = new Map<string, OurDoc>();
  for (const o of ours) { const tk = `${o.ym}|${o.insurer}|${o.insured}`; if (!oursByTk.has(tk)) oursByTk.set(tk, o); }
  // 第7表は 頭打ちの票の人だけ読む (軽い)。同じ人・同じ月に 2 件以上あれば使わない (どちらか決められない)
  const want = [...capByTicket.keys()].map((tk) => oursByTk.get(tk)!).filter(Boolean);
  const detailBy = new Map<string, DetailItem[] | null>();
  const get = restGet();
  for (const month of new Set(want.map((o) => o.doc.report_month))) {
    const users = [...new Set(want.filter((o) => o.doc.report_month === month).map((o) => o.doc.user_id))];
    for (let i = 0; i < users.length; i += 100) {
      const rows = await get(`kaigo_report_documents?select=user_id,items:content->items&report_type=eq.service-usage-detail&report_month=eq.${month}&user_id=in.(${users.slice(i, i + 100).join(",")})&limit=1000`) as { user_id: string; items: DetailItem[] | null }[];
      if (rows.length >= 1000) throw new Error("第7表の読みが 1000 行に達した (分けて読む)");
      const cnt = new Map<string, number>();
      for (const r of rows) cnt.set(r.user_id, (cnt.get(r.user_id) ?? 0) + 1);
      for (const r of rows) detailBy.set(`${month}|${r.user_id}`, cnt.get(r.user_id)! > 1 ? null : (r.items ?? []));
    }
  }
  const calcCount: Record<string, number> = {}, detailCount: Record<string, number> = {}, overlapCount: Record<string, number> = {};
  let bothTickets = 0, bothDisagree = 0;
  const lines: string[] = [];
  for (const [tk, keys] of capByTicket) {
    const o = oursByTk.get(tk);
    if (!o || o.limit == null) { calcCount["(票が引けない)"] = (calcCount["(票が引けない)"] ?? 0) + keys.length; continue; }
    const items = detailBy.get(`${o.doc.report_month}|${o.doc.user_id}`) ?? null;
    const r = capCheckTicket(o.kinds, o.limit, keys, items);
    calcCount[r.calc] = (calcCount[r.calc] ?? 0) + keys.length;
    for (const v of Object.values(r.detail)) detailCount[v] = (detailCount[v] ?? 0) + 1;
    if (r.detailTotal != null && r.calc !== "計算不能") { bothTickets++; if (r.detailTotal !== r.calcExcess) bothDisagree++; }
    if (r.calc === "額が合わない") { const k = r.overlaps.length ? r.overlaps.join("・") : "(どの数え方でも合わない)"; overlapCount[k] = (overlapCount[k] ?? 0) + keys.length; }
    lines.push(`  ${tk} 種類 ${keys.map((k) => k.kind).join(",")} 差 ${r.diffSum} / 計算の超過 ${r.calcExcess} → ${r.calc}${r.overlaps.length ? ` (重なり: ${r.overlaps.join("・")})` : ""} / 第7表 ${JSON.stringify(r.detail)}${r.detailTotal != null ? ` 第7表の超過 ${r.detailTotal}` : ""}  doc ${o.doc.id}`);
  }
  const nKeys = [...capByTicket.values()].reduce((s, v) => s + v.length, 0);
  console.log(`\n■ 頭打ちの検算 (CAP_CHECK=1): 頭打ちキー ${nKeys} / 票 ${capByTicket.size}`);
  console.log(`  ① 計算 (票単位・キー数で数える): ${JSON.stringify(calcCount)}`);
  console.log(`     うち「額が合わない」に重なっている数え方 (キー数・分類は変えない): ${JSON.stringify(overlapCount)}`);
  console.log(`  ② 第7表 (キー単位): ${JSON.stringify(detailCount)}`);
  console.log(`  ①②が両方ある票 ${bothTickets} / うち超過の額が食い違う票 ${bothDisagree}`);
  console.log("  ★ 見ていないもの: 頭打ち以外の型に紛れた頭打ち (実績回数で一致 等が先に当たったキー) / KY が限度額ちょうどかどうか");
  for (const l of DETAIL ? lines : lines.slice(0, 15)) console.log(l);
}

if (CHECK_MONTH) {
  console.log(`
★ CHECK_MONTH=${CHECK_MONTH} (この月だけ・基準値とは比べない): 分母 ${res.denomKeys} キー / 一致 ${res.match} (${res.denomKeys ? (res.match / res.denomKeys * 100).toFixed(1) : "-"}%) / 不一致 ${res.mismatches.length} / 脇に置いたもの ${JSON.stringify(res.aside)}`);
  process.exit(negOk ? 0 : 1);
}
// ── 基準値 ──
type Baseline = { _readme: string[]; months?: string[]; denomKeys: number; match: number; mismatch: number; byArea: Record<string, number>; byType: Record<string, number> };
const cur = { months: [...new Set(docs.map((d) => d.report_month))].sort(), denomKeys: res.denomKeys, match: res.match, mismatch: res.mismatches.length, byArea: areaMis, byType };
const newMonthDocs: Record<string, number> = {};
if (baselineMonths) for (const d of docs) if (!baselineMonths.has(d.report_month)) newMonthDocs[d.report_month] = (newMonthDocs[d.report_month] ?? 0) + 1;
for (const [m, n] of Object.entries(newMonthDocs).sort())
  console.log(`\n○ 基準値に無い月の利用票 ${m}: ${n} 件 → 突き合わせに入れていない。中身を確かめてから --update で取り込む (月が増えると不一致の合計も増える)`);
if (UPDATE) {
  const prev: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  writeFileSync(BASELINE, JSON.stringify({ _readme: prev?._readme ?? ["(説明を書くこと)"], ...cur }, null, 2) + "\n");
  console.log(`\n基準値を更新: ${BASELINE}`);
  process.exit(negOk ? 0 : 1);
}
if (!existsSync(BASELINE)) { console.error("\n✗ 基準値ファイルが無い。--update で作る"); process.exit(1); }
const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
const fails: string[] = [];
// ★ 用具の実績取込 (ImportEquipmentRecordModal) は manual_units に monthly_rental_fee をそのまま入れる。
//   order-app はこの値を円 (¥) として送っており、ServiceSelector は ÷10 しているので、単位が 10 倍になる疑い (2026-11-13・未確認)。
//   2026-11-13 に ÷10・数量・支払区分を直した (src/lib/equipment-record-units.ts)。ただし本番の取込は 0 件で、実データでは一度も確かめていない。
//   2026-11-13 に「取込の印が付いた行だけ消す / 重なるかもしれない既存行があれば止めて選ばせる」に変えた (equipment-import-merge.ts)。
//   初めて使われたら落とす: その帳票の単位を order-app の請求 (伝送) と突き合わせ、印の付かない貸与行と二重になっていないかも見てから、この判定を外すこと
const eqDocs = docs.filter((d) => Array.isArray(d.content?.equipment_records) && d.content!.equipment_records!.length > 0);
console.log(`用具の実績取込 (equipment_records) を使った利用票 ${eqDocs.length} 件 (0 であること。実データ未検証の経路)`);
if (eqDocs.length) fails.push(`用具の実績取込が使われた利用票 ${eqDocs.length} 件 (${eqDocs.slice(0, 3).map((d) => d.id).join(",")}) — 実データで未検証の取込経路。単位を order-app の請求と突き合わせ、印 (equipment_import) の付かない貸与行と二重になっていないか見る`);
if (!negOk) fails.push("負のコントロールが鳴らない");
if (!negDedupeOk) fails.push("負のコントロール 3 (複数行を畳む) が鳴らない = dedupeMonthlyCounts が効いていない");
if (!negMonthlyOk) fails.push("負のコントロール 2 (月 1 回の扱い) が鳴らない = rowMonthlyUnitsOf の月 1 回が効いていない");
if (cur.mismatch > base.mismatch) fails.push(`不一致 ${base.mismatch} → ${cur.mismatch} (増えた)`);
for (const [a, n] of Object.entries(areaMis)) if (n > (base.byArea[a] ?? 0)) fails.push(`${a}: 不一致 ${base.byArea[a] ?? 0} → ${n}`);
// 単位数そのものの誤りが出るのは「説明のつかない型」。ここは型ごとに増えたら落とす
for (const t of ["当方>KY", "当方<KY", "片側のみ(利用票だけ)", "片側のみ(KYだけ)"])
  if ((byType[t] ?? 0) > (base.byType[t] ?? 0)) fails.push(`型「${t}」 ${base.byType[t] ?? 0} → ${byType[t]} (説明のつかない差が増えた)`);
if (cur.denomKeys === base.denomKeys && cur.match < base.match) fails.push(`分母が同じ (${cur.denomKeys}) のまま一致が ${base.match} → ${cur.match} (回帰)`);
console.log(`\n基準値: 分母 ${base.denomKeys} / 一致 ${base.match} / 不一致 ${base.mismatch}`);
if (cur.denomKeys !== base.denomKeys) console.log(`  ○ 分母が変わった (${base.denomKeys} → ${cur.denomKeys}) = データが変わった。悪化でなければ --update`);
if (cur.mismatch < base.mismatch) console.log(`  ○ 不一致が減った (${base.mismatch} → ${cur.mismatch})。--update で締めてよい`);
if (fails.length) { console.log("✗ FAIL"); for (const f of fails) console.log("  " + f); process.exit(1); }
console.log("✓ PASS (基準値より悪化なし・負のコントロール確認済み)");
