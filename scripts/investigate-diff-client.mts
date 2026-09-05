/**
 * ⚠ 調査用・常設でない (2026-09-05 分類)。INSURED=<被保険者番号> を指定して個別に
 *   使うピンポイント調査ツール。固定の既定引数が無いため npm alias は付けない。
 *
 * 突合で差が出た利用者を、当方 / ほのぼの稼働 (MEISAI) / ほのぼの請求 (一覧CSV) の
 * **3 つの材料**で日別に並べる (READ ONLY)
 *
 *   AREA=いすみ INSURED=0000626195 npx tsx scripts/investigate-diff-client.mts
 *   AREA=袖ケ浦 INSURED=2290134465 npx tsx scripts/investigate-diff-client.mts
 *
 * ── なぜ 3 つ並べるか ────────────────────────────────────────────────────
 *   「当方が多い」だけでは、次のどれかが決まらない:
 *     a 当方の実績が重複している        → 取込の冪等性 (memory feedback_import_delete_month_scope)
 *     b ほのぼのが請求していない日がある → ★ ほのぼの側の請求漏れかもしれない
 *     c 自費・他事業所請求              → 正当に差が出る
 *   MEISAI (稼働=ヘルパーが動いた記録) と 一覧CSV (請求した記録) を分けて見ると、
 *   「動いたが請求していない」= b と「動いていない」= a が区別できる。
 *
 * ★ この検査が証明しないこと (ルール 3-1):
 *   - どちらが正しいか。**材料を並べるだけ**で判断はしない
 *   - MEISAI は **勤務実績であって請求実績ではない** (memory)。金額も賃金であって請求額ではない
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import iconv from "iconv-lite";

const AREA = process.env.AREA ?? "いすみ";
const INSURED = (process.env.INSURED ?? "").trim();
const MONTH = process.env.MONTH ?? "2026-06";
const YM = MONTH.replace("-", "");
if (!INSURED) { console.error("INSURED= を指定してください"); process.exit(1); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const readSjis = (p: string) => iconv.decode(readFileSync(p), "Shift_JIS");
// ⚠ 一覧CSV は **ヘッダも値も " で囲まれている**。剥がさないと番号一致が全部外れる
//   (最初これで 0 行になり「一覧に居ない」と読み違えかけた)
const unq = (s: string) => (s ?? "").replace(/^﻿/, "").replace(/^"|"$/g, "").trim();
const splitCsv = (t: string) =>
  t.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split(",").map(unq));
// ⚠ MEISAI の日付は 2026/06/02、当方は 2026-06-02。揃えないと日別が全部ズレる
const normDate = (s: string) => (s ?? "").replace(/\//g, "-").trim();

async function main() {
  console.log(`=== ${AREA} / 被保険者番号 ${INSURED} / ${MONTH} ===\n`);

  // ── 1. 当方 ─────────────────────────────────────────────
  const { data: certs, error: ce } = await sb
    .from("client_insurance_records")
    .select("client_id, insured_number, insurer_number, care_level, certification_start_date, certification_end_date")
    .eq("insured_number", INSURED);
  if (ce) throw new Error("認定: " + ce.message);
  const rows = certs ?? [];
  console.log(`当方の認定 ${rows.length} 件`);
  for (const r of rows) {
    console.log(`  client=${r.client_id} 保険者${r.insurer_number} ${r.care_level} ${r.certification_start_date}〜${r.certification_end_date}`);
  }
  const clientIds = [...new Set(rows.map((r) => r.client_id as string))];
  if (clientIds.length === 0) {
    console.log("★ 当方に認定が無い = 番号で引けない。clients を氏名で探す必要がある");
  }
  let name = "(不明)";
  if (clientIds.length > 0) {
    const { data: cs } = await sb.from("clients").select("id, name, user_number").in("id", clientIds);
    for (const c of cs ?? []) { name = c.name as string; console.log(`  氏名 ${c.name} / 利用者番号 ${c.user_number}`); }
  }

  // 当方の実績 (日別・サービス別)
  const byDay = new Map<string, string[]>();
  const byName = new Map<string, number>();
  let total = 0;
  if (clientIds.length > 0) {
    const { data: sch, error: se } = await sb
      .from("kaigo_visit_schedule")
      .select("visit_date, service_type, status, system, start_time, end_time, billable, cancelled_at")
      .in("user_id", clientIds)
      .gte("visit_date", `${MONTH}-01`)
      // ⚠ `-31` 決め打ちは 6 月等で "date/time field value out of range" になる。
      //   翌月 1 日未満で取る (toISOString は使わない — memory feedback_toisostring_jst_offset)
      .lt("visit_date", `${MONTH.slice(0, 4)}-${String(Number(MONTH.slice(5, 7)) + 1).padStart(2, "0")}-01`)
      .order("visit_date");
    if (se) throw new Error("実績: " + se.message);
    for (const s of (sch ?? []) as Record<string, string>[]) {
      if (s.status !== "completed") continue;
      total++;
      const d = s.visit_date;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(`${(s.start_time ?? "").slice(0, 5)}-${(s.end_time ?? "").slice(0, 5)} ${s.service_type}${s.system && s.system !== "介護" ? `[${s.system}]` : ""}`);
      byName.set(s.service_type, (byName.get(s.service_type) ?? 0) + 1);
    }
  }
  console.log(`\n当方の実績 (status=completed) ${total} 件`);
  for (const [n, c] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(3)}回  ${n}`);

  // ── 2. ほのぼの 稼働 (MEISAI) ────────────────────────────
  const meisaiDir = join(__dirname, "..", "サービス実績データ", AREA, YM, "訪問介護", "介護");
  const meiDays = new Map<string, string[]>();
  let meiTotal = 0;
  if (existsSync(meisaiDir)) {
    for (const f of readdirSync(meisaiDir).filter((f) => /^MEISAI/i.test(f))) {
      const lines = splitCsv(readSjis(join(meisaiDir, f)));
      const head = lines[0];
      const iIns = head.findIndex((h) => h.includes("被保険者番号"));
      const iName = head.findIndex((h) => h.includes("利用者名") || h.includes("氏名"));
      const iDate = head.findIndex((h) => h.includes("サービス提供日") || h.includes("日付") || h === "年月日");
      const iSvc = head.findIndex((h) => h.includes("サービス名"));
      // ⚠ 「開始」で拾うと **開始日 (2026/06/01)** に当たる。時刻は「派遣開始時間」。
      //   最初これで日別の行に日付が並び、時刻の比較になっていなかった。
      const iSt = head.findIndex((h) => h.includes("派遣開始"));
      const iEd = head.findIndex((h) => h.includes("派遣終了"));
      for (const c of lines.slice(1)) {
        const ins = iIns >= 0 ? (c[iIns] ?? "").trim() : "";
        const nm = iName >= 0 ? (c[iName] ?? "").trim() : "";
        const hit = (ins && ins === INSURED) || (name !== "(不明)" && nm && nm.replace(/[\s　]/g, "") === name.replace(/[\s　]/g, ""));
        if (!hit) continue;
        meiTotal++;
        const d = normDate(c[iDate] ?? "");
        if (!meiDays.has(d)) meiDays.set(d, []);
        meiDays.get(d)!.push(`${(c[iSt] ?? "").trim()}-${(c[iEd] ?? "").trim()} ${(c[iSvc] ?? "").trim()}`);
      }
    }
  }
  console.log(`\nほのぼの 稼働 (MEISAI) ${meiTotal} 件 ${existsSync(meisaiDir) ? "" : "★ フォルダが無い"}`);
  if (meiTotal === 0 && existsSync(meisaiDir)) {
    console.log("  ★ 0 件。被保険者番号でも氏名でも当たらない → 列の位置か氏名表記を確認すること");
  }

  // ── 3. ほのぼの 請求 (一覧CSV) ───────────────────────────
  const listPath = join(meisaiDir, "介護請求(明細付)_一覧.CSV");
  let listRows = 0;
  if (existsSync(listPath)) {
    const lines = splitCsv(readSjis(listPath));
    const head = lines[0];
    const at = (n: string) => head.findIndex((h) => h === n);
    const [iIns, iTeikyo, iSeikyu, iJotai, iTsuki, iTani, iAmt] =
      ["被保険者番号", "提供年月", "請求年月", "状態", "月遅", "保険単位数", "保険請求額"].map(at);
    console.log(`ほのぼの 請求 (一覧CSV)`);
    if (iIns < 0) console.log("  ★ 被保険者番号の列が見つからない = 測れていない");
    for (const c of lines.slice(1)) {
      if (iIns < 0 || c[iIns] !== INSURED) continue;
      listRows++;
      console.log(`  提供${c[iTeikyo]} 請求${c[iSeikyu] || "★空(未発行)"} 状態=${c[iJotai]} 月遅=${c[iTsuki] || "-"} 保険単位=${c[iTani]} 請求額=${c[iAmt]}`);
    }
    if (listRows === 0) console.log(`  ★ 0 行 — この一覧に居ない (分母 ${lines.length - 1} 行)`);
  } else console.log("ほのぼの 請求 (一覧CSV) ★ ファイルが無い");

  // ── 4. 日別に並べる ─────────────────────────────────────
  console.log(`\n=== 日別 (当方 / ほのぼの稼働) ===`);
  const days = [...new Set([...byDay.keys(), ...meiDays.keys()])].sort();
  for (const d of days) {
    const a = byDay.get(d) ?? [];
    const b = meiDays.get(d) ?? [];
    const mark = a.length === b.length ? " " : "★";
    console.log(`${mark} ${d}  当方${String(a.length).padStart(2)} / ほ${String(b.length).padStart(2)}`);
    if (a.length !== b.length) {
      for (const x of a) console.log(`      当方: ${x}`);
      for (const x of b) console.log(`      ほ  : ${x}`);
    }
  }
  console.log(`\n合計  当方 ${total} 件 / ほのぼの稼働 ${meiTotal} 件`);
  console.log(`\n⚠ MEISAI は **勤務実績であって請求実績ではない**。自費・他事業所請求が正当にありうる。`);
  console.log(`⚠ この出力は材料。どちらが正しいかは決めない。`);
}

main().catch((e) => { console.error(e); process.exit(1); });
