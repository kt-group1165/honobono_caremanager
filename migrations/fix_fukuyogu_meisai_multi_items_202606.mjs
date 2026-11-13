// ============================================================================
// ケアサポ明細 (fukuyogu_meisai_202606) で入れた利用票の貸与行のうち、同じ品目を複数本借りている人を直す (2026-11-13 H 承認)
//
//   node migrations/fix_fukuyogu_meisai_multi_items_202606.mjs            # DRY RUN (値が変わる行 / 変わらない行 を出す)
//   node migrations/fix_fukuyogu_meisai_multi_items_202606.mjs --execute  # 本番 (★ DRY RUN を H に見せてから)
//
// ── なぜ ──────────────────────────────────────────────────────────────────
// backfill_rental_units_from_fukuyogu.mjs (v1) は (利用者, 品目) ごとに ★ 商品を 1 本だけ残して、その品目の利用票の行に入れていた。
// 同じ品目を複数本借りている人は 1 本分しか入らず (利用票 1 行)、利用票に同じ品目の行が複数あると全行に最初の 1 本の値が入った。
// ちはら台の 11 名で KY 8222 = 別表 > 利用票 を確認 (11/11)。2026-06 で 1,204 行中 664 行 / 217 名が該当、過少 41,944 単位 (按分前の月額)。
//
// ── 直し方 (H 承認) ─────────────────────────────────────────────────────────
// 値は ケアサポ明細 CSV の「単位数」= ★ 按分後のその月の実額 → rental_month_actual_units (印で按分しない)。manual_units は空にする。
//   (同じ商品に月遅れの出し直しがあるときは 後の請求年月の行を採る。v1 と同じ)
//   利用票 1 行 / 商品 n 本 (n≥2) → その品目の全商品の合計を 1 行に (ほのぼのの別表と同じまとめ方)
//   利用票 n 行 / 商品 n 本       → 利用票の行に TAIS があれば 1 対 1。無ければ 印が全行同じなら値の集合 (いすみ 280/280 で裏が取れた規則)
//   上のどれにも当たらない (行数 ≠ 本数・印が行ごとに違う) → 書かない (一覧に出す)
//   商品が 1 本の品目は v1 の値のまま触らない (v1 の誤りは複数本のときだけ)
// ★ 人ごとの検算: その人の ケアサポ明細の全商品の実額の合計 (種類 17/67) = KY 8222 のケアサポ (1272400050) の行の合計。
//   合わない / KY に居ない人は ★ 何も書かない (一覧に出す)
// _units_source = "fukuyogu_meisai_v2_2026-06" (v1 で入れた行と区別できるように)。4〜8 月はまだ触らない (H 指示)
// --execute の前に対象帳票の content を退避 (migrations/_backup_fix_fukuyogu_v2_<時刻>.json・commit しない)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ky8222ByPerson, kyRentalLines } from "../scripts/_ky-parse.mjs";

const EXECUTE = process.argv.includes("--execute");
const NEG_V1 = process.argv.includes("--negative-control-v1"); // 負のコントロール: 1 本だけ残す v1 の値で検算する
const MONTH = "2026-06";
const SOURCE = `fukuyogu_meisai_v2_${MONTH}`;
const CARESAPO = "1272400050";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const CSV = path.join(KAIGO, "..", "..", "_session_share", "fukuyogu_units_202606.csv");
const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

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
const RENTAL = new Set(["17", "67"]);
const isV1 = (s) => s?._units_source === `fukuyogu_meisai_${MONTH.replace("-", "")}`;
const marksKey = (s) => JSON.stringify([s.planned ?? [], s.actual ?? []]);
const normT = (v) => (v ? String(v).normalize("NFKC").replace(/[\s　]/g, "") : null);

