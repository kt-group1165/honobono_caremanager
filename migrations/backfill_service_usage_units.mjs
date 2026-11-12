/**
 * 利用票 (第6表 / kaigo_report_documents.report_type='service-usage') の
 * content.services[] に **単位数 (units) と サービス種類 (category)** を
 * kaigo_service_codes から backfill する。
 *
 * ── なぜ必要か (2026-11-12 実測) ─────────────────────────────────
 * SvcRow.units は「サービスコードマスタの単位数 (1回あたり)」で、画面の
 * 「単位計 = units × 回数」と 提供票の月計、さらに区分支給限度額の判定に効く。
 * ところが EditFormServiceTicket は ★画面を開いたときにだけ★ 名前引きで
 * units を補完する設計なので、未オープンの帳票には入らない。
 *   実測: units が入っている行 = 2 / 28,441 行 (0.0%)
 *   category が入っている行    = 2 / 28,441 行 (0.0%)
 * category は isRentalRow (= category==="17" で福祉用具貸与を判定) の唯一の
 * 根拠なので、未設定だと貸与行が通常行として扱われ 単位計が 0×回数=0 になる。
 *
 * ── 単位数の決まり方 (全 28,441 行を分類した実測) ─────────────────
 *   ① 固定単位 (calculation_type='基本', units>0)      8,495 行  ← この script で入る
 *   ② 定額加減算 (units≠0)                           10,660 行  ← この script で入る
 *   ③ 率加算 (formula あり / units=0)                      0 行  (利用票に処遇改善行は無い)
 *   ④ 福祉用具貸与 (units=0 / 商品ごとの実額)          9,011 行  ← category だけ入る
 *                                                               単位数は manual_units に
 *                                                               別途入れる (商品価格なので
 *                                                               マスタからは出ない)
 *   ⑤ 同一建物減算 (units=0 / formula なし)              190 行  ← ★マスタ側の穴。別対応
 *   ⑥ 名前がマスタに無い                                  85 行  ← 自由記述・サービス種類名
 *
 * ── 名前解決の正しさ ────────────────────────────────────────────
 * ほのぼのの実物 別表 PDF (計画書一括印刷) の サービスコード + 単位数 と
 * 当方マスタを突合して 43/43 一致 (7サービス種類: 訪問介護・訪問看護・通所介護・
 * 通所リハ・福祉用具貸与・居宅療養管理指導・地域密着型通所介護。加算・減算含む)。
 * 名前→コードの解決は 単位数が一意に決まらない行 0 件 (28,341 一意 / 15 は複数コードだが
 * 単位数同一)。
 *
 * ── 実行 ────────────────────────────────────────────────────────
 *   node migrations/backfill_service_usage_units.mjs                  # DRY RUN
 *   node migrations/backfill_service_usage_units.mjs --execute
 *   node migrations/backfill_service_usage_units.mjs --month=2026-06  # 月を絞る
 *
 * ⚠ manual_units が入っている行の manual_units は触らない (手入力優先)。
 * ⚠ 世代管理: report_month に有効なコードだけを使う (valid_from/valid_until)。
 *   同月に複数世代が残る場合は valid_from が新しいほうを採る。
 * ⚠ marker: content._units_backfill = { at, n } を立てる (後から特定・巻き戻せるように)。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");
const MONTH = (process.argv.find((a) => a.startsWith("--month=")) ?? "").slice(8) || null;

const env = Object.fromEntries(
  fs.readFileSync(path.join(HERE, "..", ".env.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に無い"); process.exit(1); }
const HEADERS = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };

async function rest(q, init) {
  const r = await fetch(SB_URL + "/rest/v1/" + q, { ...init, headers: { ...HEADERS, ...(init?.headers ?? {}) } });
  const txt = await r.text();
  if (!r.ok) throw new Error("REST " + r.status + ": " + txt);
  return txt ? JSON.parse(txt) : null;
}
async function pageAll(q) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const d = await rest(q + "&limit=1000&offset=" + off);
    out.push(...d);
    if (d.length < 1000) return out;
  }
}

// ── 1. 対象の利用票 ───────────────────────────────────────────────
let q = "kaigo_report_documents?select=id,user_id,report_month,content&report_type=eq.service-usage&order=id.asc";
if (MONTH) q += "&report_month=eq." + MONTH;
const docs = await pageAll(q);
console.log("利用票 (service-usage) " + docs.length + " 件" + (MONTH ? " [" + MONTH + "]" : ""));

// ── 2. サービスコードマスタ (介護 + 総合事業) ─────────────────────
const mast = await pageAll(
  "kaigo_service_codes?select=service_code,service_name,service_category,units,calculation_type,formula,system,valid_from,valid_until"
  + "&system=in.(" + encodeURIComponent("介護") + "," + encodeURIComponent("総合事業") + ")&order=service_code.asc",
);
console.log("サービスコードマスタ " + mast.length + " 件");
const byName = new Map();
for (const m of mast) {
  const k = m.service_name.trim();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(m);
}

/** report_month に有効な世代を 1 件選ぶ (新しい valid_from を優先) */
function pickGeneration(cand, ym) {
  const m = /^(\d{4})-(\d{2})/.exec(ym ?? "") ? ym.slice(0, 7) : "2026-06";
  const first = m + "-01", last = m + "-31";
  const act = cand.filter((x) => !(x.valid_from && x.valid_from > last) && !(x.valid_until && x.valid_until < first));
  if (act.length === 0) return null;
  act.sort((a, b) => String(b.valid_from ?? "").localeCompare(String(a.valid_from ?? "")));
  return act[0];
}

