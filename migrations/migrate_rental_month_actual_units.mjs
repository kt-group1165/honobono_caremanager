// ============================================================================
// 利用票の貸与行で、別表由来の「その月の実額」を manual_units から rental_month_actual_units へ移す
//
//   node migrations/migrate_rental_month_actual_units.mjs            # DRY RUN
//   node migrations/migrate_rental_month_actual_units.mjs --execute  # 本番 (H / user 判断)
//
// ── なぜ ──────────────────────────────────────────────────────────────────
// manual_units は「1 月あたりの単価 (按分前)」で、画面は日付の印から 1月/半月 を判定して按分する。
// 2026-11-13 に fill_rental_units_from_betsuhyou.mjs が別表の「その月の実額」(半月なら半額) を
// 同じ manual_units に入れ、_units_period="month_actual" で区別した (286 行)。
// タグは編集で消えず付け直されないので、印を変えると半額をさらに半分にしうる。
// → 意味ごとに列を分ける (src/lib/rental-units.ts。H 判断 2026-11-13)。
//
// ── 対象 ──────────────────────────────────────────────────────────────────
// kaigo_report_documents (report_type=service-usage) の services[] のうち
//   category が 17/67 かつ _units_period === "month_actual" の行
//
// ── 書くもの (--execute) ──────────────────────────────────────────────────
//   rental_month_actual_units = 元の manual_units / manual_units = null / _units_period は消す
//   _units_source は残す (出どころの記録)
//   content._rental_month_actual_migrated = { at, n } (marker)
//   ★ 既に rental_month_actual_units がある行は対象外 (二重実行で上書きしない)
//   --execute の前に対象帳票の content を JSON に退避 (migrations/_backup_migrate_rental_month_actual_<時刻>.json・commit しない)
//   更新は帳票ごとに id 指定で、読み直した content の件数を確かめる。
//
// ── 表示は変わらない ────────────────────────────────────────────────────────
// 2026-11-13 時点の 286 行は全行、印の判定が予定・実績とも「1月」なので、旧画面は manual_units をそのまま表示していた。
// 新画面は rental_month_actual_units をそのまま表示する。DRY RUN で行ごとに前後の表示値を比べ、違えば止める。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const RENTAL = new Set(["17", "67"]);
const isTarget = (s) => RENTAL.has(String(s.category ?? "")) && s._units_period === "month_actual"
  && Number(s.manual_units) > 0 && !(Number(s.rental_month_actual_units) > 0);

// 旧画面の表示 (src/lib/rental-units.ts の旧 rentalMonthlyUnits と同じ判定)。前後一致の確認だけに使う
const dim = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
function oldPeriod(marks, ym) {
  const n = dim(ym); const d = [];
  for (let i = 0; i < Math.min(n, (marks ?? []).length); i++) if (marks[i]) d.push(i + 1);
  if (!d.length) return "1month";
  const f = d[0], l = d[d.length - 1];
  if (d.length === 1) return f === 1 || f === n ? "1month" : (n - f + 1 >= 16 ? "1month" : "half_month");
  if (f === 1 && l === n) return "1month";
  if (f === 1 || l === n) return l - f + 1 >= 16 ? "1month" : "half_month";
  return "half_month";
}
const oldShown = (s, ym, kind) => { const u = Number(s.manual_units); return oldPeriod(kind === "planned" ? s.planned : s.actual, ym) === "1month" ? Math.round(u) : Math.round(u * 0.5); };

async function main() {
  console.log(`=== 貸与の別表実額を rental_month_actual_units へ移す ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const docs = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("kaigo_report_documents").select("id, user_id, report_month, content")
      .eq("report_type", "service-usage").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    docs.push(...data);
    if (data.length < 1000) break;
  }
  const plans = [];
  let rows = 0, changedDisplay = 0;
  const bySource = {};
  for (const d of docs) {
    const svcs = d.content?.services ?? [];
    const idx = svcs.map((s, i) => (isTarget(s) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    for (const i of idx) {
      const s = svcs[i];
      rows++;
      bySource[s._units_source ?? "(なし)"] = (bySource[s._units_source ?? "(なし)"] ?? 0) + 1;
      for (const kind of ["planned", "actual"]) if (oldShown(s, d.report_month, kind) !== Math.round(Number(s.manual_units))) {
        changedDisplay++;
        console.log(`  ⚠ 表示が変わる: ${d.id} ${d.report_month} ${s.content} 旧 ${oldShown(s, d.report_month, kind)} / 新 ${Math.round(Number(s.manual_units))} (${kind})`);
      }
    }
    plans.push({ id: d.id, content: d.content, idx });
  }
  const leftover = docs.reduce((n, d) => n + (d.content?.services ?? []).filter((s) => s._units_period === "month_actual" && !isTarget(s)).length, 0);
  console.log(`利用票 ${docs.length} 件を読んだ`);
  console.log(`移す 帳票 ${plans.length} 件 / 行 ${rows}  出どころ別 ${JSON.stringify(bySource)}`);
  console.log(`_units_period=month_actual だが対象外 (manual_units 空 / 既に移し済み) ${leftover} 行`);
  console.log(`表示が変わる行 ${changedDisplay}`);
  if (changedDisplay) { console.error("✗ 表示が変わる行がある。移すと画面の数字が変わるので止める"); process.exit(2); }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で 退避 → 帳票ごとに更新 → 読み直して検算。"); return; }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 19) /* ミリ秒まで: 同じ分に 2 本流すと退避が上書きされた (2026-11-13) */;
  const backup = path.join(KAIGO, "migrations", `_backup_migrate_rental_month_actual_${stamp}.json`);
  writeFileSync(backup, JSON.stringify(plans.map((p) => ({ id: p.id, content: p.content })), null, 2));
  console.log(`退避: ${backup}`);
  let done = 0;
  for (const p of plans) {
    const services = p.content.services.map((s, i) => {
      if (!p.idx.includes(i)) return s;
      const { _units_period: _drop, ...rest } = s; // eslint-disable-line @typescript-eslint/no-unused-vars
      return { ...rest, rental_month_actual_units: Number(s.manual_units), manual_units: null };
    });
    const content = { ...p.content, services, _rental_month_actual_migrated: { at: new Date().toISOString().slice(0, 10), n: p.idx.length } };
    const { data, error } = await sb.from("kaigo_report_documents").update({ content, updated_at: new Date().toISOString() }).eq("id", p.id).select("id, content");
    if (error || (data ?? []).length !== 1) { console.error(`✗ 更新失敗 ${p.id}: ${error?.message ?? "件数≠1"} (ここまでは退避ファイルから戻せる)`); process.exit(1); }
    const got = data[0].content.services.filter((s) => Number(s.rental_month_actual_units) > 0 && s.manual_units == null && s._units_period == null).length;
    if (got < p.idx.length) { console.error(`✗ 検算失敗 ${p.id}: ${got} / ${p.idx.length}`); process.exit(1); }
    done++;
  }
  console.log(`完了: ${done} 帳票 / ${rows} 行`);
  console.log("確認: もう一度 DRY RUN して「移す 行 0」「_units_period=month_actual … 0 行」になること");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
