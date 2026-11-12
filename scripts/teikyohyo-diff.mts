/**
 * ほのぼのの「提供票一覧」CSV (KSG0261) の実績 と 当方の訪問介護の実績 (kaigo_visit_schedule) を
 * 日単位で突合する (READ ONLY — DB 書込なし)。基準値方式。
 *
 *   npm run check:teikyohyo-diff               # 判定 (基準値より悪化したら exit 1)
 *   npm run check:teikyohyo-diff -- --update   # 基準値を更新 (悪化したまま更新しないこと)
 *   npm run check:teikyohyo-diff -- --detail   # 不一致の明細を全部出す
 *   env TEIKYOHYO_CSV=<path>  CSV の場所 (既定: サービス実績データ/全社/202606/訪問介護/提供票一覧_KSG0261.CSV)
 *
 * ── 材料 ───────────────────────────────────────────────────────────
 * ほのぼの NEXT の提供票一覧 CSV (Shift_JIS)。1 行 = (事業所, 利用者, サービス, 時間帯, 予定/実績) で
 * 1日〜31日 の回数・合計・概算単位数・請求区分・サービスコードを持つ。全社の自社訪問介護・総合事業のみ
 * (福祉用具・他社サービスは入らない)。2026-11-12 に H がリモートで出した 2026-06 分 (24,554 行 / 93 事業所)。
 *
 * ── 何を見るか ─────────────────────────────────────────────────────
 * ① 実績の日別回数: キー (事業所, 利用者, サービスコード, 日) の回数が当方と一致するか
 *    ・対象は請求区分「介護保険」の実績行。加算・減算の行は別掲 (当方はシフトでなく加算行に持つ)
 *    ・総合事業 (A2/A3) は保険者ごとにコードが違う (当方は CB_A22621 のような独自コード) ので
 *      コードを見ず (事業所, 利用者, 日) で比べる
 *    ・当方は status='completed' かつ system が 介護/総合事業 の行。サービス名 → 対象月に有効なマスタのコード
 * ② 1 回あたりの単位: 概算単位数 ÷ 回数 を、当方マスタ (kaigo_service_codes) の単位と比べる (訪問介護のコード)
 *    ・2026-11-12 実測: 116711 身体９生活１ が ほのぼの 1,206 / 当方 1,124 (82 不足)。基準値に記録
 *
 * ── 循環に注意 ─────────────────────────────────────────────────────
 * これは ほのぼのの出力。当方の入力 (実績・マスタ) をこれに合わせて書き換えると、移行後に検証の材料が無くなる
 * (memory feedback_migration_from_input_not_billing_output)。★ 差を出すところまで。直すのは別途判断。
 *
 * ── 母数 ───────────────────────────────────────────────────────────
 * 突合するのは「CSV の (事業所, 利用者) を当方の利用者に 1 人に引き当てられた組」の範囲だけ。
 *   事業所: CSV の事業所番号 → offices.business_number / sougou_business_number / office_sougou_numbers
 *   利用者: その事業所に割当 (client_office_assignments) がある利用者のうち、clients.user_number または
 *           migrations/_meisai_num_to_client*.json で CSV の利用者番号に当たる人が ちょうど 1 人
 *   引き当てられない行・当方に実績が無い既知の事業所 (船橋・君津・八千代ヘルパー) は別掲。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Encoding from "encoding-japanese";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASELINE = join(HERE, "teikyohyo-diff-baseline.json");
const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.includes("--detail");
const CSV = process.env.TEIKYOHYO_CSV || join(ROOT, "サービス実績データ", "全社", "202606", "訪問介護", "提供票一覧_KSG0261.CSV");
// 当方に実績が 1 件も無い既知の事業所 (SESSION_START「訪問介護 君津 / 八千代 / 船橋 は元データが手元に 1 つも無い」)
const NO_DATA_OFFICE = /船橋ヘルパー|君津ムツミヘルパー|八千代ヘルパー/;
// ほのぼのが利用者番号を採番していない人に入れる仮の値。別人が同じ番号を共有するので、番号での突合に使わない
// (2147483647 = int32 の最大値。migrations/fix_junk_user_number_owners.mjs 参照。9999 も 2026-11-12 に提供票で別人共有を確認)
const JUNK_USER_NUMBERS = new Set(["2147483647", "9999"]);

// ── 0. CSV ──────────────────────────────────────────────────────
if (!existsSync(CSV)) {
  console.log(`材料なし: ${CSV} が無い。★ 合格ではない (ほのぼの 提供票一覧 CSV を置いてから回すこと)`);
  process.exit(0);
}
const text = Encoding.codeToString(Encoding.convert(readFileSync(CSV), { to: "UNICODE", from: "SJIS" }));
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
const head = lines[0].split(",").map((x) => x.replace(/^"|"$/g, ""));
const col = (name: string) => { const i = head.indexOf(name); if (i < 0) throw new Error(`CSV に列「${name}」が無い (見出しが想定と違う)`); return i; };
const C = {
  officeNo: col("事業所番号"), officeName: col("事業所名"), userNo: col("利用者番号"), ym: col("提供年月"),
  content: col("サービス内容"), kind: col("予定／実績"), total: col("合計・回数"), units: col("概算単位数"),
  billing: col("請求区分"), code: col("サービスコード"), day1: col("1日"),
};
const rows = lines.slice(1).map((l) => l.replace(/^"|"$/g, "").split('","'));
const badCols = rows.filter((r) => r.length !== head.length).length;
if (badCols) throw new Error(`列数が見出しと違う行が ${badCols} 行 (CSV の区切りが想定と違う)`);
const months = [...new Set(rows.map((r) => r[C.ym]))];
if (months.length !== 1) throw new Error(`提供年月が 1 つでない: ${months.join(",")}`);
const [Y, M] = months[0].split("/").map(Number);
const MONTH = `${Y}-${String(M).padStart(2, "0")}`;
const FIRST = `${MONTH}-01`;
const LAST = `${MONTH}-${String(new Date(Y, M, 0).getDate()).padStart(2, "0")}`;

// ── 1. DB ───────────────────────────────────────────────────────
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error(".env.local に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無い");
const get = async <T,>(q: string): Promise<T[]> => {
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${q}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`REST ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t) as T[];
};
// ⚠ order 無しのページングは行が抜ける (memory feedback_postgrest_paging_needs_order)。必ず id で並べる
const all = async <T,>(q: string): Promise<T[]> => { const o: T[] = []; for (let f = 0; ; f += 1000) { const d = await get<T>(`${q}&order=id.asc&limit=1000&offset=${f}`); o.push(...d); if (d.length < 1000) return o; } };

type Office = { id: string; name: string; business_number: string | null; sougou_business_number: string | null };
type Sched = { id: string; user_id: string; office_id: string; visit_date: string; service_type: string | null; status: string; system: string | null };
type Code = { service_code: string; service_name: string; units: number | null; system: string; valid_from: string; valid_until: string | null };
const offices = await all<Office>("offices?select=id,name,business_number,sougou_business_number");
const sougouNos = await all<{ id: string; office_id: string; business_number: string | null }>("office_sougou_numbers?select=id,office_id,business_number");
const coa = await all<{ id: string; client_id: string; office_id: string }>("client_office_assignments?select=id,client_id,office_id");
const clients = await all<{ id: string; user_number: string | null }>("clients?select=id,user_number");
const sched = await all<Sched>(`kaigo_visit_schedule?select=id,user_id,office_id,visit_date,service_type,status,system&visit_date=gte.${FIRST}&visit_date=lte.${LAST}`);
const validNow = (c: Code) => c.valid_from <= FIRST && (!c.valid_until || c.valid_until >= FIRST);
const codesByName: Code[] = [];
{
  const names = [...new Set(sched.map((s) => s.service_type).filter((n): n is string => !!n))];
  for (let i = 0; i < names.length; i += 25) {
    const list = names.slice(i, i + 25).map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
    codesByName.push(...await get<Code>(`kaigo_service_codes?select=service_code,service_name,units,system,valid_from,valid_until&service_name=in.(${encodeURIComponent(list)})`));
  }
}
const csvCodes = [...new Set(rows.map((r) => r[C.code]).filter((c) => /^\d{6}$/.test(c)))];
const codesByCode: Code[] = [];
for (let i = 0; i < csvCodes.length; i += 100)
  codesByCode.push(...await get<Code>(`kaigo_service_codes?select=service_code,service_name,units,system,valid_from,valid_until&system=eq.${encodeURIComponent("介護")}&service_code=in.(${csvCodes.slice(i, i + 100).join(",")})`));

// ── 2. 引き当て ──────────────────────────────────────────────────
const offByNo = new Map<string, Set<string>>();
const addOff = (no: string | null, id: string) => { if (no) (offByNo.get(no) ?? offByNo.set(no, new Set()).get(no)!).add(id); };
for (const o of offices) { addOff(o.business_number, o.id); addOff(o.sougou_business_number, o.id); }
for (const s of sougouNos) addOff(s.business_number, s.office_id);
const offName = new Map(offices.map((o) => [o.id, o.name]));
const noDataOffices = new Set(offices.filter((o) => NO_DATA_OFFICE.test(o.name)).map((o) => o.id));
const assigned = new Set(coa.map((a) => `${a.office_id}|${a.client_id}`));
const byNum = new Map<string, Set<string>>();
const addNum = (n: string, id: string) => (byNum.get(n) ?? byNum.set(n, new Set()).get(n)!).add(id);
for (const c of clients) if (c.user_number) addNum(c.user_number, c.id);
for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => /^_meisai_num_to_client.*\.json$/.test(f))) {
  const m = JSON.parse(readFileSync(join(ROOT, "migrations", f), "utf8")) as Record<string, string | { client_id?: string }>;
  for (const [k, v] of Object.entries(m)) { const id = typeof v === "string" ? v : v?.client_id; if (id) addNum(k, id); }
}
/** (事業所の候補, 利用者番号) → "office|client"。0 人 = null / 2 人以上 = "AMBIG" */
const resolve = (offs: Set<string>, num: string): string | null => {
  const cand = new Set<string>();
  for (const id of byNum.get(num) ?? []) for (const o of offs) if (assigned.has(`${o}|${id}`)) cand.add(`${o}|${id}`);
  return cand.size === 1 ? [...cand][0] : cand.size === 0 ? null : "AMBIG";
};

