/**
 * 利用票 (第6表) の 福祉用具貸与行 に 1 月あたりの単位数 (manual_units) を投入する。
 *
 * ── なぜ必要か ──────────────────────────────────────────────────
 * 福祉用具貸与の単位数は「商品ごとの実額」なので kaigo_service_codes には入らない
 * (マスタの units は 0)。利用票の画面は `manual_units` を見て月額を出す:
 *
 *   src/app/(authenticated)/reports/[type]/reports-content.tsx:698
 *     rentalMonthlyUnits(svc, ym, kind)
 *       units  = svc.manual_units
 *       period = autoRentalPeriodType(marks, ym)     // 日付マークから 1月/半月 を自動判定
 *       return period === "1month" ? round(units) : round(units * 0.5)
 *
 * ★ つまり manual_units に入れるべきは **按分前の 1 月あたり単位数**。
 *   按分後の値を入れると半月の行で 0.5 が二重に掛かる。
 *
 * 実測 (2026-11-12): 貸与行 9,006 行のうち manual_units が入っているのは 1 行だけ。
 *
 * ── 出どころと ★循環について ────────────────────────────────────
 * 入力は `_session_share/fukuyogu_units_202606.csv` (★福祉用具新ソフト セッションが
 * ほのぼの福祉用具の「明細書明細付」KDS0031 から作成)。
 * ⚠ これは **請求の出力**であって計画ではない。これで利用票 (計画) を埋めるのは
 *   memory `feedback_migration_from_input_not_billing_output` の循環にあたる。
 *   そのため投入した行には `_units_source` を立て、**検証の分母から外せるように**する。
 *   本来の出どころは ほのぼの居宅側の 利用票別表。そちらが取れたら差し替える。
 *
 * ⚠ カバー範囲は狭い。ほのぼの福祉用具 DB は全件ケアサポ番号 (1272400050) で請求して
 *   いるため、自社でも Hanaムツミ/リンクス/千葉ムツミ高品/Hana花見川 の行は入っていない。
 *   実測: 2026-06 の貸与行 7,837 行のうち (client_id × サービス項目) で一致するのは
 *   1,204 行 (15.4%)、全部 "介護ｼｮｯﾌﾟｹｱ・ｻﾎﾟｰﾄ千葉"。
 *
 * ── 按分前の値の復元 (★ CSV に按分前の列が無いため) ──────────────
 * CSV の `単位数` は按分後。同じ TAIS の「日数>=16 の行の単位数」が按分前の満額。
 * 実データで検算済み (5,251 行):
 *   日数>=16 で満額どおり          4,921
 *   日数>=16 なのに違う                2   (同一 TAIS で単価が 2 種ある 1 商品)
 *   日数<=15 で round(満額 * 0.5)    302
 *   日数<=15 で floor/ceil のみ         0   ← ★ ほのぼのは round。floor·ceil ではない
 *   日数<=15 でどちらでもない           7   (日数 11〜14 なのに満額。中止・再開等と思われる)
 *   満額が取れない (全行 <=15)         19
 * → 境界は **日数 16 日**。当方の autoRentalPeriodType (利用日数 >=16 → 1月) と一致する。
 * ⚠ 満額が取れない TAIS の行は **投入しない** (×2 の逆算は round の逆が一意でないため)。
 *
 * ── 実行 ────────────────────────────────────────────────────────
 *   node migrations/backfill_rental_units_from_fukuyogu.mjs            # DRY RUN
 *   node migrations/backfill_rental_units_from_fukuyogu.mjs --execute
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");
const MONTH = "2026-06";
const CSV = path.join(HERE, "..", "..", "..", "_session_share", "fukuyogu_units_202606.csv");
const SOURCE_TAG = "fukuyogu_meisai_202606";
// ★ manual_units の意味を行に残す。出どころで意味が違うため (2026-11-13)。
//   monthly_rate  = 按分前の「1 月あたりの単価」。この script が入れる値
//   ★ 2026-11-13 更新: 「その月の実額」は ★ manual_units には入れないことにした。
//     列を分けて `rental_month_actual_units` に入れる (migrate_rental_month_actual_units.mjs)。
//     理由: 別表由来の値は「その月の実額」で、画面 (rentalMonthlyUnits) は manual_units を
//     月額とみなして日付の印から 1月/半月 を判定し半分にするため、★ 意味が衝突する。
//     しかも ★ 画面は貸与行に切り替えた瞬間に「1 日に印」を自動で付ける (rentalSwitchOn) ので、
//     ★ 「印が 1 日目だけ」は既定値であって「1 か月まるごと」の証拠にならない。
//     → ★ この script が入れるのは monthly_rate (単価) だけ。実額は別キー。
//   ⚠ `_units_period` は移行後は不要になる (列で意味が表せるため)。
//     移し替え script が betsuhyou 由来の行から消す。
const PERIOD_TAG = "monthly_rate";

const env = Object.fromEntries(
  fs.readFileSync(path.join(HERE, "..", ".env.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error(".env.local に Supabase の URL / SERVICE_ROLE_KEY が無い"); process.exit(1); }
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

/** 引用符付き CSV を素直に読む */
function parseCsv(text) {
  const rows = [];
  let cur = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(f); f = ""; }
    else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  return rows;
}

