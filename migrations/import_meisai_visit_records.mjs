// ============================================================================
// ほのぼの「稼働データ」MEISAI CSV → kaigo_visit_schedule 実績取込
//   取込元: apps/kaigo-app/サービス実績データ/茂原/202606/MEISAI_*.csv
//   取込先: kaigo_visit_schedule (status='completed' = 実績)
//
//   使い方:
//     node migrations/import_meisai_visit_records.mjs            # DRY RUN (既定・書込なし)
//     node migrations/import_meisai_visit_records.mjs --execute  # 本番 INSERT
//
//   このスクリプトはまず「① 介護保険 訪問介護 (11xxxx)」だけを対象にする。
//   ②総合事業/③障害/④⑤⑥⑦独自コードは制度判定・変換マスタが確定してから拡張。
//   DRY RUN は read-only。利用者/職員/サービスコードの名寄せギャップを実数で出す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { findMeisaiFiles } from "./_meisai_files.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = "2026-06";       // 対象月 (処理月)
const MONTH_FIRST = "2026-06-01";     // サービスコード世代判定用
const OFFICE_BUSINESS_NUMBER = process.env.OFFICE_BN || "1271500942"; // リンクスヘルパーステーション (訪問介護)
const AREA_DIR = process.env.AREA_DIR || "茂原";
const TAG = process.env.TAG || "";
const CSV_DIR = fileURLToPath(
  new URL(`../サービス実績データ/${AREA_DIR}/202606/`, import.meta.url)
);

// ---- env ----
function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---- 正規化 ----
const normBase = (s) => (s || "").normalize("NFKC").replace(/[\s　]/g, "");
const normStaff = (s) => normBase(s).replace(/様$/, ""); // 職員名末尾の「様」を除去

// ---- SJIS CSV 読み込み ----
const sjis = new TextDecoder("shift_jis");
function readCsv(file) {
  const buf = readFileSync(file);
  const text = sjis.decode(buf);
  const lines = text.split(/\r?\n/).filter((l) => l !== "");
  const header = lines[0].split(",");
  const idx = {};
  header.forEach((h, i) => (idx[h.trim()] = i));
  const rows = lines.slice(1).map((l) => l.split(","));
  return { idx, rows };
}

// ---- 制度バケツ判定 ----
function bucketOf(code) {
  if (/^11[1-7]/.test(code)) return "①介護";      // 訪問介護 身体/生活
  if (/^A[23]/.test(code)) return "②総合事業";
  if (/^021/.test(code)) return "③障害";
  if (/^011001|^011002/.test(code)) return "④移動支援";
  if (/^012407/.test(code)) return "⑤養育支援";
  if (/^0110(04|05|06)/.test(code)) return "⑥自費";
  if (/^010001/.test(code)) return "⑦同行";
  if (/^010008/.test(code)) return "⑦キャンセル";
  return "他";
}