// ── 1. CSV: (client_id, 品目) → 商品ごとの実額 (後の請求年月の行) ──
function readCsv() {
  const txt = readFileSync(CSV, "utf8").replace(/^﻿/, "");
  const rows = [];
  for (const l of txt.split(/\r?\n/)) { if (l) rows.push(l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, ""))); }
  const h = rows.shift(); const ix = (k) => h.indexOf(k);
  const latest = new Map(); // `${cid}|${item}|${tais}` → { pm, units, cid, item, tais }
  for (const r of rows) {
    if (r[ix("提供年月")] !== MONTH.replace("-", "/")) continue;
    const cid = r[ix("client_id")]; if (!cid) continue;
    const item = r[ix("サービス項目")]; const tais = r[ix("TAIS")] || `名:${r[ix("用具名")]}`;
    const pm = r[ix("請求年月")]; const units = Number(r[ix("単位数")]) || 0; const code = r[ix("サービス項目コード")];
    const k = `${cid}|${item}|${tais}`; const prev = latest.get(k);
    if (!prev || pm > prev.pm) latest.set(k, { pm, units, cid, item, tais, code, monthly: Number(r[ix("月額単位数")]) || 0 });
    else if (pm === prev.pm) prev.units += units; // 同じ請求年月に同じ商品が 2 行 (月の途中の入れ替え等) は足す
  }
  const byItem = new Map(); // `${cid}|${item}` → products[]
  for (const p of latest.values()) { const k = `${p.cid}|${p.item}`; (byItem.get(k) ?? byItem.set(k, []).get(k)).push(p); }
  return byItem;
}

