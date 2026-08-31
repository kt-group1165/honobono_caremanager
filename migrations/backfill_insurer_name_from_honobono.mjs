// ============================================================================
// 認定 (client_insurance_records) の **保険者名**を ほのぼのの利用者マスタから埋める。
//
//   node migrations/backfill_insurer_name_from_honobono.mjs            # DRY RUN
//   node migrations/backfill_insurer_name_from_honobono.mjs --execute
//   --keep-existing   既に値が入っている行は一切触らない (誤りの是正もしない)
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   2026-08-31 実測: 認定 7,254 件のうち **3,278 件が insurer_name = NULL**。
//   保険者名は 利用票 (第6表)・給付管理票 (様式第十一) の表題部に印字するので、
//   NULL だと帳票の欄が空で出る。
//
// ── どこから取るか (推測していない) ────────────────────────────────────
//   ほのぼの 利用者管理 → CSV の「介護保険」帳票。
//     利用者データ/<拠点>/介護保険*.CSV   (Shift_JIS)
//   列は **ヘッダー名で引く**。「保険者番号」「保険者」。
//   ⚠ 列位置は出力設定で変わる (全社_R8-08 は被保険者番号が col 4 でなく col 18
//     だった前例)。決め打ちで読まないこと。
//
//   利用者データ配下 24 本 100,827 行で 保険者番号 161 種類・**名称の衝突 0**。
//
//   さらに 保険者番号 = **JIS 5 桁 + modulus10 の検証数字**なので、番号そのものを
//   検算できる。161 種類のうち 159 が検証を通り、落ちたのは次の 2 つだけ:
//     001220「木更津市」… 検証数字が合わない (木更津市は本来 122069)。ほのぼの側の
//                          入力誤りと思われるので **採用しない**
//     999999「その他」  … ダミー
//   ⚠ 検証数字は modulus10 (重み 2,1,2,1,2 / 積が 2 桁なら桁を足す)。
//     地方公共団体コードの modulus11 とは別物 (feedback_shogai_shichoson_number)。
//
//   ⚠ 自前 DB の多数決でマスタを作ってはいけない。当方の既存値には
//     122192 を「千葉市」とする誤りが 46 件あり、多数決だと誤りを増やす。
//
// ── 既存値の是正 ────────────────────────────────────────────────────────
//   マスタと食い違う既存値は既定で **正しい名称に直す** (件数は必ず一覧に出す)。
//   直したくないときは --keep-existing。
//     実測の食い違い: 122192「千葉市」→「市原市」46 件 / 122135「白子町」→「東金市」1 件
//
// ── 触る範囲 ────────────────────────────────────────────────────────────
//   client_insurance_records の **insurer_name 列のみ**。
//   要介護度・認定期間・限度額など請求に効く列には一切触らない。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KEEP_EXISTING = process.argv.includes("--keep-existing");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Shift_JIS の CSV を 2 次元配列に。引用符内の , と "" に対応する */
function parseCsv(file) {
  const s = new TextDecoder("shift_jis").decode(readFileSync(file));
  const rows = [];
  let cur = [], fld = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { fld += '"'; i++; } else q = false; }
      else fld += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(fld); fld = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { cur.push(fld); rows.push(cur); cur = []; fld = ""; }
    else fld += c;
  }
  if (fld || cur.length) { cur.push(fld); rows.push(cur); }
  return rows;
}

/** 利用者データ/ 配下の 介護保険*.CSV を全部集める */
function findKaigoHokenCsvs() {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = path.join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/^介護保険.*\.csv$/i.test(name) && st.size > 0) out.push(p);
    }
  };
  walk(path.join(KAIGO, "利用者データ"));
  return out.sort();
}

/** 保険者名として採れる値か。数字だけ・数字混じりは名称ではない (実データに "293" がある) */
const isInsurerName = (v) => !!v && !/[0-9０-９]/.test(v);

/**
 * 保険者番号の検証数字 (6 桁目)。JIS 5 桁に modulus10 を掛けたもの。
 * 重み 2,1,2,1,2 で掛け、積が 2 桁なら桁を足して合計 → 10 - (合計 mod 10) (10 なら 0)。
 * ⚠ 地方公共団体コードの modulus11 とは別物。混同すると 1 桁ずれる。
 */
function insurerCheckDigit(five) {
  const w = [2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    let v = Number(five[i]) * w[i];
    if (v > 9) v = Math.floor(v / 10) + (v % 10);
    sum += v;
  }
  const r = 10 - (sum % 10);
  return r === 10 ? 0 : r;
}
const isValidInsurerNumber = (num) =>
  /^\d{6}$/.test(num) && String(insurerCheckDigit(num.slice(0, 5))) === num[5];

async function fetchAll(build) {
  const out = [];
  const STEP = 1000;
  for (let from = 0; ; from += STEP) {
    const { data, error } = await build().range(from, from + STEP - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < STEP) return out;
  }
}

