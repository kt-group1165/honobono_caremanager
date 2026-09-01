// ============================================================================
// ほのぼの【利用者管理】基本情報CSVの「死亡日」列から clients.status='deceased' /
// clients.discharge_date を backfill する。
//
//   背景: import_client_master_from_honobono_csv.mjs は既に 基本情報CSV の
//   死亡日列を profile Map に読み込んでいる (died: iso(r[B.died])) が、
//   その profile Map は他のどこからも参照されておらず**書き込みには使われて
//   いなかった**。結果、clients.status='deceased' を書くscriptが全migrations
//   中に1つも存在せず、ダッシュボードのラベル(dashboard/page.tsx: deceased→
//   "死亡")も含め常に0件のまま死んでいた。
//   実例: 周郷君子(user_number=617000114)は2026-04-16に死亡と基本情報CSVに
//   記載があるが、DB上は status='active' / discharge_date=null のまま。
//
//   マッチング方式: 基本情報CSVには被保険者番号列が無いため、直接
//   clients.user_number へ突き合わせない (利用者番号は拠点内でしか一意でない
//   罠を踏む)。代わりに 介護保険1.CSV を橋渡しに使う:
//     基本情報.利用者番号 → 介護保険1.利用者番号 (同じ利用者番号体系) →
//     (保険者番号, 被保険者番号) → client_insurance_records → client_id
//   この (保険者番号, 被保険者番号) ペアが本プロジェクト全体で利用者照合の
//   信頼できるキーとして使われている方式 (import_client_master_from_honobono_csv.mjs
//   の証突合と同じ)。
//
//   node migrations/fix_client_deceased_status_from_master_csv.mjs            # DRY RUN
//   node migrations/fix_client_deceased_status_from_master_csv.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const SRC = "C:/Users/domen-PC/Box/10F内共有/ほのぼのから出力";

function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const splitCsv = (line) => {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};
const readCsv = (file) => {
  const p = path.join(SRC, file);
  if (!existsSync(p)) { console.error(`✗ ${p} がありません`); process.exit(1); }
  const rows = iconv.decode(readFileSync(p), "Shift_JIS")
    .split(/\r?\n/).filter((l) => l.trim()).map((l) => splitCsv(l).map((s) => s.trim()));
  return { head: rows[0], rows: rows.slice(1) };
};
const iso = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const isDummy = (name) => /^[★◆◎●■☆〇○◇▲△▼▽※＊*]/.test((name ?? "").trim());

