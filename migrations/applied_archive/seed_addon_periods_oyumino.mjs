/**
 * Hana ヘルパーステーションおゆみ野 に処遇改善加算の期間指定を投入する。
 *
 * 背景: 期中の区分変更 (5月まで処遇改善Ⅱ・6月からⅡ2) を月単位で扱うため
 * kaigo_office_addon_periods (期間指定テーブル) に 2 行を INSERT する。
 *
 * 投入内容:
 *   ① { formula_code: '116274', start_month: null,      end_month: '2026-05', notes: '処遇改善加算Ⅱ (R8/5まで)' }
 *   ② { formula_code: '116184', start_month: '2026-06', end_month: null,      notes: '処遇改善加算Ⅱ2 (R8/6から)' }
 *
 * 冪等性: 同一 office_id + formula_code の行が既にあれば skip。
 *
 * Usage:
 *   node migrations/seed_addon_periods_oyumino.mjs            # DRY RUN
 *   node migrations/seed_addon_periods_oyumino.mjs --execute  # 本番
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL =
  envKaigo.NEXT_PUBLIC_SUPABASE_URL ||
  envCal.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  envKaigo.SUPABASE_SERVICE_ROLE_KEY ||
  envCal.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

const EXECUTE = process.argv.includes("--execute");
// 「Ｈａｎａ居宅支援センターおゆみ野」と区別するため ヘルパーステーション を含める
const OFFICE_NAME_PATTERN = "%ヘルパーステーションおゆみ野%"; // Ｈａｎａヘルパーステーションおゆみ野

const PERIOD_ROWS = [
  {
    formula_code: "116274",
    start_month: null,
    end_month: "2026-05",
    notes: "処遇改善加算Ⅱ (R8/5まで)",
  },
  {
    formula_code: "116184",
    start_month: "2026-06",
    end_month: null,
    notes: "処遇改善加算Ⅱ2 (R8/6から)",
  },
];

const sb = createClient(SB_URL, SB_KEY);

async function main() {
  console.log(EXECUTE ? "=== EXECUTE MODE ===" : "=== DRY RUN (--execute で本番実行) ===");

  // 1) 対象事業所を特定 (offices.name + app_type='kaigo-app')
  const { data: offices, error: officeError } = await sb
    .from("offices")
    .select("id, name, tenant_id, applied_formula_codes")
    .eq("app_type", "kaigo-app")
    .ilike("name", OFFICE_NAME_PATTERN);
  if (officeError) {
    console.error("❌ offices 取得失敗:", officeError.message);
    process.exit(1);
  }
  if (!offices || offices.length === 0) {
    console.error(`❌ 事業所が見つかりません (name ilike '${OFFICE_NAME_PATTERN}', app_type='kaigo-app')`);
    process.exit(1);
  }
  if (offices.length > 1) {
    console.error("❌ 事業所が複数ヒットしました。特定できないため中止:");
    for (const o of offices) console.error(`   - ${o.name} (${o.id})`);
    process.exit(1);
  }
  const office = offices[0];
  console.log(`対象事業所: ${office.name}`);
  console.log(`  office_id: ${office.id}`);
  console.log(`  tenant_id: ${office.tenant_id}`);
  console.log(`  現在の applied_formula_codes: ${JSON.stringify(office.applied_formula_codes ?? [])}`);

  // 2) 既存行チェック (idempotent: 同 office + formula_code は skip)
  const { data: existing, error: existError } = await sb
    .from("kaigo_office_addon_periods")
    .select("id, formula_code, start_month, end_month, notes")
    .eq("office_id", office.id)
    .in("formula_code", PERIOD_ROWS.map((r) => r.formula_code));
  if (existError) {
    if (existError.code === "42P01" || existError.code === "PGRST205") {
      console.error("❌ kaigo_office_addon_periods テーブルが未作成です。先に DDL を適用してください。");
      console.log("\n(参考) DRY RUN 予定内容:");
      for (const row of PERIOD_ROWS) {
        console.log(
          `  - code=${row.formula_code} start=${row.start_month ?? "(最初から)"} end=${row.end_month ?? "(無期限)"} notes=${row.notes}`,
        );
      }
    } else {
      console.error("❌ 既存行チェック失敗:", existError.message);
    }
    process.exit(1);
  }
  const existingCodes = new Set((existing ?? []).map((r) => r.formula_code));

  // 3) INSERT 対象を組み立て
  const toInsert = [];
  for (const row of PERIOD_ROWS) {
    if (existingCodes.has(row.formula_code)) {
      const ex = (existing ?? []).find((r) => r.formula_code === row.formula_code);
      console.log(`⏭  skip: ${row.formula_code} は既存 (start=${ex?.start_month ?? "null"}, end=${ex?.end_month ?? "null"})`);
      continue;
    }
    toInsert.push({
      office_id: office.id,
      tenant_id: office.tenant_id,
      formula_code: row.formula_code,
      start_month: row.start_month,
      end_month: row.end_month,
      notes: row.notes,
    });
  }

  if (toInsert.length === 0) {
    console.log("✅ 追加対象なし (すべて既存)。何もしません。");
    return;
  }

  console.log(`\nINSERT 予定 ${toInsert.length} 件:`);
  for (const r of toInsert) {
    console.log(
      `  - code=${r.formula_code} start=${r.start_month ?? "(最初から)"} end=${r.end_month ?? "(無期限)"} notes=${r.notes}`,
    );
  }

  if (!EXECUTE) {
    console.log("\n(DRY RUN のため INSERT していません。--execute で実行)");
    return;
  }

  // 4) INSERT
  const { error: insertError } = await sb.from("kaigo_office_addon_periods").insert(toInsert);
  if (insertError) {
    console.error("❌ INSERT 失敗:", insertError.message);
    process.exit(1);
  }

  // 5) 件数確認 (実際に入ったか verify)
  const { data: after, error: afterError } = await sb
    .from("kaigo_office_addon_periods")
    .select("formula_code, start_month, end_month, notes")
    .eq("office_id", office.id)
    .order("start_month", { ascending: true, nullsFirst: true });
  if (afterError) {
    console.error("❌ 事後確認失敗:", afterError.message);
    process.exit(1);
  }
  console.log(`\n✅ INSERT 完了。現在の期間指定 (${(after ?? []).length} 件):`);
  for (const r of after ?? []) {
    console.log(
      `  - code=${r.formula_code} start=${r.start_month ?? "(最初から)"} end=${r.end_month ?? "(無期限)"} notes=${r.notes ?? ""}`,
    );
  }
}

main().catch((e) => {
  console.error("❌ 予期しないエラー:", e instanceof Error ? e.message : e);
  process.exit(1);
});