if (!fs.existsSync(CSV)) { console.error("入力 CSV が無い: " + CSV); process.exit(1); }
const rows = parseCsv(fs.readFileSync(CSV, "utf8").replace(/^﻿/, ""));
const hdr = rows[0];
const ix = (n) => { const i = hdr.indexOf(n); if (i < 0) throw new Error("CSV に列が無い: " + n); return i; };
const data = rows.slice(1).filter((r) => r.length >= hdr.length);
console.log("入力 CSV " + data.length + " 行 (" + path.basename(CSV) + ")");

// ── 1. 按分前の「月額単位数」を決める ─────────────────────────────
// ★ 2026-11-12 更新: CSV に `月額単位数` 列 (ほのぼの自身の用具マスタ FYGMST01 の値) が
//   追加されたので、★ それを第一の出どころにする。
//   当初は「同じ TAIS の 日数>=16 の行の単位数」から復元していたが、実測で 1,185/1,197
//   (99.0%) しか合わなかった。外した 12 件はすべて ★ 同じ TAIS に複数の単価がある商品で、
//   復元側が別の利用者の高い単価を拾っていた (例 00254-000095 ベスポジeト型跳上1200
//   復元 340 / マスタ 470)。★ マスタの値が正。復元はフォールバックとしてだけ残す。
const fullUnits = new Map();   // TAIS → 復元値 (フォールバック用)
for (const r of data) {
  const tais = r[ix("TAIS")] || ("名:" + r[ix("用具名")]);
  const d = Number(r[ix("日数")]);
  const u = Number(r[ix("単位数")]);
  if (!Number.isFinite(d) || !Number.isFinite(u) || d < 16) continue;
  const prev = fullUnits.get(tais);
  if (prev == null) fullUnits.set(tais, u);
  else if (prev !== u) fullUnits.set(tais, Math.max(prev, u));
}
const HAS_MONTHLY = hdr.includes("月額単位数");
console.log("月額単位数 列: " + (HAS_MONTHLY ? "あり (これを使う)" : "なし (日数>=16 から復元する)")
  + " / 復元できた TAIS " + fullUnits.size + " 種");