async function main() {
  console.log("=== 認定の保険者名を ほのぼの利用者マスタから埋める ===");
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");
  if (KEEP_EXISTING) console.log("*** --keep-existing: 空の行だけ埋める (誤りの是正はしない) ***");

  // ── 1. CSV から 保険者番号 → 保険者名 を作る ───────────────────────────
  const csvs = findKaigoHokenCsvs();
  if (!csvs.length) { console.error("✗ 利用者データ/**/介護保険*.CSV が見つからない"); process.exit(1); }
  console.log(`CSV ${csvs.length} 本`);

  const votes = new Map();       // 番号 -> Map(名称 -> 件数)
  const rejected = new Map();    // 名称として採らなかった値
  let rowCount = 0;
  for (const f of csvs) {
    const rows = parseCsv(f);
    if (!rows.length) continue;
    const header = rows[0].map((h) => h.trim());
    const iNum = header.indexOf("保険者番号");
    const iName = header.indexOf("保険者");
    if (iNum < 0 || iName < 0) {
      console.log(`  ⚠ 列が見つからないので読み飛ばす: ${path.relative(KAIGO, f)} (保険者番号=${iNum} 保険者=${iName})`);
      continue;
    }
    for (const r of rows.slice(1)) {
      const num = (r[iNum] ?? "").trim();
      const name = (r[iName] ?? "").trim();
      if (!/^\d{6}$/.test(num) || !name) continue;
      rowCount++;
      if (!isInsurerName(name)) { rejected.set(`${num} → 「${name}」`, (rejected.get(`${num} → 「${name}」`) ?? 0) + 1); continue; }
      if (!votes.has(num)) votes.set(num, new Map());
      const g = votes.get(num);
      g.set(name, (g.get(name) ?? 0) + 1);
    }
  }

  // 番号 1 つに名称が 2 つ以上出たら、どちらが正か決められないので採らない。
  // 検証数字が合わない番号も採らない (ほのぼの側の入力誤りを写さないため)。
  const master = new Map();
  const conflicts = [];
  const badNumber = [];
  for (const [num, g] of votes) {
    if (g.size > 1) { conflicts.push(`${num}: ${JSON.stringify([...g])}`); continue; }
    const name = [...g.keys()][0];
    if (!isValidInsurerNumber(num)) { badNumber.push(`${num}「${name}」`); continue; }
    master.set(num, name);
  }
  console.log(`CSV ${rowCount} 行 → 保険者番号 ${master.size} 種類`);
  if (rejected.size) {
    console.log(`  名称として採らなかった値 ${rejected.size} 種類 (数字混じり):`);
    [...rejected].slice(0, 10).forEach(([k, v]) => console.log(`     ${k} × ${v}`));
  }
  if (conflicts.length) {
    console.log(`  ⚠ 名称が割れて採用できない番号 ${conflicts.length} 件 (人が決めること):`);
    conflicts.forEach((c) => console.log("     " + c));
  }
  if (badNumber.length) {
    console.log(`  ⚠ 検証数字が合わないので採用しない番号 ${badNumber.length} 件:`);
    badNumber.forEach((c) => console.log("     " + c));
  }

  // ── 2. 認定を取る ──────────────────────────────────────────────────────
  const certs = await fetchAll(() => sb
    .from("client_insurance_records")
    .select("id, client_id, insurer_number, insurer_name")
    .order("id"));
  console.log(`認定 ${certs.length} 件`);

  // ── 3. 埋める / 直す を決める ──────────────────────────────────────────
  const fill = [], fix = [];
  const stat = { 番号なし: 0, 既に一致: 0, マスタに無い: 0 };
  const unknown = new Map();
  for (const c of certs) {
    const num = (c.insurer_number ?? "").trim();
    if (!num) { stat.番号なし++; continue; }
    const right = master.get(num);
    const cur = (c.insurer_name ?? "").trim();
    if (!right) {
      if (!cur) { stat.マスタに無い++; unknown.set(num, (unknown.get(num) ?? 0) + 1); }
      else stat.既に一致++;                    // マスタに無いが値はある → 触らない
      continue;
    }
    if (!cur) { fill.push({ id: c.id, num, to: right }); continue; }
    if (cur === right) { stat.既に一致++; continue; }
    fix.push({ id: c.id, num, from: cur, to: right });
  }

  console.log("");
  console.log(`空を埋める ${fill.length} 件 / 既存値を直す ${fix.length} 件 / 既に一致 ${stat.既に一致} / マスタに無く空のまま ${stat.マスタに無い} / 番号なし ${stat.番号なし}`);

  const byNum = new Map();
  for (const f of fill) byNum.set(`${f.num} ${f.to}`, (byNum.get(`${f.num} ${f.to}`) ?? 0) + 1);
  console.log("  埋める内訳 (上位 12):");
  [...byNum].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(`     ${k} × ${v}`));

  if (fix.length) {
    const byFix = new Map();
    for (const f of fix) {
      const k = `${f.num}: 「${f.from}」→「${f.to}」`;
      byFix.set(k, (byFix.get(k) ?? 0) + 1);
    }
    console.log("  ⚠ 既存値がマスタと違う (是正する):");
    [...byFix].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`     ${v} 件  ${k}`));
  }
  if (unknown.size) {
    console.log(`  マスタに無い保険者番号 ${unknown.size} 種類 (空のまま残る):`);
    [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`     ${k} × ${v}`));
  }

  const targets = KEEP_EXISTING ? fill : [...fill, ...fix];
  if (!EXECUTE) { console.log(`\nDRY RUN。--execute で ${targets.length} 件を反映する。`); return; }

  // ── 4. 反映 (insurer_name 列のみ) ──────────────────────────────────────
  let ok = 0, ng = 0;
  for (const t of targets) {
    const { error } = await sb
      .from("client_insurance_records")
      .update({ insurer_name: t.to })
      .eq("id", t.id);
    if (error) { ng++; console.error(`  ✗ ${t.id}: ${error.message}`); continue; }
    ok++;
    if (ok % 500 === 0) console.log(`  … ${ok}/${targets.length}`);
  }
  console.log(`\n反映 ${ok} 件 / 失敗 ${ng} 件`);
  if (ng) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
