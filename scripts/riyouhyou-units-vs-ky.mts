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
import { rowMonthlyUnitsOf, isMonthlyUnitType } from "@/lib/riyouhyou-row-units";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASELINE = join(HERE, "riyouhyou-units-baseline.json");
const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.includes("--detail");

type Svc = {
  content?: string; units?: number | null; category?: string | null; manual_units?: number | null; unit_type?: string | null;
  planned?: boolean[]; actual?: boolean[]; planned_counts?: number[]; actual_counts?: number[];
};
type Doc = {
  id: string; user_id: string; report_month: string;
  content: { services?: Svc[]; insurer_number?: string; insured_number?: string; user_name?: string; limit_amount?: number | string | null } | null;
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
  if (process.env.DOCS_CACHE) return JSON.parse(readFileSync(process.env.DOCS_CACHE, "utf8")) as Doc[];
  const get = restGet();
  const out: Doc[] = [];
  for (let off = 0; ; off += 1000) {
    const d = await get(`kaigo_report_documents?select=id,user_id,report_month,content&report_type=eq.service-usage&order=id.asc&limit=1000&offset=${off}`) as Doc[];
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

type OurKind = { planned: number; actual: number; over30: number; plannedMonthly1: number; actualMonthly1: number; aside: string | null; rows: number };
type OurDoc = { doc: Doc; ym: string; insurer: string; insured: string; kinds: Map<string, OurKind>; limit: number | null };

/**
 * @param capMonthly true = unit_type が「1月につき」等なら回数を月 1 回に (画面と同じ rowMonthlyUnitsOf)。
 *                   false = 従来の units × 回数 (負のコントロール用。2026-11-12 初版の基準値と同じ値になるはず)
 */
function buildOurs(docs: Doc[], unitShift?: (s: Svc) => number, capMonthly = true): OurDoc[] {
  const out: OurDoc[] = [];
  for (const d of docs) {
    const c = d.content ?? {};
    const kinds = new Map<string, OurKind>();
    for (const s of c.services ?? []) {
      const kind = (s.category ?? "").trim() || "(種類不明)";
      const k = kinds.get(kind) ?? { planned: 0, actual: 0, over30: 0, plannedMonthly1: 0, actualMonthly1: 0, aside: null, rows: 0 };
      k.rows++;
      kinds.set(kind, k);
      if (OUTSIDE_LIMIT.test(s.content ?? "")) continue; // 限度額対象外の加算は計画単位数に入らない
      if (RENTAL.has(kind)) k.aside = "貸与";
      else if (OUTSIDE_LIMIT_KINDS.has(kind)) k.aside = "限度額対象外の種類";
      else if ((s.content ?? "").includes("同一建物減算")) k.aside ??= "同一建物減算";
      else if (s.units == null) k.aside ??= "マスタ無し";
      const u = (s.units ?? 0) + (unitShift ? unitShift(s) : 0);
      // ★ 画面・印刷と同じ式 (src/lib/riyouhyou-row-units.ts)。回数の取り方だけ違う:
      //   画面は印の数 (boolean)、ここは planned_counts の合計 (1 日 2 回を 2 と数える。KY と同じ)
      const ut = capMonthly ? unitTypeOf(s, d.report_month) : null;
      k.planned += rowMonthlyUnitsOf(u, plannedCount(s), ut);
      k.actual += rowMonthlyUnitsOf(u, actualCount(s), ut);
      if (OVER30.test(s.content ?? "")) k.over30 += rowMonthlyUnitsOf(u, plannedCount(s), ut);
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

function compare(ours: OurDoc[], ky: Map<string, KyTicket>): Result {
  const r: Result = { denomTickets: 0, denomKeys: 0, match: 0, mismatches: [], aside: {}, asideKeysByReason: {}, byArea: new Map(), noKyByMonth: {}, kyOnlyTickets: 0, status: new Map() };
  const bump = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
  const seen = new Set<string>();
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
      if (!ok || kv == null) type = !ok ? "片側のみ(KYだけ)" : "片側のみ(利用票だけ)";
      else if (ok.actual === kyV) type = "実績回数で一致";
      else if (ok.over30 > 0 && ourV - ok.over30 === kyV) type = "30日超の日を除けば一致";
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
for (const [k, v] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(40)} ${v}`);

// ── 基準値 ──
type Baseline = { _readme: string[]; denomKeys: number; match: number; mismatch: number; byArea: Record<string, number>; byType: Record<string, number> };
const cur = { denomKeys: res.denomKeys, match: res.match, mismatch: res.mismatches.length, byArea: areaMis, byType };
if (UPDATE) {
  const prev: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  writeFileSync(BASELINE, JSON.stringify({ _readme: prev?._readme ?? ["(説明を書くこと)"], ...cur }, null, 2) + "\n");
  console.log(`\n基準値を更新: ${BASELINE}`);
  process.exit(negOk ? 0 : 1);
}
if (!existsSync(BASELINE)) { console.error("\n✗ 基準値ファイルが無い。--update で作る"); process.exit(1); }
const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
const fails: string[] = [];
if (!negOk) fails.push("負のコントロールが鳴らない");
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