async function main() {
  console.log(`=== ケアサポ明細 v2: 同じ品目を複数本借りている人の貸与行を直す (${MONTH}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"}${NEG_V1 ? " ★ 負のコントロール (v1 の値で検算)" : ""} ===\n`);
  const byItem = readCsv();
  const ky = ky8222ByPerson(path.join(KAIGO, "伝送データ"), MONTH.replace("-", ""));
  const kyByInsured = new Map(); // ケアサポの居宅でない人もいるので 被保番だけで引けるようにする (同じ被保番が複数の居宅に居れば使わない)
  for (const [k, lines] of ky) { const ins = k.split("|")[1]; (kyByInsured.get(ins) ?? kyByInsured.set(ins, []).get(ins)).push(lines); }
  const docs = await all(() => sb.from("kaigo_report_documents").select("id, user_id, content").eq("report_type", "service-usage").eq("report_month", MONTH).order("id"));

  const st = { 対象の人: 0, 対象の行_v1: 0, 変わらない行_1本: 0, 変わる行: 0, 値が同じ行: 0 };
  const types = { "1行/n本 → 合計": 0, "n行/n本 → TAIS で 1 対 1": 0, "n行/n本 → 値の集合 (印が全行同じ)": 0 };
  const skipPeople = [], skipGroups = [], examples = [];
  const plans = [];
  for (const d of docs) {
    const services = d.content?.services ?? [];
    const v1rows = services.map((s, i) => ({ s, i })).filter(({ s }) => RENTAL.has(String(s.category ?? "")) && isV1(s));
    if (!v1rows.length) continue;
    st.対象の人++; st.対象の行_v1 += v1rows.length;
    const name = d.content?.user_name ?? d.user_id;
    // 人ごとの検算: ケアサポ明細の全商品 (この人の全品目) の実額の合計 vs KY のケアサポの行
    const myItems = [...byItem.entries()].filter(([k]) => k.startsWith(`${d.user_id}|`));
    const csvTotal = myItems.reduce((t, [, ps]) => t + ps.reduce((a, p) => a + p.units, 0), 0);
    // 負のコントロール: v1 と同じく 品目ごとに 1 本だけ (最初の商品) で数えると KY と合わなくなるはず
    const v1Total = myItems.reduce((t, [, ps]) => t + (ps[0]?.units ?? 0), 0);
    const ins = String(d.content?.insured_number ?? "").trim();
    const cands = kyByInsured.get(ins) ?? [];
    const kyLines = cands.length === 1 ? kyRentalLines(cands[0]).filter((l) => l.providerNumber === CARESAPO) : null;
    const kyTotal = kyLines ? kyLines.reduce((t, l) => t + l.plannedUnits, 0) : null;
    const checkTotal = NEG_V1 ? v1Total : csvTotal;
    if (kyTotal == null) { skipPeople.push(`${name}: KY に居ない (被保番 ${ins}・候補 ${cands.length} 件) → 書かない`); continue; }
    if (kyTotal !== checkTotal) { skipPeople.push(`${name}: ケアサポ明細の合計 ${checkTotal} ≠ KY (ケアサポ) ${kyTotal} → 書かない`); continue; }

    // 品目ごと
    const groups = new Map();
    for (const r of v1rows) { const k = String(r.s.content ?? "").trim(); (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
    const fills = [];
    for (const [item, rs] of groups) {
      const ps = byItem.get(`${d.user_id}|${item}`) ?? [];
      if (ps.length <= 1) { st.変わらない行_1本 += rs.length; continue; }
      let vals = null, type = null;
      if (rs.length === 1) { vals = [ps.reduce((a, p) => a + p.units, 0)]; type = "1行/n本 → 合計"; }
      else if (rs.length === ps.length) {
        const byTais = rs.map((r) => ps.filter((p) => normT(p.tais) === normT(r.s.tais_code)));
        if (byTais.every((m) => m.length === 1) && new Set(byTais.map((m) => m[0])).size === rs.length) { vals = byTais.map((m) => m[0].units); type = "n行/n本 → TAIS で 1 対 1"; }
        else if (new Set(rs.map((r) => marksKey(r.s))).size === 1) { vals = ps.map((p) => p.units); type = "n行/n本 → 値の集合 (印が全行同じ)"; }
      }
      if (!vals) { skipGroups.push(`${name} ${item}: 利用票 ${rs.length} 行 / 商品 ${ps.length} 本${rs.length === ps.length ? " (印が行ごとに違う)" : ""} → 書かない`); continue; }
      types[type] += rs.length;
      for (const [j, r] of rs.entries()) {
        const before = r.s.rental_month_actual_units != null && Number(r.s.rental_month_actual_units) > 0 ? Number(r.s.rental_month_actual_units) : Number(r.s.manual_units ?? 0);
        if (before === vals[j]) st.値が同じ行++; else st.変わる行++;
        fills.push({ i: r.i, units: vals[j], before });
        if (examples.length < 12 && before !== vals[j]) examples.push(`${name} ${item}: v1 ${before} → v2 ${vals[j]} (${type}・商品 ${ps.length} 本)`);
      }
    }
    if (fills.length) plans.push({ docId: d.id, name, content: d.content, fills });
  }

  console.log(`母数: ${MONTH} の利用票で v1 (fukuyogu_meisai_202606) の貸与行がある人 ${st.対象の人} 名 / 行 ${st.対象の行_v1}`);
  console.log(`商品が 1 本の品目 (v1 のまま触らない) ${st.変わらない行_1本} 行`);
  console.log(`直す型: ${JSON.stringify(types)}`);
  console.log(`★ 書き換える行 ${st.変わる行 + st.値が同じ行} 行 = 値が変わる ${st.変わる行} 行 / 値が同じ ${st.値が同じ行} 行 (出どころだけ v2 に)`);
  console.log(`帳票 ${plans.length} 件`);
  console.log(`\n★ 書かない人 (KY で検算が合わない / KY に居ない) ${skipPeople.length} 名`); for (const x of skipPeople.slice(0, 30)) console.log(`    ${x}`); if (skipPeople.length > 30) console.log(`    … 他 ${skipPeople.length - 30} 名`);
  console.log(`★ 書かない品目 (行数 ≠ 本数・印が違う) ${skipGroups.length} 件`); for (const x of skipGroups.slice(0, 20)) console.log(`    ${x}`);
  console.log(`\n値が変わる行の例:`); for (const x of examples) console.log(`    ${x}`);
  if (!EXECUTE || NEG_V1) { console.log("\n※ DRY RUN。--execute で 退避 → 帳票ごとに更新 → 読み直して検算。"); return; }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const backup = path.join(KAIGO, "migrations", `_backup_fix_fukuyogu_v2_${stamp}.json`);
  writeFileSync(backup, JSON.stringify(plans.map((p) => ({ id: p.docId, content: p.content })), null, 2));
  console.log(`退避: ${backup}`);
  let done = 0;
  for (const p of plans) {
    const services = p.content.services.map((s, i) => { const f = p.fills.find((x) => x.i === i); return f ? { ...s, manual_units: null, rental_month_actual_units: f.units, _units_source: SOURCE } : s; });
    const { data, error } = await sb.from("kaigo_report_documents").update({ content: { ...p.content, services }, updated_at: new Date().toISOString() }).eq("id", p.docId).select("id, content");
    if (error || (data ?? []).length !== 1) { console.error(`✗ 更新失敗 ${p.name}: ${error?.message ?? "件数≠1"} (ここまでは退避ファイルから戻せる)`); process.exit(1); }
    const back = data[0].content.services;
    if (p.fills.some((f) => back[f.i]?._units_source !== SOURCE || Number(back[f.i]?.rental_month_actual_units) !== f.units)) { console.error(`✗ 検算失敗 ${p.name}`); process.exit(1); }
    done++;
  }
  console.log(`完了: ${done} 帳票 (読み直して確認)`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
