// ============================================================================
// ほのぼの【利用者管理】→ CSV から出した利用者マスタ 3 種を取り込む。
//
//   ほのぼのから出力/基本情報_______.CSV  30列  氏名・フリガナ・性別・生年・住所・死亡日
//   ほのぼのから出力/介護保険1.CSV        42列  認定・保険者・支援事業所・担当ケアマネ
//   ほのぼのから出力/公費1.CSV            16列  法別・負担者番号・受給者番号・本人支払額
//
// ── 出し方 (2026-08-30 に画面で確認。既定値は全部「落ちる側」) ─────────
//   処理日時点での利用登録  ○有 → **●無**    有だと利用終了者が丸ごと落ちる
//   出力範囲              ○有効 → **●全件**  有効だと過去の認定が落ちる
//   参照対象              ○認定のみ → **●保険と認定**
//   事業所                全事業所にチェック
//   これで 基本情報 19,133 / 介護保険 38,867 / 公費 27,891 件になる。
//
// ── 罠 ────────────────────────────────────────────────────────────────
//   ⚠ 基本情報には **利用者でない登録**が 66 件混ざる (職員のスケジュール用)。
//     「★ 会議」「◆ ケース会議」「◎ 健康診断」「● 私用」「■ ミーティング」など。
//     記号で始まる氏名で除外する。
//   ⚠ 介護保険は 1 人が認定の世代ごとに複数行 (14,483 名で 38,867 行)。
//   ⚠ 被保険者番号は **保険者の中でしか一意でない**。必ず保険者番号と対で引く。
//
//   node migrations/import_client_master_from_honobono_csv.mjs            # DRY RUN
//   node migrations/import_client_master_from_honobono_csv.mjs --execute
//   env: MONTH=2026-06 (この月に有効な認定を採る)
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const MONTH_END = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)
  .toISOString().slice(0, 10);
const MONTH_START = `${MONTH}-01`;
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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

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
/**
 * 要介護度の表記ゆれを吸収する。
 * ほのぼのの CSV は **全角数字** (要介護３)、当方は半角 (要介護3) で持っている。
 * 正規化しないと 1,400 名近くが「食い違い」に見えてしまう。
 */
const normLevel = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

/** 利用者でないダミー登録 (職員のスケジュール用に利用者として登録されている) */
const isDummy = (name) => /^[★◆◎●■☆〇○◇▲△▼▽※＊*]/.test((name ?? "").trim());

