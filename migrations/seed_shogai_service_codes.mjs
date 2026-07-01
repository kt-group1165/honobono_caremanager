// 障害福祉サービスコード seed (令和6年報酬改定版)
// 対応サービス:
//   居宅介護 (身体介護 / 家事援助 / 通院等介助(身体あり/なし) / 通院等乗降介助)
//   重度訪問介護
//   行動援護
//   同行援護 (身体介護あり/なし)
//
// 単位数は令和6年報酬改定単位数表 (国保連告示) に準拠した代表的なもの。
// 網羅性: 主要時間帯 + 主要加算のみ (夜間・早朝・深夜割増、特別地域加算等は Phase 2 で追加)
//
// 実行:
//   node migrations/seed_shogai_service_codes.mjs
//   node migrations/seed_shogai_service_codes.mjs --execute
import { createClient } from "@supabase/supabase-js";
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

const FY = 2024;  // 令和6年報酬改定

// ─────────────────────────────────────────────────────
// 居宅介護 サービスコード (代表)
// ─────────────────────────────────────────────────────
const CODES = [
  // ── 居宅介護 身体介護 (令和6年 単位数表 抜粋)
  { st: "居宅介護", cat: "身体介護", code: "111111", name: "居宅介護 身体介護 30分未満", unit: 254, min: 0, max: 30, tb: "30分未満" },
  { st: "居宅介護", cat: "身体介護", code: "111112", name: "居宅介護 身体介護 30分以上1時間未満", unit: 402, min: 30, max: 60, tb: "30分〜1時間" },
  { st: "居宅介護", cat: "身体介護", code: "111113", name: "居宅介護 身体介護 1時間以上1時間30分未満", unit: 587, min: 60, max: 90, tb: "1時間〜1時間30分" },
  { st: "居宅介護", cat: "身体介護", code: "111114", name: "居宅介護 身体介護 1時間30分以上2時間未満", unit: 671, min: 90, max: 120, tb: "1時間30分〜2時間" },
  { st: "居宅介護", cat: "身体介護", code: "111115", name: "居宅介護 身体介護 2時間以上2時間30分未満", unit: 754, min: 120, max: 150, tb: "2時間〜2時間30分" },
  { st: "居宅介護", cat: "身体介護", code: "111116", name: "居宅介護 身体介護 2時間30分以上3時間未満", unit: 837, min: 150, max: 180, tb: "2時間30分〜3時間" },
  { st: "居宅介護", cat: "身体介護", code: "111117", name: "居宅介護 身体介護 3時間以上 (30分ごと)", unit: 83, min: 180, max: null, tb: "3時間以上 (30分ごと 83単位)" },

  // ── 居宅介護 家事援助
  { st: "居宅介護", cat: "家事援助", code: "112111", name: "居宅介護 家事援助 30分未満", unit: 105, min: 0, max: 30, tb: "30分未満" },
  { st: "居宅介護", cat: "家事援助", code: "112112", name: "居宅介護 家事援助 30分以上45分未満", unit: 152, min: 30, max: 45, tb: "30分〜45分" },
  { st: "居宅介護", cat: "家事援助", code: "112113", name: "居宅介護 家事援助 45分以上1時間未満", unit: 196, min: 45, max: 60, tb: "45分〜1時間" },
  { st: "居宅介護", cat: "家事援助", code: "112114", name: "居宅介護 家事援助 1時間以上1時間15分未満", unit: 238, min: 60, max: 75, tb: "1時間〜1時間15分" },
  { st: "居宅介護", cat: "家事援助", code: "112115", name: "居宅介護 家事援助 1時間15分以上1時間30分未満", unit: 271, min: 75, max: 90, tb: "1時間15分〜1時間30分" },
  { st: "居宅介護", cat: "家事援助", code: "112116", name: "居宅介護 家事援助 1時間30分以上 (15分ごと)", unit: 34, min: 90, max: null, tb: "1時間30分以上 (15分ごと 34単位)" },

  // ── 居宅介護 通院等介助 (身体介護あり)
  { st: "居宅介護", cat: "通院等介助 (身体介護あり)", code: "113111", name: "通院等介助(身体あり) 30分未満", unit: 254, min: 0, max: 30, tb: "30分未満" },
  { st: "居宅介護", cat: "通院等介助 (身体介護あり)", code: "113112", name: "通院等介助(身体あり) 30分以上1時間未満", unit: 402, min: 30, max: 60, tb: "30分〜1時間" },
  { st: "居宅介護", cat: "通院等介助 (身体介護あり)", code: "113113", name: "通院等介助(身体あり) 1時間以上1時間30分未満", unit: 587, min: 60, max: 90, tb: "1時間〜1時間30分" },

  // ── 居宅介護 通院等介助 (身体介護なし)
  { st: "居宅介護", cat: "通院等介助 (身体介護なし)", code: "114111", name: "通院等介助(身体なし) 30分未満", unit: 105, min: 0, max: 30, tb: "30分未満" },
  { st: "居宅介護", cat: "通院等介助 (身体介護なし)", code: "114112", name: "通院等介助(身体なし) 30分以上1時間未満", unit: 196, min: 30, max: 60, tb: "30分〜1時間" },

  // ── 居宅介護 通院等乗降介助
  { st: "居宅介護", cat: "通院等乗降介助", code: "115111", name: "通院等乗降介助 (1回)", unit: 100, min: null, max: null, tb: "1回" },

  // ── 重度訪問介護 (1時間刻み、以降 30 分ごと)
  { st: "重度訪問介護", cat: null, code: "121111", name: "重度訪問介護 1時間未満", unit: 187, min: 0, max: 60, tb: "1時間未満" },
  { st: "重度訪問介護", cat: null, code: "121112", name: "重度訪問介護 1時間以上1時間30分未満", unit: 279, min: 60, max: 90, tb: "1時間〜1時間30分" },
  { st: "重度訪問介護", cat: null, code: "121113", name: "重度訪問介護 1時間30分以上2時間未満", unit: 370, min: 90, max: 120, tb: "1時間30分〜2時間" },
  { st: "重度訪問介護", cat: null, code: "121114", name: "重度訪問介護 2時間以上2時間30分未満", unit: 458, min: 120, max: 150, tb: "2時間〜2時間30分" },
  { st: "重度訪問介護", cat: null, code: "121115", name: "重度訪問介護 2時間30分以上3時間未満", unit: 548, min: 150, max: 180, tb: "2時間30分〜3時間" },
  { st: "重度訪問介護", cat: null, code: "121116", name: "重度訪問介護 3時間以上3時間30分未満", unit: 634, min: 180, max: 210, tb: "3時間〜3時間30分" },
  { st: "重度訪問介護", cat: null, code: "121117", name: "重度訪問介護 3時間30分以上 (30分ごと)", unit: 82, min: 210, max: null, tb: "3時間30分以上 (30分ごと 82単位)" },

  // ── 行動援護
  { st: "行動援護", cat: null, code: "131111", name: "行動援護 30分未満", unit: 258, min: 0, max: 30, tb: "30分未満" },
  { st: "行動援護", cat: null, code: "131112", name: "行動援護 30分以上1時間未満", unit: 407, min: 30, max: 60, tb: "30分〜1時間" },
  { st: "行動援護", cat: null, code: "131113", name: "行動援護 1時間以上1時間30分未満", unit: 599, min: 60, max: 90, tb: "1時間〜1時間30分" },
  { st: "行動援護", cat: null, code: "131114", name: "行動援護 1時間30分以上2時間未満", unit: 683, min: 90, max: 120, tb: "1時間30分〜2時間" },
  { st: "行動援護", cat: null, code: "131115", name: "行動援護 2時間以上 (30分ごと)", unit: 84, min: 120, max: null, tb: "2時間以上 (30分ごと 84単位)" },

  // ── 同行援護 (身体介護あり)
  { st: "同行援護", cat: "身体介護あり", code: "141111", name: "同行援護(身体あり) 30分未満", unit: 258, min: 0, max: 30, tb: "30分未満" },
  { st: "同行援護", cat: "身体介護あり", code: "141112", name: "同行援護(身体あり) 30分以上1時間未満", unit: 407, min: 30, max: 60, tb: "30分〜1時間" },
  { st: "同行援護", cat: "身体介護あり", code: "141113", name: "同行援護(身体あり) 1時間以上1時間30分未満", unit: 599, min: 60, max: 90, tb: "1時間〜1時間30分" },

  // ── 同行援護 (身体介護なし)
  { st: "同行援護", cat: "身体介護なし", code: "142111", name: "同行援護(身体なし) 30分未満", unit: 105, min: 0, max: 30, tb: "30分未満" },
  { st: "同行援護", cat: "身体介護なし", code: "142112", name: "同行援護(身体なし) 30分以上1時間未満", unit: 196, min: 30, max: 60, tb: "30分〜1時間" },
  { st: "同行援護", cat: "身体介護なし", code: "142113", name: "同行援護(身体なし) 1時間以上1時間30分未満", unit: 287, min: 60, max: 90, tb: "1時間〜1時間30分" },
];

