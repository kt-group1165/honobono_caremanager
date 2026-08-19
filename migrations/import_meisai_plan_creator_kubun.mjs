// ============================================================================
// 居宅サービス計画作成者区分 を ほのぼの「介護請求(明細付)_一覧.CSV」から取り込む。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   明細書 基本情報 (7131-01 / 71R1-01) の 項19 居宅サービス計画作成区分コード。
//     1 = 居宅介護支援事業所作成 / 2 = 被保険者(自己)作成 /
//     3 = 介護予防支援事業所・地域包括支援センター作成
//   当方は 介護給付=1固定 / 総合事業=3固定 で出していたが、**実際は利用者ごとに違う**。
//   ほのぼの実伝送 274 件で 1 が 113 / 3 が 161 と割れており、
//   同じ計画作成事業所でも利用者によって値が違う (事業所名からも導出できない。
//   「包括」を含む名称でも区分1 が 12 件ある)。
//   → 一覧CSV の「居宅サービス計画作成者区分」列が唯一の出所。
//
//   ⚠ これは実績ではなく**設定値**。伝送そのものではなく請求帳票 (一覧CSV) から取る。
//
//   TARGET_MONTH=2026-07 AREA_DIR=四街道 TAG=四街道 OFFICE_ID=<uuid> \
//     node migrations/import_meisai_plan_creator_kubun.mjs            # DRY RUN
//   … --execute で投入
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import iconv from "encoding-japanese";
import { findDataFile } from "./_meisai_files.mjs";

const EXECUTE = process.argv.includes("--execute");
const TARGET_MONTH = process.env.TARGET_MONTH || "2026-06";
const YM = TARGET_MONTH.replace("-", "");
const AREA_DIR = process.env.AREA_DIR || "茂原";
const TAG = process.env.TAG || "";
const OFFICE_ID = process.env.OFFICE_ID || "";
const TENANT = "kt-group";
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

/** ほのぼのの表記 → IF 仕様の区分コード */
const KUBUN = {
  "居宅介護支援事業者作成": "1",
  "被保険者自己作成": "2",
  "介護予防支援事業者作成": "3",
};

if (!OFFICE_ID) { console.error("✗ OFFICE_ID を指定してください"); process.exit(1); }

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

const readCsv = (p) =>
  iconv
    .convert(readFileSync(p), { to: "UNICODE", from: "SJIS", type: "string" })
    .split(/\r?\n/)
    .filter((l) => l.length)
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")));

