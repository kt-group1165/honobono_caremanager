// ============================================================================
// 利用票 (service-usage) の福祉用具貸与行の rental_month_actual_units (その月の実額) を、別表 (第7表) PDF の単位で埋める
//   ★ 2026-11-13 から manual_units (単価) には書かない。意味の違う値を同じ列に入れないため (src/lib/rental-units.ts)
//
//   node migrations/fill_rental_units_from_betsuhyou.mjs --pdf "<別表.pdf>" [--pdf ...]            # DRY RUN
//   node migrations/fill_rental_units_from_betsuhyou.mjs --pdf "<別表.pdf>" [--pdf ...] --execute  # 本番 (H 判断)
//
// ── なぜ ──────────────────────────────────────────────────────────────────
// 利用票の貸与行の単位 (商品ごとの実額 ÷ 10) は利用票 PDF に印字されず、2026-06 の未投入は 6,637 行。
// 当方の DB に材料は無く (2026-11-12 調査)、別表 PDF にだけ商品ごとに出る。
//
// ── 別表の読み方 ────────────────────────────────────────────────────────────
// _parse_careplan_bundle_pdf.mjs の parseBundles (別表取込と同じ。人ごとに切り、2 ページの別表は行を連結)。
// 人の特定: 利用票ページがあれば (保険者番号, 被保番)、無ければ別表ヘッダの (被保番, 氏名) が両方一致する 1 人。
// 対象月: 別表ヘッダの年月 (無ければ利用票ページの提供年月)。
//
// ── 当て方 (★ 並び順に頼る行は埋めない。H 指示 2026-11-13) ────────────────────
// キー = (事業所, 品目名)。事業所は 利用票側が 10 文字ほどで切れているので「別表の事業所名が利用票の事業所名で始まる」で当てる。
//   A 一意     そのキーが 利用票 1 行・別表 1 行                      → 埋める
//   B 多重同値  利用票 n 行・別表 n 行 で 別表の単位が全部同じ          → 埋める (並び順が違っても結果が同じ)
//   C 多重異値  利用票 n 行・別表 n 行 で 別表の単位が違う              → ★ 埋めない。どの商品がいくらかが
//              入れ替わったまま固定され、合計は合うので検算で気づけない
//   D 行数違い  利用票 n 行・別表 m 行 (n≠m) / 事業所が当たらない      → 埋めない
//   (旧 E 月途中 は 2026-11-13 に廃止)
//      以前は manual_units に入れていたので、画面が印で半月と判定すると半額をさらに半分にした。それを避けるため
//      「印が 1 か月まるごと」の行だけ埋めていた。★ しかし印は根拠にならない: 行を貸与に切り替えた瞬間に画面が
//      1 日に印を自動で付けるので、「1 日目だけ」は既定値にすぎない (既存の食い違い 8 行のうち 4 行は印が 1 月なのに別表が半額)。
//      ★ rental_month_actual_units は印で按分しないので、半月の行でも実額がそのまま正しく出る。弾く理由が無くなった
//   既に manual_units (単価) か rental_month_actual_units (実額) がある行は触らない (別掲)
//
// ── 書くもの (--execute) ────────────────────────────────────────────────────
//   services[i].rental_month_actual_units = 別表の service_units / services[i]._units_source = "betsuhyou_<提供年月>"
//   (H の fukuyogu_meisai_202606 と区別できるように)。content._betsuhyou_fill = { at, n } を立てる。
//   ★ manual_units は触らない。_units_period は書かない (意味は列で表す)
//   既に単位がある行は触らない。1 対 1 で別表と食い違うものは一覧に出す (上書きしない)。
//   --execute の前に対象帳票の content を JSON に退避 (migrations/_backup_fill_rental_betsuhyou_<時刻>.json・commit しない)。
//   更新は帳票ごとに id 指定で、読み直した content が想定どおりかを確かめる。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBundles } from "./_parse_careplan_bundle_pdf.mjs";
import { resolveClients, resolveByBetsuhyouHeader } from "./_client_resolve.mjs";
import { normName } from "./_name_normalize.mjs";

const EXECUTE = process.argv.includes("--execute");
const PDF_PATHS = process.argv.flatMap((a, i, arr) => (a === "--pdf" ? [arr[i + 1]] : []));
if (!PDF_PATHS.length) { console.error("--pdf <path> を最低 1 つ指定する"); process.exit(1); }
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const RENTAL = new Set(["17", "67"]);
const normProv = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
const isRentalCode = (c) => /^(17|67)\d{4}$/.test(c ?? "");

