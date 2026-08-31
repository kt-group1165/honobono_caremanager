// ============================================================================
// 認定 (client_insurance_records) の **認定年月日・担当ケアマネジャー**を
// ほのぼのの利用者マスタから埋める。
//
//   node migrations/backfill_cert_fields_from_honobono.mjs            # DRY RUN
//   node migrations/backfill_cert_fields_from_honobono.mjs --execute
//   --fill-only   既存値の是正をせず、空の行だけ埋める
//
//   保険者名の埋め戻しは別 script (backfill_insurer_name_from_honobono.mjs)。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   居宅サービス計画書 第1表の表題部に「認定年月日」「計画作成者氏名」を印字する。
//   2026-08-31 実測: 認定 7,254 件のうち 認定年月日が入っているのは 469 件だけで、
//   第1表 2,960 件のうち 2,959 件が認定年月日 空・2,956 件が作成者 空だった。
//
// ── 触る範囲 (ここを広げないこと) ──────────────────────────────────────
//   client_insurance_records の **certification_date / care_manager 列のみ**。
//   ⚠ certification_start_date / certification_end_date には触らない。
//     認定有効期間は請求に直結し、別途調査中のため。
//
// ── 認定年月日: 既存値の是正について ────────────────────────────────────
//   当方の値は **前世代の認定年月日が残っている**ことがある (最大 4,125 日 =
//   11 年前のものが 2024 年開始の認定に付いていた)。
//   そこで「認定年月日は認定有効期間の開始日の近くにあるはず」を判定に使う。
//     CSV の値のほうが開始日に近い → CSV を採る
//     そうでない                   → 当方を残して一覧に出す (人が見る)
//   2026-08-31 の実測では 131 件中 129 件が「CSV だけが妥当」で、
//   「当方だけが妥当」は 0 件だった。
//
// ── 担当ケアマネジャー: 空のときだけ入れる ──────────────────────────────
//   担当 CM は人事異動で変わる。CSV がいつ時点の担当かは行から判らないので、
//   **既に値があるものは上書きしない**。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHonobonoMaster, onlyValue, certKey } from "./_honobono_master_csv.mjs";

const EXECUTE = process.argv.includes("--execute");
const FILL_ONLY = process.argv.includes("--fill-only");
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

/** 2 つの日付の差 (日)。読めなければ null */
function dayDiff(a, b) {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(Math.round((ta - tb) / 86400000));
}

async function main() {
  console.log("=== 認定の 認定年月日・担当ケアマネジャー を ほのぼの利用者マスタから埋める ===");
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");
  if (FILL_ONLY) console.log("*** --fill-only: 空の行だけ埋める (既存値の是正はしない) ***");

  const { files, rowCount, byCert, skipped } = readHonobonoMaster(KAIGO);
  if (!files.length) { console.error("✗ 利用者データ/**/介護保険*.CSV が見つからない"); process.exit(1); }
  console.log(`CSV ${files.length} 本 / ${rowCount} 行 → 認定世代 ${byCert.size} 件`);
  skipped.forEach((s) => console.log(`  ⚠ 列が無いので読み飛ばした: ${s}`));

  const certs = await fetchAll(() => sb
    .from("client_insurance_records")
    .select("id, client_id, insurer_number, insured_number, certification_start_date, certification_date, care_manager")
    .order("id"));
  console.log(`認定 ${certs.length} 件`);

  const plan = [];
  const stat = { CSVに無い: 0, 変更なし: 0, 値が割れて採れない: 0 };
  const keptOurs = [];
  for (const c of certs) {
    const v = byCert.get(certKey(c.insurer_number, c.insured_number, c.certification_start_date));
    if (!v) { stat.CSVに無い++; continue; }

    const patch = {};
    const note = [];

    // ── 認定年月日 ──
    const csvDate = onlyValue(v.certDate);
    if (v.certDate.size > 1) stat.値が割れて採れない++;
    if (csvDate) {
      const cur = (c.certification_date ?? "").trim();
      if (!cur) {
        patch.certification_date = csvDate;
        note.push(`認定年月日: 空 → ${csvDate}`);
      } else if (cur !== csvDate && !FILL_ONLY) {
        // 認定開始日に近いほうを採る (当方には前世代の値が残っていることがある)
        const dCsv = dayDiff(csvDate, c.certification_start_date);
        const dOurs = dayDiff(cur, c.certification_start_date);
        if (dCsv !== null && dOurs !== null && dCsv < dOurs) {
          patch.certification_date = csvDate;
          note.push(`認定年月日: ${cur} (開始日から${dOurs}日) → ${csvDate} (${dCsv}日)`);
        } else {
          keptOurs.push(`開始${c.certification_start_date} 当方${cur} vs CSV${csvDate} — 当方を残した`);
        }
      }
    }

    // ── 担当ケアマネジャー (空のときだけ) ──
    const csvCm = onlyValue(v.careManager);
    if (csvCm && !(c.care_manager ?? "").trim()) {
      patch.care_manager = csvCm;
      note.push(`担当CM: 空 → ${csvCm}`);
    }

    if (!Object.keys(patch).length) { stat.変更なし++; continue; }
    plan.push({ id: c.id, patch, note });
  }

  const nDate = plan.filter((p) => p.patch.certification_date).length;
  const nCm = plan.filter((p) => p.patch.care_manager).length;
  console.log("");
  console.log(`更新 ${plan.length} 件 (認定年月日 ${nDate} / 担当CM ${nCm})`);
  console.log(`  変更なし ${stat.変更なし} / CSV に無い ${stat.CSVに無い} / CSV 側で値が割れている ${stat.値が割れて採れない}`);
  plan.slice(0, 12).forEach((p) => console.log(`   ${p.note.join(" , ")}`));
  if (plan.length > 12) console.log(`   … 他 ${plan.length - 12} 件`);
  if (keptOurs.length) {
    console.log(`  当方の値を残した ${keptOurs.length} 件 (CSV のほうが開始日から遠い — 人が見ること):`);
    keptOurs.slice(0, 10).forEach((k) => console.log("     " + k));
  }

  if (!EXECUTE) { console.log("\nDRY RUN。--execute で反映する。"); return; }

  let ok = 0, ng = 0;
  for (const p of plan) {
    const { error } = await sb.from("client_insurance_records").update(p.patch).eq("id", p.id);
    if (error) { ng++; console.error(`  ✗ ${p.id}: ${error.message}`); continue; }
    ok++;
    if (ok % 500 === 0) console.log(`  … ${ok}/${plan.length}`);
  }
  console.log(`\n反映 ${ok} 件 / 失敗 ${ng} 件`);
  if (ng) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