async function fetchAllInsurance() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("client_insurance_records")
      .select("client_id, insurer_number, insured_number")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function main() {
  console.log(`=== 死亡ステータス backfill ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const base = readCsv("基本情報_______.CSV");
  const hoken = readCsv("介護保険1.CSV");
  console.log(`  基本情報 ${base.rows.length} 行 / 介護保険 ${hoken.rows.length} 行`);

  // ① 基本情報: 利用者番号 → 死亡日 (ダミー登録は除外)
  const B = { no: 0, name: 3, died: 22 };
  const deathByNo = new Map();
  let dummies = 0;
  for (const r of base.rows) {
    if (r.length <= B.died) continue;
    if (isDummy(r[B.name])) { dummies++; continue; }
    const d = iso(r[B.died]);
    if (d) deathByNo.set(r[B.no], { name: r[B.name], died: d });
  }
  console.log(`  死亡日が入っている行: ${deathByNo.size}件 (ダミー除外 ${dummies}件)`);

  // ② 介護保険1: 利用者番号 → (保険者番号, 被保険者番号) の橋渡し。
  //   ⚠ 2026-09-02 の事故で判明: 短い/古い形式の利用者番号 (4桁等) はほのぼの内で
  //   複数の別人に使い回されていることがあり、その番号配下に**異なる(保険者,被保番)
  //   ペアが複数存在**する。「最初に見つかった1件」を採用すると、死亡記録とは無関係な
  //   別人 (現に生存し新規認定まで受けている実在利用者) を誤って死亡扱いにしてしまう
  //   (実例: 利用者番号6180 = 死亡記録は「森範子」名義、当方DBの同ペア一致先は
  //   「海保光子」で2023年に新規認定を受けている生存者だった)。
  //   → 同じ利用者番号に複数の異なるペアがある場合は橋渡しせず除外する (安全側)。
  const H = { no: 0, insured: 18, insurer: 39 };
  const pairsByNo = new Map();
  for (const r of hoken.rows) {
    if (r.length <= H.insurer) continue;
    if (!r[H.insurer] || !r[H.insured]) continue;
    if (!pairsByNo.has(r[H.no])) pairsByNo.set(r[H.no], new Set());
    pairsByNo.get(r[H.no]).add(`${r[H.insurer]}|${r[H.insured]}`);
  }
  const bridgeByNo = new Map();
  const ambiguousNos = [];
  for (const [no, pairs] of pairsByNo) {
    if (pairs.size === 1) {
      const [pair] = pairs;
      const [insurer, insured] = pair.split("|");
      bridgeByNo.set(no, { insurer, insured });
    } else {
      ambiguousNos.push(no);
    }
  }
  console.log(`  介護保険1橋渡し: ${bridgeByNo.size}名 (利用者番号の使い回しで橋渡し不可・除外: ${ambiguousNos.length}件)`);
  if (ambiguousNos.length) console.log(`  使い回し疑いサンプル: ${ambiguousNos.slice(0, 10).join(" / ")}`);

  // ③ 当方の client_insurance_records から (保険者, 被保番) → client_id
  const insAll = await fetchAllInsurance();
  const clientByPair = new Map();
  for (const r of insAll) {
    if (!r.insurer_number || !r.insured_number) continue;
    clientByPair.set(`${r.insurer_number}|${r.insured_number}`, r.client_id);
  }
  console.log(`  当方 client_insurance_records: ${insAll.length}行 (${clientByPair.size}ペア)\n`);

  // ④ 突合
  let bridged = 0, matched = 0;
  const plan = []; // { clientId, name, died, currentStatus, currentDischarge }
  const noBridge = [];
  const noMatch = [];
  for (const [no, d] of deathByNo) {
    const pair = bridgeByNo.get(no);
    if (!pair) { noBridge.push(`${no}:${d.name}`); continue; }
    bridged++;
    const clientId = clientByPair.get(`${pair.insurer}|${pair.insured}`);
    if (!clientId) { noMatch.push(`${no}:${d.name}`); continue; }
    matched++;
    plan.push({ clientId, no, name: d.name, died: d.died });
  }
  console.log(`介護保険1に橋渡しできた: ${bridged}件 (できなかった ${noBridge.length}件)`);
  console.log(`当方DBに一致した: ${matched}件 (一致しなかった ${noMatch.length}件)`);
  if (noBridge.length) console.log(`  橋渡し不可サンプル: ${noBridge.slice(0, 5).join(" / ")}`);
  if (noMatch.length) console.log(`  DB不一致サンプル: ${noMatch.slice(0, 5).join(" / ")}`);

  // ⑤ 現在のDB値と突合し、更新が要るものだけ絞る
  const clientIds = [...new Set(plan.map((p) => p.clientId))];
  const currentById = new Map();
  for (let i = 0; i < clientIds.length; i += 500) {
    const chunk = clientIds.slice(i, i + 500);
    const { data, error } = await sb.from("clients").select("id,status,discharge_date").in("id", chunk);
    if (error) throw new Error(error.message);
    for (const c of data) currentById.set(c.id, c);
  }

  const toUpdate = [];
  const alreadyOk = [];
  const conflict = []; // 既存discharge_dateがCSVと食い違う
  for (const p of plan) {
    const cur = currentById.get(p.clientId);
    if (!cur) continue;
    if (cur.status === "deceased" && cur.discharge_date === p.died) { alreadyOk.push(p); continue; }
    if (cur.discharge_date && cur.discharge_date !== p.died) { conflict.push({ ...p, currentDischarge: cur.discharge_date, currentStatus: cur.status }); continue; }
    toUpdate.push({ ...p, currentStatus: cur.status, currentDischarge: cur.discharge_date });
  }

  console.log(`\n更新対象 (status→deceased, discharge_date→死亡日): ${toUpdate.length}件`);
  console.log(`既に正しい値: ${alreadyOk.length}件`);
  console.log(`⚠ 既存discharge_dateと食い違い (要目視確認・自動更新しない): ${conflict.length}件`);
  if (conflict.length) {
    for (const c of conflict) console.log(`  ${c.no}:${c.name} CSV死亡日=${c.died} 既存discharge_date=${c.currentDischarge} status=${c.currentStatus}`);
  }
  console.log(`\n更新対象一覧:`);
  for (const u of toUpdate) console.log(`  ${u.no}:${u.name} → status=deceased discharge_date=${u.died} (現status=${u.currentStatus}, 現discharge_date=${u.currentDischarge ?? "null"})`);

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で反映 (conflict分は対象外のまま)。");
    return;
  }

  let ok = 0, fail = 0;
  for (const u of toUpdate) {
    const { error } = await sb.from("clients").update({ status: "deceased", discharge_date: u.died }).eq("id", u.clientId);
    if (error) { fail++; console.warn(`  ✗ ${u.no}:${u.name}: ${error.message}`); }
    else ok++;
  }
  console.log(`\n✓ 完了: ${ok}件更新 / ${fail}件失敗`);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