// ─────────────────────────────────────────────────────
// 加算 (令和6年報酬改定 抜粋)
// ─────────────────────────────────────────────────────
const ADDONS = [
  // 特定事業所加算
  { st: "居宅介護", cat: "特定事業所加算", code: "191001", name: "特定事業所加算I (20%)", unit: 200, isPercent: true, tb: "本体単位数の 20%" },
  { st: "居宅介護", cat: "特定事業所加算", code: "191002", name: "特定事業所加算II (10%)", unit: 100, isPercent: true, tb: "本体単位数の 10%" },
  { st: "居宅介護", cat: "特定事業所加算", code: "191003", name: "特定事業所加算III (10%)", unit: 100, isPercent: true, tb: "本体単位数の 10%" },
  { st: "居宅介護", cat: "特定事業所加算", code: "191004", name: "特定事業所加算IV (5%)", unit: 50, isPercent: true, tb: "本体単位数の 5%" },
  // 特別地域加算 (15%)
  { st: "居宅介護", cat: "特別地域加算", code: "192001", name: "特別地域加算 (15%)", unit: 150, isPercent: true, tb: "本体単位数の 15%" },
  // 緊急時対応加算 (100 単位/日)
  { st: "居宅介護", cat: "緊急時対応加算", code: "193001", name: "緊急時対応加算 (100/日)", unit: 100, isPercent: false, tb: "1 日あたり 100 単位" },
  // 初回加算 (200 単位/月)
  { st: "居宅介護", cat: "初回加算", code: "194001", name: "初回加算 (200/月)", unit: 200, isPercent: false, tb: "1 月あたり 200 単位" },
  // 処遇改善加算 (加算率別: I=27.5%, II=20.3%, III=11.1%, IV=4.5% 令和6年制度統合後の目安)
  { st: "居宅介護", cat: "福祉・介護職員等処遇改善加算", code: "195001", name: "福祉・介護職員等処遇改善加算I", unit: 275, isPercent: true, tb: "本体単位数の 27.5%" },
  { st: "居宅介護", cat: "福祉・介護職員等処遇改善加算", code: "195002", name: "福祉・介護職員等処遇改善加算II", unit: 203, isPercent: true, tb: "本体単位数の 20.3%" },
  { st: "居宅介護", cat: "福祉・介護職員等処遇改善加算", code: "195003", name: "福祉・介護職員等処遇改善加算III", unit: 111, isPercent: true, tb: "本体単位数の 11.1%" },
  { st: "居宅介護", cat: "福祉・介護職員等処遇改善加算", code: "195004", name: "福祉・介護職員等処遇改善加算IV", unit: 45, isPercent: true, tb: "本体単位数の 4.5%" },

  // 重度訪問介護 加算 (代表のみ)
  { st: "重度訪問介護", cat: "特定事業所加算", code: "291001", name: "重度訪問介護 特定事業所加算I (20%)", unit: 200, isPercent: true, tb: "本体単位数の 20%" },
  { st: "重度訪問介護", cat: "重度訪問介護加算", code: "292001", name: "重度訪問介護加算 (7.5%)", unit: 75, isPercent: true, tb: "本体単位数の 7.5%" },
  { st: "重度訪問介護", cat: "初回加算", code: "294001", name: "重度訪問介護 初回加算 (200/月)", unit: 200, isPercent: false, tb: "1 月あたり 200 単位" },

  // 行動援護 加算
  { st: "行動援護", cat: "特定事業所加算", code: "391001", name: "行動援護 特定事業所加算I (20%)", unit: 200, isPercent: true, tb: "本体単位数の 20%" },

  // 同行援護 加算
  { st: "同行援護", cat: "特定事業所加算", code: "491001", name: "同行援護 特定事業所加算I (20%)", unit: 200, isPercent: true, tb: "本体単位数の 20%" },
];

