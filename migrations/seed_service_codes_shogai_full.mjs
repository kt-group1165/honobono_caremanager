// 障害福祉サービス コード baseline 全 category 網羅 seed
//   令和6年報酬改定 (2024-04-01 施行) + 令和7年10月 就労選択支援 新設分
//
// 目的:
//   spec で列挙された 26 category のうち、DB に薄い category に対して
//   "baseline 単位数" (= 主要 pattern 3-10 件) を追加し、UI や見積で
//   使えるようにする。
//
//   注意: DB (kaigo_service_codes system='障害') は既に厚労省 CSV 由来の
//   101,763 件が投入済で、全 26 category を網羅している。ゆえに DRY RUN
//   では衝突 skip が発生するのが正常。本 script は「baseline pattern が
//   確実に居る」ことの guarantee 用と、将来の追加基盤として置く。
//
// ユニーク: (system, service_code, valid_from) 3 列複合
// service_code は 6桁 (category prefix 2桁 + '9' + 3桁 通番) で
// 既存 code (11xxxx-72xxxx の連番) との衝突を避ける。
//
// 実行:
//   node --env-file=.env.local migrations/seed_service_codes_shogai_full.mjs
//   node --env-file=.env.local migrations/seed_service_codes_shogai_full.mjs --execute

import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }

const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

const V_R6 = "2024-04-01";       // 令和6年報酬改定 施行
const V_SHURO_SENTAKU = "2025-10-01"; // 就労選択支援 施行 (令和7年10月)
const NOTES_TAG = "[fake baseline-shogai-full]"; // seed marker

const rows = [];