async function main() {
  console.log(`=== 利用者マスタ取込 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const base = readCsv("基本情報_______.CSV");
  const hoken = readCsv("介護保険1.CSV");
  const kohi = readCsv("公費1.CSV");
  console.log(`  基本情報 ${base.rows.length} 行 / 介護保険 ${hoken.rows.length} 行 / 公費 ${kohi.rows.length} 行`);

  // 基本情報: 利用者番号 → プロフィール
  const B = { no: 0, name: 3, kana: 6, sex: 8, birth: 11, zip: 12, addr: 13, tel: 14, mobile: 15, died: 22 };
  const profile = new Map();
  let dummies = 0;
  for (const r of base.rows) {
    if (r.length <= B.died) continue;
    if (isDummy(r[B.name])) { dummies++; continue; }
    profile.set(r[B.no], {
      name: r[B.name], furigana: r[B.kana] || null, gender: r[B.sex] || null,
      birth_date: iso(r[B.birth]), postal_code: r[B.zip] || null,
      address: r[B.addr] || null, phone: r[B.tel] || r[B.mobile] || null,
      died: iso(r[B.died]),
    });
  }
  console.log(`  基本情報から ${profile.size} 名 (ダミー登録 ${dummies} 件を除外)`);

  // 介護保険: (保険者, 被保番) → 対象月に有効な認定
  const H = { no: 0, insured: 18, insurer: 39, level: 25, certFrom: 27, certTo: 28,
    rate: 21, office: 35, cm: 36, limit: 31 };
  const certs = new Map();
  for (const r of hoken.rows) {
    if (r.length <= H.cm) continue;
    const from = iso(r[H.certFrom]), to = iso(r[H.certTo]);
    if (!from || !to) continue;
    if (from > MONTH_END || to < MONTH_START) continue;      // 対象月に有効な認定だけ
    const key = `${r[H.insurer]}|${r[H.insured]}`;
    const cur = certs.get(key);
    if (!cur || from > cur.from) {
      certs.set(key, { no: r[H.no], from, to, level: r[H.level], rate: r[H.rate],
        office: r[H.office], cm: r[H.cm], limit: r[H.limit] });
    }
  }
  console.log(`  ${MONTH} に有効な認定 ${certs.size} 名`);

  const K = { no: 0, futan: 3, jukyu: 4, from: 6, to: 7, honnin: 15 };
  const kohiByNo = new Map();
  for (const r of kohi.rows) {
    if (r.length <= K.honnin) continue;
    const from = iso(r[K.from]), to = iso(r[K.to]);
    if (!from || !to || from > MONTH_END || to < MONTH_START) continue;
    if (!kohiByNo.has(r[K.no])) kohiByNo.set(r[K.no], []);
    kohiByNo.get(r[K.no]).push({ futan: r[K.futan], jukyu: r[K.jukyu], from, to, honnin: r[K.honnin] });
  }
  console.log(`  ${MONTH} に有効な公費 ${kohiByNo.size} 名\n`);

  // 当方の利用者と突合 (保険者+被保番)
  let ins = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("client_insurance_records")
      .select("client_id, insurer_number, insured_number, care_level, certification_start_date, certification_end_date, clients(name, user_number)")
      .order("id").range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    ins = ins.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const mine = new Map();
  for (const r of ins) {
    if (!r.insurer_number || !r.insured_number) continue;
    const k = `${r.insurer_number}|${r.insured_number}`;
    if (!mine.has(k)) mine.set(k, []);
    mine.get(k).push(r);
  }

  const diffs = [], onlyHono = [];
  for (const [key, c] of certs) {
    const rows = mine.get(key);
    if (!rows) { onlyHono.push({ key, c }); continue; }
    const ids = [...new Set(rows.map((x) => x.client_id))];
    if (ids.length > 1) continue;                             // 重複は別途
    const r = rows[0];
    const d = [];
    if (normLevel(r.care_level) !== normLevel(c.level)) d.push(`要介護度: ${r.care_level} → ${c.level}`);
    if ((r.certification_start_date ?? "") !== c.from) d.push(`認定開始: ${r.certification_start_date} → ${c.from}`);
    if ((r.certification_end_date ?? "") !== c.to) d.push(`認定終了: ${r.certification_end_date} → ${c.to}`);
    if (d.length) diffs.push({ name: r.clients?.name ?? "?", key, d });
  }

  console.log(`  当方と食い違う認定 ${diffs.length} 名`);
  for (const x of diffs.slice(0, 25)) {
    console.log(`     ${x.name.padEnd(14)} [${x.key}]`);
    for (const y of x.d) console.log(`         ${y}`);
  }
  if (diffs.length > 25) console.log(`     … 他 ${diffs.length - 25} 名`);
  console.log(`\n  ほのぼのにあり当方に無い ${onlyHono.length} 名`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で認定を是正します。"); return; }

  for (const x of diffs) {
    const rows = mine.get(x.key);
    const c = certs.get(x.key);
    const { error } = await sb.from("client_insurance_records")
      .update({ care_level: normLevel(c.level), certification_start_date: c.from, certification_end_date: c.to,
        updated_at: new Date().toISOString() })
      .eq("client_id", rows[0].client_id).eq("insured_number", x.key.split("|")[1]);
    if (error) { console.error(`✗ ${x.name}: ${error.message}`); process.exit(1); }
    console.log(`  ✓ ${x.name}`);
  }
  console.log(`\n✓ ${diffs.length} 名の認定を是正しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
