// ============================================================================
// 利用票の貸与行を KY 8222 (給付管理票) の単位で埋める — 別表の印刷が要らない行だけ (2026-11-13 H 承認)
//
//   node migrations/fill_rental_units_from_ky_single.mjs [--month 2026-06]            # DRY RUN
//   node migrations/fill_rental_units_from_ky_single.mjs [--month 2026-06] --execute  # 本番
//
// ── なぜ ──────────────────────────────────────────────────────────────────
// 貸与の単位は別表 PDF にしか品目ごとに出ないが、利用票の貸与行が 1 行で KY の貸与行も 1 行の人は、
// KY の給付計画単位数がそのままその 1 行の実額になる (別表 1 行・KY 1 行の 47/47 で一致)。
// 別表の印刷が途中で止まっても残るので、先に埋める。2026-06 の 13 拠点で 343 行 (2026-11-13 実測)。
//
// ── 判定 ── migrations/_ky_single_rental.mjs の planKySingle (検査 check:rental-units と共通)
//   人 = 利用票の利用者の、その月に有効な 居宅介護支援事業所の割当が ★ 1 つ (番号 = KY の居宅事業所番号) + 利用票の被保番
//   KY は scripts/_ky-parse.mjs の ky8222ByPerson (当初と修正の 2 本は後のファイル)
//
// ── 書くもの (--execute) ────────────────────────────────────────────────────
//   services[i].rental_month_actual_units = KY の単位 / _units_source = "ky8222_single_<YYYY-MM>"。manual_units は触らない
//   ★ 後から別表が来たら 別表が上書きする (fill_rental_units_from_betsuhyou.mjs が件数と値の変化を出す)
//   退避: migrations/_backup_fill_rental_ky_single_<時刻>.json (commit しない)
//   帳票ごとに id 指定で更新し、読み直して「その行の値 = KY の貸与合計」を確かめる (verifyKySingle)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ky8222ByPerson, kyRentalLines } from "../scripts/_ky-parse.mjs";
import { planKySingle, verifyKySingle } from "./_ky_single_rental.mjs";

const EXECUTE = process.argv.includes("--execute");
const MONTH = (() => { const i = process.argv.indexOf("--month"); return i >= 0 ? process.argv[i + 1] : "2026-06"; })();
if (!/^\d{4}-\d{2}$/.test(MONTH)) { console.error("--month は YYYY-MM"); process.exit(1); }
const YM = MONTH.replace("-", "");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const SOURCE = `ky8222_single_${MONTH}`;

async function all(build) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await build().range(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== KY 8222 の貸与 1 行 → 利用票の貸与 1 行 (${MONTH}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const [y, m] = MONTH.split("-").map(Number);
  const first = `${MONTH}-01`, last = `${MONTH}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const kyOffices = await all(() => sb.from("offices").select("id, name, business_number, service_type").eq("service_type", "居宅介護支援").order("id"));
  const bnById = new Map(kyOffices.map((o) => [o.id, o.business_number]));
  const asg = (await all(() => sb.from("client_office_assignments").select("id, client_id, office_id, start_date, end_date").in("office_id", [...bnById.keys()]).order("id")))
    .filter((r) => (!r.start_date || r.start_date <= last) && (!r.end_date || r.end_date >= first));
  const officesOf = new Map();
  for (const r of asg) (officesOf.get(r.client_id) ?? officesOf.set(r.client_id, new Set()).get(r.client_id)).add(r.office_id);
  const ky = ky8222ByPerson(path.join(KAIGO, "伝送データ"), YM);
  const docs = await all(() => sb.from("kaigo_report_documents").select("id, user_id, content").eq("report_type", "service-usage").eq("report_month", MONTH).order("id"));

  const reasons = {};
  const noKy = [];
  const plans = [];
  for (const d of docs) {
    const services = d.content?.services ?? [];
    if (!services.some((s) => ["17", "67"].includes(String(s?.category ?? "")))) continue; // 貸与の無い帳票は数えない
    const offs = officesOf.get(d.user_id);
    const insured = String(d.content?.insured_number ?? "").trim();
    let r;
    if (!offs || offs.size !== 1) r = { ok: false, reason: `居宅の割当が ${offs?.size ?? 0} 件` };
    else if (!insured) r = { ok: false, reason: "利用票に被保番なし" };
    else {
      const bn = bnById.get([...offs][0]);
      const lines = ky.get(`${bn}|${insured}`);
      if (!lines) {
        r = { ok: false, reason: "KY に居ない" };
        const rows = services.filter((s) => ["17", "67"].includes(String(s?.category ?? "")));
        if (rows.length === 1 && !(Number(rows[0].manual_units) > 0 || Number(rows[0].rental_month_actual_units) > 0))
          noKy.push(`${d.content?.user_name ?? d.user_id} 被保番 ${insured} 居宅 ${bn}`);
      } else {
        r = planKySingle(services, kyRentalLines(lines));
        if (r.ok) plans.push({ docId: d.id, name: d.content?.user_name ?? "", content: d.content, index: r.index, units: r.units, kyTotal: r.units, item: services[r.index].content });
      }
    }
    if (!r.ok) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  }

  console.log(`母数: ${MONTH} の利用票のうち 貸与行がある帳票 ${plans.length + Object.values(reasons).reduce((s, n) => s + n, 0)} 件`);
  console.log(`埋める (利用票の貸与 1 行 = KY の貸与 1 行) ${plans.length} 行 / 単位計 ${plans.reduce((s, p) => s + p.units, 0)}`);
  console.log("埋めない理由 (帳票数):");
  for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${k}  ${n}`);
  console.log(`\n■ KY に居ない (利用票の貸与 1 行・未投入) ${noKy.length} 名 — 別表にはあるが同月の KY に居ない型かもしれない (H: 拠点が揃ったらまとめて見る)`);
  for (const x of noKy) console.log(`    ${x}`);
  for (const p of plans.slice(0, 5)) console.log(`  例: ${p.name}  ${p.item}  ${p.units} 単位`);
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で 退避 → 帳票ごとに更新 → 読み直して KY と一致を確かめる。"); return; }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const backup = path.join(KAIGO, "migrations", `_backup_fill_rental_ky_single_${stamp}.json`);
  writeFileSync(backup, JSON.stringify(plans.map((p) => ({ id: p.docId, content: p.content })), null, 2));
  console.log(`退避: ${backup}`);
  let done = 0;
  for (const p of plans) {
    const services = p.content.services.map((s, i) => (i === p.index ? { ...s, rental_month_actual_units: p.units, _units_source: SOURCE } : s));
    const content = { ...p.content, services };
    const { data, error } = await sb.from("kaigo_report_documents").update({ content, updated_at: new Date().toISOString() }).eq("id", p.docId).select("id, content");
    if (error || (data ?? []).length !== 1) { console.error(`✗ 更新失敗 ${p.name}: ${error?.message ?? "件数≠1"} (ここまでは退避ファイルから戻せる)`); process.exit(1); }
    if (!verifyKySingle(data[0].content.services?.[p.index], p.kyTotal, SOURCE)) { console.error(`✗ 検算失敗 ${p.name}: 読み直した値が KY ${p.kyTotal} と違う`); process.exit(1); }
    done++;
  }
  console.log(`完了: ${done} 帳票 (読み直して KY と一致)`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
