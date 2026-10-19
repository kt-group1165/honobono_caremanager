#!/usr/bin/env node
/**
 * 居宅の利用者の 認定 (client_insurance_records) の「担当ケアマネ」(care_manager) が空のものを、
 * ほのぼのが実際に請求した明細書 (KK 8124 の 項24 = 介護支援専門員番号) から埋める。
 *
 *   TARGET_MONTH=2026-06 node migrations/fill_cert_care_manager_from_kk.mjs            # DRY RUN
 *   TARGET_MONTH=2026-06 node migrations/fill_cert_care_manager_from_kk.mjs --execute
 *
 * ── なぜ要るか (2026-10-19 実測) ─────────────────────────────────────────
 *   給与 (payroll-app) の居宅のケアマネ給与は 介護アプリの居宅の請求を写して計算する (pull_kyotaku_records_from_kaigo.mts)。
 *   担当ケアマネは その月に有効な認定の care_manager で決めるが、2026-06 は 15 件・2026-07 は 10 件 が空で、
 *   その請求は どのケアマネの件数にも入らない (給与が少なく出る)。多くは 更新後の新しい認定で 担当が引き継がれていないもの。
 *   ★ 前の認定の担当を そのまま使うのは不可: 2026-06 の 4 件で試すと 1 件 (額田トシエ 遠藤→山本) は 担当が替わっていた。
 *
 * ── 番号 → 氏名 ──────────────────────────────────────────────────────────
 *   当方の認定に care_manager が入っている人の (保険者, 被保番) を KK と突き合わせ、番号ごとに 氏名を多数決で決める。
 *   9 割以上が同じ氏名 かつ 3 件以上 のときだけ使う (それ以外の番号の人は 埋めない)
 *
 * ── 書き換えるもの / 触らないもの ───────────────────────────────────────
 *   ・その月に有効な認定 (取り込みと同じ選び方: 開始日が月末以前・終了日が月初以降で 開始日が最も新しいもの) の care_manager が空の行だけ
 *   ・(保険者, 被保番) で利用者が 1 名に決まる人だけ。KK 内で同じ人の番号が食い違うときは 1 行も書かない (exit 2)
 *   ・書き換え前の行は migrations/_backup_cert_care_manager_from_kk_<日時>.json に退避 (利用者 ID を含むので commit しない)
 *   ★ 書いたあと 給与側で pull_kyotaku_records_from_kaigo.mts を 回し直すと 件数に入る
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Encoding from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = process.env.TARGET_MONTH ?? "2026-06";
if (!/^\d{4}-\d{2}$/.test(TARGET_MONTH)) { console.error("TARGET_MONTH は YYYY-MM"); process.exit(1); }
const YM = TARGET_MONTH.replace("-", "");
const [Y, M] = TARGET_MONTH.split("-").map(Number);
const NEXT_YM = M === 12 ? `${Y + 1}01` : `${Y}${String(M + 1).padStart(2, "0")}`;
const mStart = `${TARGET_MONTH}-01`;
const mEnd = new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function fetchAll(table, select, f) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table} 取得失敗: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// 1) KK 8124 (提供年月 = 対象月) の 基本行 (明細番号 1): 保険者|被保番 → 介護支援専門員番号
//    当初分 (提供年月フォルダ) と 月遅れ (翌月フォルダ) の両方を読む
const kk = new Map();
const conflicts = [];
for (const area of readdirSync(path.join(ROOT, "伝送データ"))) {
  for (const ym of [YM, NEXT_YM]) {
    for (const d of [path.join(ROOT, "伝送データ", area, "居宅", ym, "ほのぼのから"), path.join(ROOT, "伝送データ", area, "居宅", ym)]) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => /^KK.*\.CSV$/i.test(x)).sort()) {
        const text = Encoding.convert(readFileSync(path.join(d, f)), { to: "UNICODE", from: "SJIS", type: "string" });
        for (const l of text.split(/\r?\n/)) {
          const c = l.replace(/"/g, "").split(",");
          if (c[2] !== "8124" || c[5] !== YM || c[17] !== "1" || !c[24]) continue;
          const key = `${c[6].replace(/^0+/, "")}|${c[8]}`;
          const prev = kk.get(key);
          if (prev && prev.cm !== c[24]) conflicts.push(`${area} ${key}: ${prev.cm} → ${c[24]}`);
          kk.set(key, { cm: c[24], area });
        }
      }
    }
  }
}

// 2) 当方の認定 (その月に有効なもの)
const certs = await fetchAll("client_insurance_records", "id,client_id,insurer_number,insured_number,care_manager,certification_start_date,certification_end_date",
  (q) => q.lte("certification_start_date", mEnd));
const active = certs.filter((x) => !x.certification_end_date || x.certification_end_date >= mStart);
const cidByKey = new Map();
for (const r of active) {
  const k = `${(r.insurer_number ?? "").replace(/^0+/, "")}|${r.insured_number}`;
  (cidByKey.get(k) ?? cidByKey.set(k, new Set()).get(k)).add(r.client_id);
}
// 取り込み (pull_kyotaku_records_from_kaigo.mts) と同じ選び方: 開始日が最も新しい有効な認定
const certOf = (cid) => active.filter((x) => x.client_id === cid)
  .sort((a, b) => (b.certification_start_date ?? "").localeCompare(a.certification_start_date ?? ""))[0];

// 3) 番号 → 氏名 (担当が入っている人で多数決)
const votes = new Map();
const norm = (s) => String(s ?? "").replace(/[\s　]+/g, " ").trim();
for (const [key, h] of kk) {
  const cids = [...(cidByKey.get(key) ?? [])];
  if (cids.length !== 1) continue;
  const name = norm(certOf(cids[0])?.care_manager);
  if (!name) continue;
  const v = votes.get(h.cm) ?? new Map();
  v.set(name, (v.get(name) ?? 0) + 1);
  votes.set(h.cm, v);
}
const nameOf = new Map();
const weak = [];
for (const [cm, v] of votes) {
  const s = [...v].sort((a, b) => b[1] - a[1]);
  const tot = s.reduce((a, b) => a + b[1], 0);
  if (s[0][1] >= 3 && s[0][1] / tot >= 0.9) nameOf.set(cm, s[0][0]);
  else weak.push(`${cm}: ${s.map(([n, c]) => `${n} ${c}`).join(" / ")}`);
}

// 4) 埋める行
const updates = [];
const skipped = { noClient: 0, noCert: 0, filled: 0, noName: 0 };
for (const [key, h] of kk) {
  const cids = [...(cidByKey.get(key) ?? [])];
  if (cids.length !== 1) { skipped.noClient++; continue; }
  const cert = certOf(cids[0]);
  if (!cert) { skipped.noCert++; continue; }
  if (norm(cert.care_manager)) { skipped.filled++; continue; }
  const name = nameOf.get(h.cm);
  if (!name) { skipped.noName++; console.log(`  ⚠ 番号 ${h.cm} の氏名が決まらない: ${h.area} ${key}`); continue; }
  updates.push({ cert, key, area: h.area, cm: h.cm, name });
}

console.log(`=== 認定の担当ケアマネを KK で埋める ${EXECUTE ? "【本番 EXECUTE】" : "【DRY RUN】"} 対象月=${TARGET_MONTH} ===`);
console.log(`KK 居宅レセプト ${kk.size} 名 / 番号→氏名 ${nameOf.size} 個 (決まらない ${weak.length})`);
console.log(`埋める ${updates.length} 件 (触らない: 担当あり ${skipped.filled} / 利用者不定 ${skipped.noClient} / 有効な認定なし ${skipped.noCert} / 氏名が決まらない ${skipped.noName})`);
for (const w of weak) console.log(`  番号の氏名が割れる ${w}`);
for (const u of updates) console.log(`  ${u.area.padEnd(6, "　")} ${u.key}  認定 ${u.cert.certification_start_date}〜${u.cert.certification_end_date ?? ""}  担当 空 → ${u.name} (${u.cm})`);
if (conflicts.length) {
  console.log(`\n✗ KK 内で同じ人の番号が食い違う ${conflicts.length} 件 (1 行も書かない):`);
  for (const c of conflicts) console.log("  " + c);
  process.exit(2);
}
if (!EXECUTE) { console.log("\n(DRY RUN。書き込むには --execute)"); process.exit(0); }

// ★ 秒と対象月まで入れる (2026-10-19 に 7 月→6 月と続けて回したら 同じ分の名前になり 7 月の退避が上書きされた)
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const backup = path.join(ROOT, "migrations", `_backup_cert_care_manager_from_kk_${YM}_${stamp}.json`);
if (existsSync(backup)) { console.error(`✗ 退避ファイルが既にある: ${backup}`); process.exit(1); }
writeFileSync(backup, JSON.stringify(updates.map((u) => u.cert)));
console.log(`\n退避 ${updates.length} 行 → ${backup}`);
let ok = 0;
for (const u of updates) {
  // 空のときだけ書く (この間に人が入れていたら上書きしない)
  const { error, count } = await sb.from("client_insurance_records").update({ care_manager: u.name }, { count: "exact" })
    .eq("id", u.cert.id).or("care_manager.is.null,care_manager.eq.");
  if (error) { console.error(`✗ ${u.key} 更新失敗: ${error.message}`); process.exit(1); }
  if (count !== 1) { console.error(`✗ ${u.key} 更新件数 ${count} (1 のはず)`); process.exit(1); }
  ok++;
}
console.log(`✓ ${ok} 件 更新`);