const hasUnits = (r) => Number(r.manual_units) > 0 || Number(r.rental_month_actual_units) > 0;
const existingUnits = (r) => (Number(r.manual_units) > 0 ? { v: Number(r.manual_units), kind: "単価" } : { v: Number(r.rental_month_actual_units), kind: "実額" });

async function main() {
  console.log(`=== 別表 → 利用票の貸与 rental_month_actual_units ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const persons = PDF_PATHS.flatMap((p) => parseBundles(p).map((b, i) => ({ ...b, file: path.basename(p), idx: i + 1 })));
  console.log(`PDF ${PDF_PATHS.length} 本 / 人 ${persons.length}`);

  // ── 人の特定 ──
  const people = new Map();
  for (const b of persons) if (b.riyouhyouIdentity?.insurer && b.riyouhyouIdentity?.insured)
    people.set(`${b.file}#${b.idx}`, { insurer: b.riyouhyouIdentity.insurer, insured: b.riyouhyouIdentity.insured, nameKey: normName(b.riyouhyouIdentity.name ?? "") });
  const { byPair } = people.size ? await resolveClients(sb, people, { normalizeName: normName }) : { byPair: new Map() };
  const headerOnly = persons.filter((b) => !people.has(`${b.file}#${b.idx}`) && b.betsuhyouHeader?.insured && b.betsuhyouHeader?.name);
  // 処理本体は _client_resolve.mjs の resolveByBetsuhyouHeader (import_care_plan3_usage_detail_from_pdf.mjs と共通)
  const { resolved: headerResolved, names } = await resolveByBetsuhyouHeader(sb,
    headerOnly.map((b) => ({ key: `${b.file}#${b.idx}`, insured: b.betsuhyouHeader.insured, name: b.betsuhyouHeader.name, officeNumber: b.betsuhyouOfficeNumber })), { normalizeName: normName });

  const st = { 人: persons.length, 特定できない: 0, 別表の行が読めない: 0, 別表に貸与なし: 0, 別表の警告あり: 0, 利用票なし: 0, 利用票に貸与行なし: 0 };
  const cls = { A: 0, B: 0, C: 0, D: 0, 投入済み: 0 };
  const plans = []; // { docId, content, fills: [{ i, units }] }
  const examples = { C: [], D: [] };
  const existingMismatch = [];
  for (const b of persons) {
    const key = `${b.file}#${b.idx}`;
    let clientId = null;
    if (people.has(key)) {
      const p = people.get(key); const ids = byPair.get(`${p.insurer}|${p.insured}`);
      if (ids?.size === 1) clientId = [...ids][0];
    } else if (b.betsuhyouHeader) {
      clientId = headerResolved.get(key)?.clientId ?? null;
    }
    if (!clientId) { st.特定できない++; continue; }
    // 行が 1 行も読めない別表 (利用票別表・全CM の出し方。列の位置が違う) を「貸与なし」と取り違えない
    if (!(b.betsuhyouItems ?? []).length) { st.別表の行が読めない++; continue; }
    const items =(b.betsuhyouItems ?? []).filter((it) => isRentalCode(it.service_code));
    if (!items.length) { st.別表に貸与なし++; continue; }
    if (b.betsuhyouWarn.length) { st.別表の警告あり++; continue; } // 金額が合っていない別表は使わない
    const ym = b.betsuhyouHeader?.month ?? b.riyouhyouMonth;
    const { data: docs, error } = await sb.from("kaigo_report_documents").select("id, content")
      .eq("user_id", clientId).eq("report_type", "service-usage").eq("report_month", ym);
    if (error) throw new Error(error.message);
    if ((docs ?? []).length !== 1) { st.利用票なし++; continue; }
    const doc = docs[0];
    const services = doc.content?.services ?? [];
    const rows = services.map((s, i) => ({ s, i })).filter(({ s }) => RENTAL.has(String(s.category ?? "")));
    if (!rows.length) { st.利用票に貸与行なし++; continue; }

    // (利用票の事業所, 品目) ごとに、別表で「事業所名がその文字列で始まる」行を集める
    const groups = new Map();
    for (const r of rows) { const k = `${normProv(r.s.provider)}|${r.s.content}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
    const fills = [];
    for (const [k, rs] of groups) {
      const [prov, content] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
      const its = items.filter((it) => it.service_content === content && prov && normProv(it.provider_name).startsWith(prov));
      const label = `${names.get(clientId) ?? b.betsuhyouHeader?.name ?? ""} ${ym} ${content} @${prov}`;
      if (rs.every((r) => hasUnits(r.s))) {
        cls.投入済み += rs.length;
        // 既に単位がある行は触らない。1 対 1 で別表と食い違うものだけ一覧に出す (事業所をまたぐ不整合の材料)
        if (rs.length === 1 && its.length === 1 && existingUnits(rs[0].s).v !== Number(its[0].service_units)) {
          const ex = existingUnits(rs[0].s);
          existingMismatch.push(`${label}  既存 ${ex.v} (${ex.kind}・${rs[0].s._units_source ?? "出どころ不明"}) / 別表 ${its[0].service_units}${ex.kind === "単価" && Number(its[0].service_units) * 2 === ex.v ? "  ← 別表がちょうど半額 (半月)" : ""}`);
        }
        continue;
      }
      if (its.length !== rs.length || !its.length) { cls.D += rs.length; if (examples.D.length < 6) examples.D.push(`${label} 利用票 ${rs.length} 行 / 別表 ${its.length} 行`); continue; }
      const unitsSet = new Set(its.map((it) => Number(it.service_units)));
      if (rs.length > 1 && unitsSet.size > 1) { cls.C += rs.length; if (examples.C.length < 6) examples.C.push(`${label} ${rs.length} 行 単位 ${its.map((it) => it.service_units).join("/")}`); continue; }
      for (const [j, r] of rs.entries()) {
        if (hasUnits(r.s)) { cls.投入済み++; continue; }
        fills.push({ i: r.i, units: Number(its[j].service_units) });
        cls[rs.length === 1 ? "A" : "B"]++;
      }
    }
    if (fills.length) plans.push({ docId: doc.id, ym, content: doc.content, fills, name: names.get(clientId) ?? "" });
  }

  console.log("\n■ 人・帳票");
  console.log(`  ${JSON.stringify(st)}`);
  console.log("\n■ 利用票の貸与行の分類 (行数)");
  console.log(`  A 一意 → 埋める          ${cls.A}`);
  console.log(`  B 多重・単位同じ → 埋める ${cls.B}`);
  console.log(`  C 多重・単位違う (並び順に頼る) → 埋めない ${cls.C}`);
  console.log(`  D 行数違い・事業所が当たらない → 埋めない ${cls.D}`);
  console.log(`  既に単位あり (単価 or 実額・触らない) ${cls.投入済み}`);
  for (const t of ["C", "D"]) if (examples[t].length) { console.log(`  ${t} の例:`); for (const x of examples[t]) console.log(`    ${x}`); }
  const officeNotes = [...headerResolved.values()].filter((r) => r.warn || r.note);
  if (officeNotes.length) {
    console.log(`\n■ 別表の居宅支援事業者番号 (引き当ては成立・書く) ${officeNotes.length} 人`);
    for (const r of officeNotes) console.log(`    ${r.name}: ${r.warn ?? r.note}`);
  }
  console.log(`\n■ 既に単位がある行で 別表と食い違う (1 対 1・上書きしない) ${existingMismatch.length} 行`);
  for (const x of existingMismatch) console.log(`    ${x}`);
  console.log(`\n埋める帳票 ${plans.length} 件 / 行 ${plans.reduce((s, p) => s + p.fills.length, 0)}`);
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で 退避 → 帳票ごとに更新 → 読み直して検算。"); return; }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const backup = path.join(KAIGO, "migrations", `_backup_fill_rental_betsuhyou_${stamp}.json`);
  writeFileSync(backup, JSON.stringify(plans.map((p) => ({ id: p.docId, content: p.content })), null, 2));
  console.log(`退避: ${backup}`);
  let done = 0;
  for (const p of plans) {
    const services = p.content.services.map((s, i) => {
      const f = p.fills.find((x) => x.i === i);
      // 別表の単位は「その月の実額」(半月なら半額)。単価 (manual_units) とは別の列に入れる。画面は按分しない
      return f ? { ...s, rental_month_actual_units: f.units, _units_source: `betsuhyou_${p.ym}` } : s;
    });
    const content = { ...p.content, services, _betsuhyou_fill: { at: new Date().toISOString().slice(0, 10), n: p.fills.length } };
    const { data, error } = await sb.from("kaigo_report_documents").update({ content, updated_at: new Date().toISOString() }).eq("id", p.docId).select("id, content");
    if (error || (data ?? []).length !== 1) { console.error(`✗ 更新失敗 ${p.name} ${p.ym}: ${error?.message ?? "件数≠1"} (ここまでは退避ファイルから戻せる)`); process.exit(1); }
    const got = data[0].content.services.filter((s) => s._units_source === `betsuhyou_${p.ym}`).length;
    if (got !== p.fills.length) { console.error(`✗ 検算失敗 ${p.name}: ${got} / ${p.fills.length}`); process.exit(1); }
    done++;
  }
  console.log(`完了: ${done} 帳票`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