// ------------------------------------------------------------
// 21 療養介護 (区分 5-6 × 定員規模)
// ------------------------------------------------------------
// spec: 「区分5-6 × 単位」
{
  const cat = "21", cn = "療養介護";
  // 令和6年改定 baseline (定員41-60 想定)
  const patterns = [
    ["区分6", 974], ["区分5", 900], ["区分4", 861], ["区分3", 782],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `療養介護 baseline ${label} (定員41-60)`,
      units, unit_type: "1日につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 24 短期入所 (福祉型 + 医療型)
// ------------------------------------------------------------
// spec: 「区分3-6 × 1-30日 の主要 pattern」
{
  const cat = "24", cn = "短期入所(福祉型)";
  // 福祉型: 区分3-6 (定員21-50 想定) + 併設 vs 単独
  const patterns = [
    ["福祉型 区分6 (併設)", 923],
    ["福祉型 区分5 (併設)", 784],
    ["福祉型 区分4 (併設)", 648],
    ["福祉型 区分3 (併設)", 583],
    ["福祉型 区分2 (併設)", 509],
    ["医療型 区分6 (単独)", 2670],
    ["医療型 区分5 (単独)", 2670],
    ["医療型 区分4 (単独)", 1954],
    ["医療型 区分3 (単独)", 1954],
    ["医療型 区分3以下 (単独)", 984],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `短期入所 baseline ${label}`,
      units, unit_type: "1日につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 32 施設入所支援 (区分3-6)
// ------------------------------------------------------------
{
  const cat = "32", cn = "施設入所支援";
  const patterns = [
    ["区分6", 561], ["区分5", 476], ["区分4", 392],
    ["区分3", 314], ["区分2", 187],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `施設入所支援 baseline ${label}`,
      units, unit_type: "1日につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 33 共同生活援助 (GH) 介護包括型 / 外部サービス利用型
// ------------------------------------------------------------
// spec: 「区分3-6 × 介護包括型 / 外部利用型」
{
  const cat = "33", cn = "共同生活援助";
  const patterns = [
    // 介護サービス包括型 (区分別)
    ["介護包括型 区分6", 758],
    ["介護包括型 区分5", 604],
    ["介護包括型 区分4", 476],
    ["介護包括型 区分3", 383],
    ["介護包括型 区分2", 269],
    ["介護包括型 区分1以下", 194],
    // 日中サービス支援型
    ["日中サービス支援型 区分6", 1105],
    ["日中サービス支援型 区分5", 941],
    ["日中サービス支援型 区分4", 800],
    // 外部サービス利用型
    ["外部サービス利用型 区分6以下", 171],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `共同生活援助 baseline ${label}`,
      units, unit_type: "1日につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 41 自立訓練 (機能訓練) 通所 baseline
// ------------------------------------------------------------
{
  const cat = "41", cn = "自立訓練(機能訓練)";
  const patterns = [
    ["通所 定員20以下 (Ⅰ)", 795],
    ["通所 定員21-40 (Ⅱ)", 732],
    ["通所 定員41-60 (Ⅲ)", 695],
    ["訪問による自立訓練 1時間未満", 260],
    ["訪問による自立訓練 1時間以上", 517],
    ["短期滞在加算", 180],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `自立訓練(機能訓練) baseline ${label}`,
      units, unit_type: label.includes("加算") ? "加算" : "1日につき",
      calculation_type: label.includes("加算") ? "加算" : "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 42 自立訓練 (生活訓練) 通所 baseline
// ------------------------------------------------------------
{
  const cat = "42", cn = "自立訓練(生活訓練)";
  const patterns = [
    ["通所 定員20以下 (Ⅰ)", 749],
    ["通所 定員21-40 (Ⅱ)", 693],
    ["通所 定員41-60 (Ⅲ)", 659],
    ["訪問による生活訓練 1時間未満", 260],
    ["訪問による生活訓練 1時間以上", 517],
    ["宿泊型自立訓練 (Ⅰ)", 274],
    ["宿泊型自立訓練 (Ⅱ)", 245],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `自立訓練(生活訓練) baseline ${label}`,
      units, unit_type: "1日につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 47 就労定着支援 (利用期間別 30/60/90 日ではなく 1-3年経過 単位)
// ------------------------------------------------------------
// 令和6年改定: 就労定着率で 5 段階
{
  const cat = "47", cn = "就労定着支援";
  const patterns = [
    ["就労定着率 9割以上 (Ⅰ)", 3449],
    ["就労定着率 8割以上9割未満 (Ⅱ)", 3348],
    ["就労定着率 7割以上8割未満 (Ⅲ)", 2768],
    ["就労定着率 5割以上7割未満 (Ⅳ)", 2234],
    ["就労定着率 3割以上5割未満 (Ⅴ)", 1690],
    ["就労定着率 1割以上3割未満 (Ⅵ)", 1435],
    ["就労定着率 1割未満 (Ⅶ)", 1355],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `就労定着支援 baseline ${label}`,
      units, unit_type: "1月につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 48 就労選択支援 (令和7年10月新設)
// ------------------------------------------------------------
{
  const cat = "48", cn = "就労選択支援";
  const patterns = [
    ["就労選択支援 基本 (定員10以下)", 1210],
    ["就労選択支援 基本 (定員11-20)", 1088],
    ["就労選択支援 基本 (定員21以上)", 980],
    ["就労選択支援 モニタリング加算 (100/月)", 100],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `就労選択支援 baseline ${label}`,
      units,
      unit_type: label.includes("加算") ? "加算" : "1日につき",
      calculation_type: label.includes("加算") ? "加算" : "基本",
      valid_from: V_SHURO_SENTAKU, valid_until: null,
      notes: `令和7年10月施行 (就労選択支援 新設) baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 62 医療型児童発達支援
// ------------------------------------------------------------
{
  const cat = "62", cn = "医療型児童発達支援";
  const patterns = [
    ["肢体不自由児対象 (Ⅰ)", 487],
    ["重症心身障害児対象 (Ⅱ)", 600],
    ["未就学児 加配加算", 300],
    ["集中的支援加算", 700],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `医療型児童発達支援 baseline ${label}`,
      units,
      unit_type: label.includes("加算") ? "加算" : "1日につき",
      calculation_type: label.includes("加算") ? "加算" : "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 65 居宅訪問型児童発達支援
// ------------------------------------------------------------
{
  const cat = "65", cn = "居宅訪問型児童発達支援";
  const patterns = [
    ["居宅訪問型児童発達支援 基本", 1066],
    ["居宅訪問型 訪問支援員特別加算Ⅰ", 850],
    ["居宅訪問型 訪問支援員特別加算Ⅱ", 700],
    ["居宅訪問型 家族支援加算Ⅰ (居宅同席)", 300],
    ["居宅訪問型 家族支援加算Ⅱ (オンライン等)", 100],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `居宅訪問型児童発達支援 baseline ${label}`,
      units,
      unit_type: label.includes("加算") ? "加算" : "1日につき",
      calculation_type: label.includes("加算") ? "加算" : "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 72 医療型障害児入所施設
// ------------------------------------------------------------
{
  const cat = "72", cn = "医療型障害児入所施設";
  const patterns = [
    ["医療型障害児入所 Ⅰ (自閉症)", 380],
    ["医療型障害児入所 Ⅱ (肢体不自由)", 189],
    ["医療型障害児入所 Ⅲ (重症心身)", 988],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `医療型障害児入所施設 baseline ${label}`,
      units, unit_type: "1日につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 52 計画相談支援
// ------------------------------------------------------------
{
  const cat = "52", cn = "計画相談支援";
  const patterns = [
    ["サービス利用支援 (Ⅰ)", 1572],
    ["サービス利用支援 (Ⅱ)", 732],
    ["継続サービス利用支援 (Ⅰ)", 1288],
    ["継続サービス利用支援 (Ⅱ)", 602],
    ["強化型 利用支援 (Ⅰ)", 2014],
    ["強化型 継続支援 (Ⅰ)", 1720],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `計画相談支援 baseline ${label}`,
      units, unit_type: "1月につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 55 障害児相談支援
// ------------------------------------------------------------
{
  const cat = "55", cn = "障害児相談支援";
  const patterns = [
    ["障害児支援利用援助 (Ⅰ)", 1766],
    ["障害児支援利用援助 (Ⅱ)", 815],
    ["継続障害児支援利用援助 (Ⅰ)", 1448],
    ["継続障害児支援利用援助 (Ⅱ)", 662],
    ["強化型 支援利用援助 (Ⅰ)", 2201],
    ["強化型 継続支援 (Ⅰ)", 1896],
  ];
  patterns.forEach(([label, units], i) => {
    rows.push({
      system: "障害", service_category: cat, service_category_name: cn,
      service_code: `${cat}9${String(i + 1).padStart(3, "0")}`,
      service_name: `障害児相談支援 baseline ${label}`,
      units, unit_type: "1月につき", calculation_type: "基本",
      valid_from: V_R6, valid_until: null,
      notes: `令和6年報酬改定 baseline ${NOTES_TAG}`,
    });
  });
}

// ------------------------------------------------------------
// 実行
// ------------------------------------------------------------
async function main() {
  console.log(`\n📂 障害福祉 baseline seed (令和6年報酬改定 + 令和7年10月 新設)`);
  console.log(`   総 ${rows.length} 件`);
  const byCat = new Map();
  for (const r of rows) {
    const k = `${r.service_category}::${r.service_category_name}`;
    byCat.set(k, (byCat.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...byCat.entries()].sort()) {
    console.log(`   ${k.padEnd(30)} : ${v}`);
  }
  console.log(EXECUTE ? "\n⚠️  EXECUTE MODE (insert)" : "\n🔍 DRY RUN");

  // 既存 code 衝突 check (system + service_code + valid_from 3列複合)
  const codes = rows.map(r => r.service_code);
  const { data: existing, error: exErr } = await sb.from("kaigo_service_codes")
    .select("service_code, system, valid_from")
    .in("service_code", codes);
  if (exErr) { console.error("既存 check error:", exErr.message); process.exit(1); }

  const exSet = new Set((existing ?? []).map(r => `${r.system}::${r.service_code}::${r.valid_from}`));
  const toInsert = rows.filter(r => !exSet.has(`${r.system}::${r.service_code}::${r.valid_from}`));
  console.log(`\n  新規 ${toInsert.length} / 既存 skip ${rows.length - toInsert.length}`);

  if (!EXECUTE) {
    console.log("\n(DRY RUN 完了)");
    return;
  }
  if (toInsert.length === 0) {
    console.log("既に投入済 → 何もしない");
    return;
  }

  const chunk = 100;
  for (let i = 0; i < toInsert.length; i += chunk) {
    const slice = toInsert.slice(i, i + chunk);
    const { error } = await sb.from("kaigo_service_codes").insert(slice);
    if (error) {
      console.error("INSERT 失敗:", error.message);
      console.error("先頭 row サンプル:", JSON.stringify(slice[0], null, 2));
      process.exit(1);
    }
    console.log(`  ✅ ${i + slice.length}/${toInsert.length}`);
  }
  console.log("\n完了");
}

main().catch(e => { console.error(e); process.exit(1); });