async function main() {
  console.log(`\n📂 障害福祉サービスコード seed (FY=${FY})`);
  console.log(`   本体コード ${CODES.length} 件、加算 ${ADDONS.length} 件`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");

  const rows = [];
  for (const c of CODES) {
    rows.push({
      fiscal_year: FY,
      service_type: c.st,
      service_category: c.cat,
      code: c.code,
      name: c.name,
      unit_count: c.unit,
      min_minutes: c.min,
      max_minutes: c.max,
      time_bracket: c.tb,
      is_addon: false,
      is_active: true,
      notes: null,
    });
  }
  for (const a of ADDONS) {
    rows.push({
      fiscal_year: FY,
      service_type: a.st,
      service_category: a.cat,
      code: a.code,
      name: a.name,
      unit_count: a.unit,
      min_minutes: null,
      max_minutes: null,
      time_bracket: a.tb,
      is_addon: true,
      is_active: true,
      notes: a.isPercent ? "パーセント加算 (本体単位に対する百分率)" : null,
    });
  }

  // 既存 check
  const { data: existing } = await sb
    .from("shogai_service_codes")
    .select("code")
    .eq("fiscal_year", FY);
  const existingSet = new Set((existing ?? []).map((r) => r.code));
  const toInsert = rows.filter((r) => !existingSet.has(r.code));
  console.log(`  新規 ${toInsert.length} / 既存 ${existingSet.size}`);

  if (!EXECUTE) { console.log("\n(DRY RUN)"); return; }
  if (toInsert.length === 0) { console.log("すでに全件投入済 → 何もしない"); return; }

  const chunkSize = 100;
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const slice = toInsert.slice(i, i + chunkSize);
    const { error } = await sb.from("shogai_service_codes").insert(slice);
    if (error) { console.error("INSERT 失敗:", error.message); process.exit(1); }
    console.log(`  ✅ ${i + slice.length}/${toInsert.length} 投入`);
  }
  console.log("\n完了");
}

main().catch((e) => { console.error(e); process.exit(1); });