// ── 3. 両側の (事業所|利用者|コード|日) → 回数 ─────────────────────────
const SOUGOU = "総合事業";
type Counts = Map<string, number>;
const add = (m: Counts, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

function buildOurs(dayShift?: (s: Sched) => number): { m: Counts; rows: number; noCode: Record<string, number> } {
  const codeOf = new Map<string, Set<string>>();
  for (const c of codesByName) if (validNow(c)) (codeOf.get(`${c.system}|${c.service_name}`) ?? codeOf.set(`${c.system}|${c.service_name}`, new Set()).get(`${c.system}|${c.service_name}`)!).add(c.service_code);
  const m: Counts = new Map(); let n = 0; const noCode: Record<string, number> = {};
  for (const s of sched) {
    if (s.status !== "completed" || (s.system !== "介護" && s.system !== SOUGOU)) continue;
    n++;
    let code: string;
    if (s.system === SOUGOU) code = SOUGOU;
    else { const cs = codeOf.get(`介護|${s.service_type}`); if (!cs || cs.size !== 1) { noCode[s.service_type ?? "(空)"] = (noCode[s.service_type ?? "(空)"] ?? 0) + 1; continue; } code = [...cs][0]; }
    add(m, `${s.office_id}|${s.user_id}|${code}|${Number(s.visit_date.slice(8)) + (dayShift ? dayShift(s) : 0)}`, 1);
  }
  return { m, rows: n, noCode };
}

const st = { 実績行: 0, 加算減算: 0, 仮の利用者番号: 0, 事業所が引けない: 0, 利用者が引けない: 0, 利用者が複数: 0, 使えた: 0 };
const junkNames = new Set<string>();
const hono: Counts = new Map();
const unresolvedOffice: Record<string, number> = {};
for (const r of rows) {
  if (r[C.kind] !== "実績" || r[C.billing] !== "介護保険") continue;
  st.実績行++;
  if (/加算|減算/.test(r[C.content])) { st.加算減算++; continue; }
  if (JUNK_USER_NUMBERS.has(r[C.userNo])) { st.仮の利用者番号++; junkNames.add(`${r[C.userNo]} ${r[C.officeName]}`); continue; }
  const offs = offByNo.get(r[C.officeNo]);
  if (!offs) { st.事業所が引けない++; unresolvedOffice[`${r[C.officeNo]} ${r[C.officeName]}`] = (unresolvedOffice[`${r[C.officeNo]} ${r[C.officeName]}`] ?? 0) + 1; continue; }
  const oc = resolve(offs, r[C.userNo]);
  if (!oc) { st.利用者が引けない++; continue; }
  if (oc === "AMBIG") { st.利用者が複数++; continue; }
  st.使えた++;
  const code = /^A/.test(r[C.code]) ? SOUGOU : r[C.code];
  for (let d = 1; d <= 31; d++) { const n = Number(r[C.day1 + d - 1]) || 0; if (n) add(hono, `${oc}|${code}|${d}`, n); }
}

type Result = { both: number; eq: number; onlyH: number; onlyO: number; outsideO: number; noData: number;
  byKind: Record<string, { both: number; eq: number; onlyH: number; onlyO: number }>; byOffice: Record<string, number>; diffs: string[] };
function compare(ours: Counts): Result {
  const pairs = new Set([...hono.keys()].map((k) => k.split("|").slice(0, 2).join("|")));
  const r: Result = { both: 0, eq: 0, onlyH: 0, onlyO: 0, outsideO: 0, noData: 0, byKind: {}, byOffice: {}, diffs: [] };
  for (const k of new Set([...hono.keys(), ...ours.keys()])) {
    const [off, , code] = k.split("|");
    const h = hono.get(k) ?? 0, o = ours.get(k) ?? 0;
    if (noDataOffices.has(off)) { r.noData += h; continue; }
    if (!pairs.has(k.split("|").slice(0, 2).join("|"))) { r.outsideO += o; continue; }
    const kd = code === SOUGOU ? SOUGOU : "訪問介護";
    const b = (r.byKind[kd] ??= { both: 0, eq: 0, onlyH: 0, onlyO: 0 });
    const name = offName.get(off) ?? off;
    if (h && o) { r.both++; b.both++; if (h === o) { r.eq++; b.eq++; continue; } }
    else if (h) { r.onlyH += h; b.onlyH += h; } else { r.onlyO += o; b.onlyO += o; }
    r.byOffice[name] = (r.byOffice[name] ?? 0) + 1;
    r.diffs.push(`${h && o ? "回数違い" : h ? "ほのぼのだけ" : "当方だけ"} ${name} ${k} ほのぼの ${h} / 当方 ${o}`);
  }
  return r;
}

const oursBuilt = buildOurs();
const res = compare(oursBuilt.m);

// ── 4. 1 回あたりの単位 (訪問介護のコード) ──────────────────────────
const honoUnits = new Map<string, Map<number, number>>(); // code → (単位/回 → 回数)
for (const r of rows) {
  if (r[C.kind] !== "実績" || r[C.billing] !== "介護保険" || !/^\d{6}$/.test(r[C.code])) continue;
  const n = Number(r[C.total]) || 0; if (!n) continue;
  const v = Math.round((Number(r[C.units]) || 0) / n * 1000) / 1000;
  const m = honoUnits.get(r[C.code]) ?? honoUnits.set(r[C.code], new Map()).get(r[C.code])!;
  m.set(v, (m.get(v) ?? 0) + n);
}
function unitDiffs(shift?: (code: string) => number): string[] {
  const master = new Map<string, Set<number>>();
  for (const c of codesByCode) if (validNow(c)) (master.get(c.service_code) ?? master.set(c.service_code, new Set()).get(c.service_code)!).add((c.units ?? 0) + (shift ? shift(c.service_code) : 0));
  const out: string[] = [];
  for (const [code, vs] of honoUnits) {
    const ms = master.get(code);
    if (!ms) { out.push(`${code} マスタ無し`); continue; }
    // ほのぼのの値が 1 つでもマスタに無ければ差 (初回加算の 100 のように、半額などで複数の値が出るものもある)
    const miss = [...vs.keys()].filter((v) => !ms.has(v));
    if (miss.length) out.push(`${code} ほのぼの/回 ${miss.join("/")} (計 ${[...vs.entries()].filter(([v]) => miss.includes(v)).reduce((s, [, n]) => s + n, 0)} 回) / マスタ ${[...ms].join("/")}`);
  }
  return out.sort();
}
const ud = unitDiffs();

// ── 出力 ────────────────────────────────────────────────────────
console.log(`=== 提供票一覧 (ほのぼの) 実績 vs 当方の訪問介護の実績 ${MONTH} (READ ONLY) ===`);
console.log(`CSV ${rows.length} 行 (実績 ${rows.filter((r) => r[C.kind] === "実績").length}) / 当方の実績 ${oursBuilt.rows} 件 (completed・介護/総合事業)`);
console.log("\n■ 母数の定義");
console.log("  CSV の請求区分「介護保険」の実績行のうち、(事業所, 利用者) を当方の 1 人に引き当てられた組の範囲で、");
console.log("  キー (事業所, 利用者, サービスコード, 日) の回数を比べる。総合事業はコードを見ず (事業所, 利用者, 日)");
console.log(`  CSV 実績行 ${st.実績行} = 使えた ${st.使えた} + 加算減算 ${st.加算減算} + 仮の利用者番号 ${st.仮の利用者番号} + 事業所が引けない ${st.事業所が引けない} + 利用者が引けない ${st.利用者が引けない} + 利用者が複数 ${st.利用者が複数}`);
if (junkNames.size) console.log(`  仮の利用者番号 (2147483647 / 9999。別人が共有するので使わない): ${[...junkNames].join(" / ")}`);
if (Object.keys(unresolvedOffice).length) console.log(`  事業所が引けない: ${JSON.stringify(unresolvedOffice)}`);
if (Object.keys(oursBuilt.noCode).length) console.log(`  当方でサービス名からコードが一意に引けない: ${JSON.stringify(oursBuilt.noCode)}`);
console.log("\n■ ① 日別の回数");
for (const [k, v] of Object.entries(res.byKind)) console.log(`  ${k.padEnd(6, "　")} 両方にある ${v.both} 組 / 回数一致 ${v.eq} (${(100 * v.eq / Math.max(1, v.both)).toFixed(2)}%) / ほのぼのだけ ${v.onlyH} 回 / 当方だけ ${v.onlyO} 回`);
console.log(`  別掲: 当方に実績が無い既知の事業所 (船橋・君津・八千代) のほのぼの ${res.noData} 回 / 当方のみの利用者 (CSV に居ない) ${res.outsideO} 回`);
console.log("  不一致のキー数 (事業所別):");
for (const [k, v] of Object.entries(res.byOffice).sort((a, b) => b[1] - a[1])) console.log(`    ${k} ${v}`);
const showD = DETAIL ? res.diffs : res.diffs.slice(0, 20);
console.log(`  明細 ${DETAIL ? "(全件)" : "(先頭 20 件。--detail で全件)"}`);
for (const d of showD) console.log(`    ${d}`);
console.log(`\n■ ② 1 回あたりの単位 (訪問介護のコード ${honoUnits.size} 種): マスタと違う ${ud.length}`);
for (const d of ud) console.log(`    ${d}`);

// ── 負のコントロール ──
// (a) 当方の実績を 1 件だけ 1 日ずらす → 不一致のキーが増える
let shifted = false;
const target = sched.find((s) => s.status === "completed" && s.system === "介護" && !noDataOffices.has(s.office_id) && Number(s.visit_date.slice(8)) < 28
  && res.diffs.every((d) => !d.includes(`${s.office_id}|${s.user_id}|`)));
const negA = target ? compare(buildOurs((s) => { if (shifted || s.id !== target.id) return 0; shifted = true; return 1; }).m) : null;
const negAOk = !!negA && negA.diffs.length > res.diffs.length;
console.log(`\n■ 負のコントロール (a): 当方の実績 1 件を 1 日ずらす → 不一致のキー ${res.diffs.length} → ${negA?.diffs.length ?? "-"} ${negAOk ? "✓ 鳴った" : "✗ 鳴らない"}`);
// (b) マスタの単位を 1 つだけ +1 する → 単位の差が増える
const okCode = [...honoUnits.keys()].find((c) => !ud.some((d) => d.startsWith(c)));
const negB = okCode ? unitDiffs((c) => (c === okCode ? 1 : 0)) : null;
const negBOk = !!negB && negB.length === ud.length + 1;
console.log(`■ 負のコントロール (b): マスタ ${okCode ?? "-"} の単位を +1 → 単位の差 ${ud.length} → ${negB?.length ?? "-"} ${negBOk ? "✓ 鳴った" : "✗ 鳴らない"}`);

// ── 基準値 ──
type Baseline = { _readme: string[]; month: string; byKind: Result["byKind"]; byOffice: Record<string, number>; mismatchKeys: number; unitDiffs: string[] };
const cur = { month: MONTH, byKind: res.byKind, byOffice: res.byOffice, mismatchKeys: res.diffs.length, unitDiffs: ud };
if (UPDATE) {
  const prev: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  writeFileSync(BASELINE, JSON.stringify({ _readme: prev?._readme ?? ["(説明を書くこと)"], ...cur }, null, 2) + "\n");
  console.log(`\n基準値を更新: ${BASELINE}`);
  process.exit(negAOk && negBOk ? 0 : 1);
}
if (!existsSync(BASELINE)) { console.error("\n✗ 基準値ファイルが無い。--update で作る"); process.exit(1); }
const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
const fails: string[] = [];
if (base.month !== MONTH) fails.push(`CSV の提供年月 ${MONTH} が基準値 ${base.month} と違う (別の月の CSV を置いたなら基準値を作り直す)`);
if (!negAOk) fails.push("負のコントロール (a) が鳴らない");
if (!negBOk) fails.push("負のコントロール (b) が鳴らない");
if (res.diffs.length > base.mismatchKeys) fails.push(`不一致のキー ${base.mismatchKeys} → ${res.diffs.length} (増えた)`);
for (const [k, v] of Object.entries(res.byOffice)) if (v > (base.byOffice[k] ?? 0)) fails.push(`${k}: 不一致のキー ${base.byOffice[k] ?? 0} → ${v}`);
for (const [k, v] of Object.entries(res.byKind)) { const b = base.byKind[k]; if (b && v.both === b.both && v.eq < b.eq) fails.push(`${k}: 両方にある組が同じ (${v.both}) のまま回数一致が ${b.eq} → ${v.eq} (回帰)`); }
const newUnit = ud.filter((d) => !base.unitDiffs.includes(d));
if (newUnit.length) fails.push(`単位の差が新しく出た: ${newUnit.join(" / ")}`);
console.log(`\n基準値: 不一致のキー ${base.mismatchKeys} / 単位の差 ${base.unitDiffs.length}`);
if (res.diffs.length < base.mismatchKeys) console.log(`  ○ 不一致が減った (${base.mismatchKeys} → ${res.diffs.length})。--update で締めてよい`);
if (fails.length) { console.log("✗ FAIL"); for (const f of fails) console.log("  " + f); process.exit(1); }
console.log("✓ PASS (基準値より悪化なし・負のコントロール確認済み)");