// ── 2. (client_id, サービス項目) → 満額単位数 ─────────────────────
// 月遅れの出し直しは「後の請求年月」を採る
const best = new Map();
let noCid = 0, noFull = 0, ambiguous = 0;
for (const r of data) {
  const cid = r[ix("client_id")];
  if (!cid) { noCid++; continue; }
  const tais = r[ix("TAIS")] || ("名:" + r[ix("用具名")]);
  // ★ 日割区分が「要確認(...)」の行は投入しない。
  //   同じ TAIS に「片方がもう片方のちょうど半分」の単価が両方あり、日数だけでは決まらない。
  const kubun = HAS_MONTHLY ? String(r[ix("日割区分")] ?? "") : "";
  if (HAS_MONTHLY && !/^全額$|^半額$/.test(kubun)) { ambiguous++; continue; }
  const monthly = HAS_MONTHLY ? Number(r[ix("月額単位数")]) : NaN;
  const full = Number.isFinite(monthly) && monthly > 0 ? monthly : fullUnits.get(tais);
  if (full == null) { noFull++; continue; }   // 月額が無く復元もできない。逆算はしない
  const k = cid + "||" + r[ix("サービス項目")];
  const pm = r[ix("請求年月")];
  const prev = best.get(k);
  if (!prev || pm > prev.pm) best.set(k, { pm, full, tais, equip: r[ix("用具名")] });
}
console.log("client_id 無し " + noCid + " 行 / 月額が取れず除外 " + noFull + " 行 / 日割区分が要確認で除外 " + ambiguous + " 行 / 突合キー " + best.size + " 件");

// ── 3. 利用票の貸与行に当てる ─────────────────────────────────────
const docs = await pageAll(
  "kaigo_report_documents?select=id,user_id,report_month,content"
  + "&report_type=eq.service-usage&report_month=eq." + MONTH + "&order=id.asc",
);
console.log("利用票 (" + MONTH + ") " + docs.length + " 件");

const stat = { 貸与行: 0, 投入: 0, 既に同値: 0, 手入力を尊重: 0, CSVに無い: 0 };
const provMiss = new Map();
const updates = [];
const NOW = new Date().toISOString().slice(0, 10);

for (const d of docs) {
  const svcs = d.content?.services;
  if (!Array.isArray(svcs)) continue;
  let changed = 0;
  const next = svcs.map((r) => {
    if (String(r.category ?? "") !== "17") return r;
    stat.貸与行++;
    const hit = best.get(d.user_id + "||" + (r.content ?? "").trim());
    if (!hit) {
      stat.CSVに無い++;
      const p = (r.provider ?? "(空)").trim() || "(空)";
      provMiss.set(p, (provMiss.get(p) ?? 0) + 1);
      return r;
    }
    // ★ 既に手で入れた値があれば触らない (この script 由来のものを除く)
    if (r.manual_units != null && Number(r.manual_units) > 0 && r._units_source !== SOURCE_TAG) {
      stat.手入力を尊重++;
      return r;
    }
    if (Number(r.manual_units) === hit.full && r._units_source === SOURCE_TAG
        && r._units_period === PERIOD_TAG) { stat.既に同値++; return r; }
    // ★ 値が変わった場合 (月額単位数 列の追加で復元値から差し替わる等) は上書きする
    stat.投入++;
    changed++;
    return { ...r, manual_units: hit.full, _units_source: SOURCE_TAG, _units_period: PERIOD_TAG, _units_tais: hit.tais };
  });
  if (changed === 0) continue;
  updates.push({ id: d.id, content: { ...d.content, services: next, _rental_units_backfill: { at: NOW, n: changed, source: SOURCE_TAG } } });
}

console.log("");
console.log("=== 突合結果 (" + MONTH + ") ===");
for (const [k, v] of Object.entries(stat)) console.log("  " + String(v).padStart(6) + "  " + k);
console.log("");
console.log("--- CSV に無い貸与行の提供事業所 上位12 ---");
for (const [p, c] of [...provMiss].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log("  " + String(c).padStart(5) + "  " + p);

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
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ content: u.content }),
    });
    done++;
  } catch (e) {
    failed++;
    console.error("  FAILED id=" + u.id + ": " + (e instanceof Error ? e.message : e));
    if (failed > 20) { console.error("失敗が 20 件を超えたので中断"); break; }
  }
  if (done % 100 === 0) console.log("  " + done + " / " + updates.length);
}
console.log("");
console.log("完了: 更新 " + done + " 件 / 失敗 " + failed + " 件");
if (failed) process.exit(2);