async function main() {
  console.log(`=== 居宅サービス計画作成者区分 取込 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ${AREA_DIR} ${TARGET_MONTH} ===\n`);

  const csv = findDataFile(path.join(KAIGO, "サービス実績データ", AREA_DIR, YM), "介護請求(明細付)_一覧.CSV");
  if (!csv) { console.error(`✗ サービス実績データ/${AREA_DIR}/${YM} 配下に 介護請求(明細付)_一覧.CSV がありません`); process.exit(1); }

  const rows = readCsv(csv);
  const h = rows[0];
  const g = (n) => h.indexOf(n);
  const iNum = g("利用者番号"), iKubun = g("居宅サービス計画作成者区分"), iYm = g("提供年月");
  if (iKubun < 0) { console.error("✗ 一覧CSV に「居宅サービス計画作成者区分」列がありません"); process.exit(1); }

  // 利用者ごとに 1 値 (同じ利用者は同じ区分。割れたら警告)
  const byNum = new Map();
  const conflicts = [];
  for (const r of rows.slice(1)) {
    if ((r[iYm] || "").replace("/", "-") !== TARGET_MONTH) continue;
    const num = (r[iNum] || "").trim();
    const label = (r[iKubun] || "").trim();
    if (!num || !label) continue;
    const code = KUBUN[label];
    if (!code) { conflicts.push(`${num}: 未知の区分「${label}」`); continue; }
    const prev = byNum.get(num);
    if (prev && prev !== code) conflicts.push(`${num}: 区分が ${prev} と ${code} で割れています`);
    byNum.set(num, code);
  }
  console.log(`一覧CSV: ${byNum.size} 名 (提供年月 ${TARGET_MONTH})`);
  const dist = {};
  for (const v of byNum.values()) dist[v] = (dist[v] ?? 0) + 1;
  console.log(`  区分の内訳: ${JSON.stringify(dist)} (1=居宅介護支援 / 2=自己 / 3=介護予防支援・包括)`);
  if (conflicts.length) { console.log(`  ⚠ ${conflicts.length} 件:`); for (const c of conflicts.slice(0, 8)) console.log(`     ${c}`); }

  // 利用者番号 → client_id。TAG のファイル名は拠点で揺れる (姉ム→姉む / さつきが丘→さつき)
  // ので、完全一致 → 前方一致 の順で探す。
  const mapPath = (() => {
    const dir = path.join(KAIGO, "migrations");
    const exact = path.join(dir, `_meisai_num_to_client${TAG ? "_" + TAG : ""}.json`);
    if (existsSync(exact)) return exact;
    if (!TAG) return exact;
    const cands = readdirSync(dir).filter(
      (f) => /^_meisai_num_to_client_.*\.json$/.test(f) && !/障害/.test(f),
    );
    const hit = cands.find((f) => {
      const t = f.replace("_meisai_num_to_client_", "").replace(".json", "");
      return TAG.startsWith(t) || t.startsWith(TAG);
    });
    return hit ? path.join(dir, hit) : exact;
  })();
  if (!existsSync(mapPath)) {
    console.error(`✗ 利用者番号マッピングがありません: ${path.basename(mapPath)}`);
    console.error(`  先に import_meisai_step1_clients.mjs を同じ TAG で流してください`);
    process.exit(1);
  }
  console.log(`\nマッピング: ${path.basename(mapPath)}`);
  const numToClient = JSON.parse(readFileSync(mapPath, "utf8"));

  // 既存の計画単位数行 (同 office / 同月) に区分を**追記**する。
  // ⚠ upsert は使わない。kaigo_monthly_plan_units の UNIQUE は部分 index なので
  //   ON CONFLICT の指定に一致せず失敗する。行は plan_units 取込で既に作られている。
  const { data: existing, error: eSel } = await sb
    .from("kaigo_monthly_plan_units")
    .select("id, client_id")
    .eq("office_id", OFFICE_ID)
    .eq("target_month", `${TARGET_MONTH}-01`);
  if (eSel) { console.error(`✗ 既存行の取得に失敗: ${eSel.message}`); process.exit(1); }
  const idByClient = new Map(existing.map((r) => [r.client_id, r.id]));

  const plan = [];
  let noClient = 0, noRow = 0;
  for (const [num, code] of byNum) {
    const cid = numToClient[num];
    if (!cid) { noClient++; continue; }
    const rowId = idByClient.get(cid);
    if (!rowId) { noRow++; continue; }
    plan.push({ id: rowId, code });
  }
  console.log(`更新対象: ${plan.length} 名 (client 未登録 ${noClient} / 計画単位数行なし ${noRow})`);
  if (!EXECUTE) { console.log("※ DRY RUN。--execute で更新します。"); return; }
  if (!plan.length) { console.log("更新対象なし。"); return; }

  // 区分ごとにまとめて UPDATE (1 行ずつ叩かない)
  const byCode = new Map();
  for (const p of plan) { if (!byCode.has(p.code)) byCode.set(p.code, []); byCode.get(p.code).push(p.id); }
  let done = 0;
  for (const [code, ids] of byCode) {
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await sb
        .from("kaigo_monthly_plan_units")
        .update({ plan_creator_kubun: code })
        .in("id", ids.slice(i, i + 100));
      if (error) { console.error(`✗ 更新失敗 (区分${code}): ${error.message}`); process.exit(1); }
      done += Math.min(100, ids.length - i);
    }
  }
  console.log(`✓ 完了: ${done} 名`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
