// ============================================================================
// 介護請求(明細付)_一覧.CSV の「サービス開始年月日」→ client_insurance_records
//
//   国保連伝送 8124 明細書 基本情報 (7131 種別01) の **項23 サービス利用開始年月日**。
//   月の途中からその事業所のサービスを使い始めた利用者に設定する。
//
//   ⚠ **初回訪問日ではない**。契約日 (= それより前) が入る。
//     実証: 33 名中 初回訪問日と一致したのは 4 名だけで、残りは訪問日より前だった
//     (花見川 尾崎脩二 伝送 20260615 / 初回訪問 20260626)。
//     なので実績からは導けず、ほのぼの側の値を取り込むしかない。
//
//   使い方:
//     AREA_DIR=姉ム TAG=姉む node migrations/import_meisai_service_start_date.mjs
//     … --execute で更新
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { findDataFile } from "./_meisai_files.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const AREA_DIR = process.env.AREA_DIR || "茂原";
const TAG = process.env.TAG || "";
// TARGET_MONTH=2026-07 で対象月を切替 (既定は 2026-06)。フォルダも同じ月を見る。
const TARGET_MONTH = process.env.TARGET_MONTH || "2026-06";
const YM = TARGET_MONTH.replace("-", "");
const STEP1_MARK = `[MEISAI-STEP1 ${TARGET_MONTH}${TAG ? " " + TAG : ""}]`;
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

function loadEnv() {
  const txt = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
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
const sjis = new TextDecoder("shift_jis");

function parseLine(line) {
  const o = []; let c = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else { if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; }
  }
  o.push(c);
  return o;
}
const isoDate = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s || "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};

async function main() {
  console.log(`=== サービス利用開始年月日 取込 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ${AREA_DIR} ===\n`);

  const csv = findDataFile(path.join(KAIGO, "サービス実績データ", AREA_DIR, YM), "介護請求(明細付)_一覧.CSV");
  if (!csv) {
    console.error(`✗ サービス実績データ/${AREA_DIR}/${YM} 配下に 介護請求(明細付)_一覧.CSV がありません`);
    process.exit(1);
  }
  const lines = sjis.decode(readFileSync(csv)).split(/\r?\n/).filter((l) => l);
  const H = parseLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  const gi = (n) => H.indexOf(n);
  const iIns = gi("被保険者番号"), iName = gi("利用者名"), iYm = gi("提供年月"), iStart = gi("サービス開始年月日");
  if (iStart < 0) { console.error("✗ 「サービス開始年月日」列がありません"); process.exit(1); }

  // 対象月の行から 被保険者番号 → 開始日
  const byIns = new Map();
  for (const ln of lines.slice(1)) {
    const c = parseLine(ln).map((x) => x.replace(/^"|"$/g, ""));
    if ((c[iYm] || "").replace("/", "-") !== TARGET_MONTH) continue;
    const d = isoDate(c[iStart]);
    if (!d) continue;
    byIns.set(c[iIns], { d, name: c[iName] });
  }
  console.log(`サービス開始年月日あり: ${byIns.size} 名`);
  if (byIns.size === 0) { console.log("対象なし。"); return; }

  // 被保険者番号 → client
  const clients = [];
  for (let x = 0; ; x += 1000) {
    const { data, error } = await sb.from("clients").select("id,name,insured_number").range(x, x + 999);
    if (error) throw new Error(error.message);
    clients.push(...data);
    if (data.length < 1000) break;
  }
  const byNum = new Map(clients.filter((c) => c.insured_number).map((c) => [String(c.insured_number), c]));

  const plan = [];
  for (const [ins, v] of byIns) {
    const c = byNum.get(ins);
    if (!c) { console.log(`  ⚠ ${ins} ${v.name}: client 未登録`); continue; }
    plan.push({ client_id: c.id, name: c.name, date: v.d });
    console.log(`  ${c.name.padEnd(12)} ${v.d}`);
  }
  console.log(`\n更新対象: ${plan.length} 名`);
  if (!EXECUTE) { console.log("※ DRY RUN。--execute で更新します。"); return; }

  let ok = 0, miss = 0;
  for (const p of plan) {
    const { error, count } = await sb
      .from("client_insurance_records")
      .update({ service_start_date: p.date }, { count: "exact" })
      .eq("client_id", p.client_id)
      .eq("notes", STEP1_MARK);
    if (error) { console.error(`✗ ${p.name}: ${error.message}`); process.exit(1); }
    count ? ok++ : miss++;
  }
  console.log(`✓ 完了: ${ok} 名更新 / marker不一致で未更新 ${miss}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