/** 利用票のサービス名 → マスタ行。「30日超」接頭辞はほのぼの側の表記なので外して再試行 */
function resolve(name, ym) {
  const n = name.trim();
  const cand = byName.get(n) ?? byName.get(n.replace(/^30日超/, ""));
  return cand ? pickGeneration(cand, ym) : null;
}

// ── 3. 突合して更新 payload を作る ────────────────────────────────
const stat = { 対象doc: 0, 更新doc: 0, 行_units設定: 0, 行_category設定: 0, 行_変更なし: 0, 行_未解決: 0, 行_空: 0 };
const unresolved = new Map();
const catDist = {};
const updates = [];
const NOW = new Date().toISOString().slice(0, 10);

for (const d of docs) {
  const svcs = d.content?.services;
  if (!Array.isArray(svcs) || svcs.length === 0) continue;
  stat.対象doc++;
  let changed = 0;
  const next = svcs.map((r) => {
    const name = (r.content ?? "").trim();
    if (!name) { stat.行_空++; return r; }
    const m = resolve(name, d.report_month);
    if (!m) { stat.行_未解決++; unresolved.set(name, (unresolved.get(name) ?? 0) + 1); return r; }
    const patch = {};
    const wantUnits = Number(m.units);
    const wantCat = String(m.service_category ?? "");
    if (r.units !== wantUnits) { patch.units = wantUnits; stat.行_units設定++; }
    if (wantCat && String(r.category ?? "") !== wantCat) { patch.category = wantCat; stat.行_category設定++; }
    if (Object.keys(patch).length === 0) { stat.行_変更なし++; return r; }
    catDist[wantCat] = (catDist[wantCat] ?? 0) + 1;
    changed++;
    // ⚠ manual_units / rental_period_type / rental_days / planned / actual は触らない
    return { ...r, ...patch };
  });
  if (changed === 0) continue;
  stat.更新doc++;
  updates.push({
    id: d.id,
    content: { ...d.content, services: next, _units_backfill: { at: NOW, n: changed } },
  });
}

console.log("");
console.log("=== 突合結果 ===");
for (const [k, v] of Object.entries(stat)) console.log("  " + String(v).padStart(7) + "  " + k);
console.log("");
console.log("サービス種類別の更新行数: " + JSON.stringify(Object.fromEntries(Object.entries(catDist).sort((a, b) => b[1] - a[1]))));
if (unresolved.size) {
  console.log("");
  console.log("--- 名前が解決できなかった " + unresolved.size + " 種 (上位20) ---");
  for (const [n, c] of [...unresolved].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log("  " + String(c).padStart(4) + "  [" + (n.length > 50 ? n.slice(0, 50) + "…" : n) + "]");
  }
}

// ── 4. 書き込み ───────────────────────────────────────────────────
if (!EXECUTE) {
  console.log("");
  console.log("*** DRY RUN *** 更新する帳票 " + updates.length + " 件。実行するには --execute を付ける");
  process.exit(0);
}
console.log("");
console.log("更新開始 (" + updates.length + " 件)…");
let done = 0, failed = 0;
for (const u of updates) {
  try {
    await rest("kaigo_report_documents?id=eq." + u.id, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ content: u.content }),
    });
    done++;
  } catch (e) {
    failed++;
    console.error("  FAILED id=" + u.id + ": " + (e instanceof Error ? e.message : e));
    if (failed > 20) { console.error("失敗が 20 件を超えたので中断"); break; }
  }
  if (done % 200 === 0) console.log("  " + done + " / " + updates.length);
}
console.log("");
console.log("完了: 更新 " + done + " 件 / 失敗 " + failed + " 件");
if (failed) process.exit(2);