// ---- ページング fetch ----
async function fetchAll(table, cols) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ============================================================================
async function main() {
  console.log(`=== MEISAI 取込 ${EXECUTE ? "【本番 EXECUTE】" : "【DRY RUN】"} 対象月=${TARGET_MONTH} ===\n`);

  // 1) CSV 全読み込み
  const files = findMeisaiFiles(CSV_DIR);
  const all = [];
  for (const f of files) {
    const { idx, rows } = readCsv(f);
    for (const c of rows) {
      const g = (name) => (idx[name] != null ? (c[idx[name]] || "").trim() : "");
      all.push({
        file: f,
        jigyoNum: g("事業所番号"),
        staffName: g("職員名"),
        clientName: g("利用者名"),
        date: g("日付").replace(/\//g, "-"),
        start: g("派遣開始時間"),
        end: g("派遣終了時間"),
        svcName: g("サービス"),
        svcType: g("サービス型"),
        code: g("サービスコード"),
        clientNum: g("利用者番号"),
      });
    }
  }
  console.log(`CSV: ${files.length}ファイル / ${all.length}行\n`);

  // バケツ別
  const byBucket = {};
  for (const r of all) byBucket[bucketOf(r.code)] = (byBucket[bucketOf(r.code)] || 0) + 1;
  console.log("― 制度バケツ別件数 ―");
  for (const [k, v] of Object.entries(byBucket).sort((a, b) => b[1] - a[1])) console.log(`  ${k}\t${v}`);
  console.log("");

  // 今回対象 = ①介護のみ
  const target = all.filter((r) => bucketOf(r.code) === "①介護");
  console.log(`今回取込対象 = ①介護 のみ: ${target.length}行\n`);

  // 2) 事業所解決
  const { data: offRows, error: offErr } = await sb
    .from("offices").select("id,name,service_type,business_number")
    .eq("business_number", OFFICE_BUSINESS_NUMBER);
  if (offErr) throw new Error(`offices: ${offErr.message}`);
  if (!offRows.length) { console.error(`✗ 事業所 business_number=${OFFICE_BUSINESS_NUMBER} が見つからない`); process.exit(1); }
  const office = offRows[0];
  console.log(`事業所: ${office.name} (${office.id}) service_type=${office.service_type}\n`);

  // 3) サービスコード → 公式サービス名 (system=介護, 種類11, 対象月世代)
  const distinctCodes = [...new Set(target.map((r) => r.code))];
  const { data: scRows, error: scErr } = await sb
    .from("kaigo_service_codes")
    .select("service_code,service_name,units,system,service_category,valid_from,valid_until")
    .in("service_code", distinctCodes).eq("system", "介護").eq("service_category", "11");
  if (scErr) throw new Error(`kaigo_service_codes: ${scErr.message}`);
  const inMonth = (r) => (!r.valid_from || r.valid_from <= MONTH_FIRST) && (!r.valid_until || r.valid_until >= MONTH_FIRST);
  const codeToName = new Map();
  for (const r of scRows.filter(inMonth)) codeToName.set(r.service_code, { name: r.service_name, units: r.units });
  const unresolvedCodes = distinctCodes.filter((c) => !codeToName.has(c));
  console.log(`― サービスコード解決 ― 対象${distinctCodes.length}種 / 解決${codeToName.size}種 / 未解決${unresolvedCodes.length}種`);
  if (unresolvedCodes.length) console.log(`  未解決: ${unresolvedCodes.join(", ")}`);
  console.log("");

  // 4) 利用者マッピング (STEP1出力: MEISAI利用者番号 → client_id)
  const mapPath = fileURLToPath(new URL(`./_meisai_num_to_client${TAG ? "_" + TAG : ""}.json`, import.meta.url));
  const numToClient = JSON.parse(readFileSync(mapPath, "utf8"));

  // 5) 職員名寄せ (staff_id は members.id 参照)
  const members = await fetchAll("members", "id,name");
  const memberByName = new Map();
  for (const m of members) {
    const k = normStaff(m.name);
    if (!memberByName.has(k)) memberByName.set(k, []);
    memberByName.get(k).push(m.id);
  }

  // 突合サマリ
  const uniqNums = [...new Set(target.map((r) => r.clientNum))];
  const mappedNums = uniqNums.filter((n) => numToClient[n]);
  const uniqStaff = [...new Set(target.map((r) => r.staffName))];
  const staffMissing = uniqStaff.filter((nm) => (memberByName.get(normStaff(nm)) || []).length !== 1);
  console.log(`― 突合 ―`);
  console.log(`  利用者番号マッピング: ${mappedNums.length}/${uniqNums.length}名`);
  console.log(`  職員一致: ${uniqStaff.length - staffMissing.length}/${uniqStaff.length} (未一致は staff_id=null)`);
  if (staffMissing.length) console.log(`  職員未一致: ${staffMissing.join(" / ")}`);
  console.log("");

  // 取込可能行の算出 (利用者マップ有 + コード解決)
  let blockedNoClient = 0, blockedNoCode = 0;
  const payloads = [];
  for (const r of target) {
    const cid = numToClient[r.clientNum];
    if (!cid) { blockedNoClient++; continue; }
    const svc = codeToName.get(r.code);
    if (!svc) { blockedNoCode++; continue; }
    const sids = memberByName.get(normStaff(r.staffName)) || [];
    payloads.push({
      user_id: cid,
      staff_id: sids.length === 1 ? sids[0] : null,
      visit_date: r.date,
      start_time: r.start,
      end_time: r.end,
      service_type: svc.name,
      status: "completed",
      office_id: office.id,
      notes: `[MEISAI取込 ${TARGET_MONTH} code=${r.code}]`,
    });
  }
  // 2人訪問の二重計上を除去: 同一(利用者×日×開始時刻×サービス)は1訪問。
  // 稼働データは2人体制を各ヘルパー分=2行で記録するが、請求は1訪問=1回。
  const seen = new Set();
  const deduped = [];
  let dupRemoved = 0;
  for (const p of payloads) {
    const k = `${p.user_id}|${p.visit_date}|${p.start_time}|${p.service_type}`;
    if (seen.has(k)) { dupRemoved++; continue; }
    seen.add(k); deduped.push(p);
  }

  console.log(`― 取込可否サマリ (①介護 ${target.length}行) ―`);
  console.log(`  取込可能: ${payloads.length} → dedup後 ${deduped.length} (2人重複除去 ${dupRemoved})`);
  console.log(`  ブロック(利用者未マップ): ${blockedNoClient}`);
  console.log(`  ブロック(コード未解決): ${blockedNoCode}`);
  console.log("");
  if (deduped[0]) console.log("INSERT payload サンプル:\n", JSON.stringify(deduped[0], null, 2), "\n");

  if (!EXECUTE) {
    console.log("※ DRY RUN のため INSERT していません。--execute で本番投入。");
    return;
  }

  // 冪等: 既存の①介護取込行を削除してから入れ直す
  const { error: delErr } = await sb.from("kaigo_visit_schedule").delete().eq("office_id", office.id).like("notes", "[MEISAI取込%");
  if (delErr) { console.error(`✗ 既存削除失敗: ${delErr.message}`); process.exit(1); }
  console.log("既存 ①介護取込行 削除完了");

  // 本番 INSERT (chunk)
  const payloadsFinal = deduped;
  console.log(`本番 INSERT 開始: ${payloadsFinal.length}行 ...`);
  const CH = 500;
  let done = 0;
  for (let i = 0; i < payloadsFinal.length; i += CH) {
    const chunk = payloadsFinal.slice(i, i + CH);
    const { error } = await sb.from("kaigo_visit_schedule").insert(chunk);
    if (error) { console.error(`✗ INSERT失敗 (${done}件済): ${error.message}`); process.exit(1); }
    done += chunk.length;
    console.log(`  ${done}/${payloadsFinal.length}`);
  }
  console.log(`✓ 完了: ${done}行 INSERT`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
