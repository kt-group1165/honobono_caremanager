// 障害福祉 処遇改善加算 (令和8年6月改定) formula 設定
//   居宅介護 (category 11) / 重度訪問介護 (category 12)
//
// 背景:
//   R8/6 版 (valid_from='2026-06-01', system='障害') の処遇改善加算コードは
//   units=0 の「率もの」。R8/6 改定で Ⅰ/Ⅱ が イ/ロ に分割された:
//     - 改称: Ⅰ→Ⅰイ (115120/125120)、Ⅱ→Ⅱイ (115121/125121)
//     - 新設: Ⅰロ (115174/125174)、Ⅱロ (115175/125175)
//     - 存続: Ⅲ (115122/125122)、Ⅳ (115123/125123)
//   Ⅰイ/Ⅰロ/Ⅱイ/Ⅱロ は formula=null。
//   さらに Ⅲ/Ⅳ には R6 時代の旧率 (居宅 347/273、重訪 273/219) が
//   入ったままで、R8/6 の引き上げ後の率 (居宅 376/302、重訪 302/248)
//   と不一致 → 本 script で FIX する。
//
// 率の出典 (3 情報源で一致確認済、2026-07-08):
//   [1] 厚労省 令和8年度障害福祉サービス等報酬改定 報酬算定構造 (一次資料)
//       https://www.mhlw.go.jp/content/12200000/001663319.pdf
//       (掲載ページ: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000174644_00022.html)
//       - 居宅介護: p.2「福祉・介護職員等処遇改善加算」
//         (Ⅰ)イ ×446/1,000 / (Ⅰ)ロ ×456/1,000 / (Ⅱ)イ ×431/1,000 /
//         (Ⅱ)ロ ×441/1,000 / (Ⅲ) ×376/1,000 / (Ⅳ) ×302/1,000
//       - 重度訪問介護: p.3
//         (Ⅰ)イ ×372/1,000 / (Ⅰ)ロ ×382/1,000 / (Ⅱ)イ ×357/1,000 /
//         (Ⅱ)ロ ×367/1,000 / (Ⅲ) ×302/1,000 / (Ⅳ) ×248/1,000
//   [2] カイビズ「令和8年度処遇改善加算(障害福祉)はどう変わる?」
//       https://kaibiz.jp/column/2026rinji-syogai/  (同率)
//   [3] のどか会計事務所「処遇改善加算 加算率一覧(令和8年度対応)」
//       https://tax.nodokaya.jp/shogu-kaizen-kasanritsu-r8/  (同率)
//
// formula 形式 (既存 Ⅲ/Ⅳ の shape に合わせる):
//   { type: "monthly_aggregate", label: "所定単位×N/1000", rounding: "round",
//     numerator: N, denominator: 1000, service_category: "11" }
//
// 実行:
//   node --env-file=.env.local migrations/update_r8_06_shoguu_formula_shogai.mjs            # DRY RUN
//   node --env-file=.env.local migrations/update_r8_06_shoguu_formula_shogai.mjs --execute  # 本番

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("env missing: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const EXECUTE = process.argv.includes("--execute");
const VALID_FROM = "2026-06-01"; // R8/6 施行
const SYSTEM = "障害";
const HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

// ------------------------------------------------------------
// 加算率マスタ (numerator / 1000)
//   出典: 厚労省 001663319.pdf (居宅 p.2 / 重訪 p.3) — header comment 参照
// ------------------------------------------------------------
const RATES = {
  "11": { // 居宅介護
    "Ⅰイ": 446, "Ⅰロ": 456, "Ⅱイ": 431, "Ⅱロ": 441, "Ⅲ": 376, "Ⅳ": 302,
  },
  "12": { // 重度訪問介護
    "Ⅰイ": 372, "Ⅰロ": 382, "Ⅱイ": 357, "Ⅱロ": 367, "Ⅲ": 302, "Ⅳ": 248,
  },
};

// 区分判定は 長い方から (Ⅰイ を Ⅰ より先に test)
const KUBUN_ORDER = ["Ⅰイ", "Ⅰロ", "Ⅱイ", "Ⅱロ", "Ⅲ", "Ⅳ"];

function detectKubun(serviceName) {
  for (const k of KUBUN_ORDER) {
    if (serviceName.endsWith(k)) return k;
  }
  return null;
}

function buildFormula(numerator, category) {
  return {
    type: "monthly_aggregate",
    label: `所定単位×${numerator}/1000`,
    rounding: "round",
    numerator,
    denominator: 1000,
    service_category: category,
  };
}

async function fetchTargets() {
  const params = new URLSearchParams({
    select: "service_code,service_name,units,formula,service_category",
    system: `eq.${SYSTEM}`,
    valid_from: `eq.${VALID_FROM}`,
    service_name: "like.*処遇改善*",
    service_category: "in.(11,12)",
    order: "service_code",
    limit: "100",
  });
  const res = await fetch(`${SB_URL}/rest/v1/kaigo_service_codes?${params}`, { headers: HEADERS });
  if (!res.ok) {
    console.error("SELECT failed:", res.status, await res.text());
    process.exit(1);
  }
  return res.json();
}

async function patchFormula(serviceCode, formula) {
  const params = new URLSearchParams({
    system: `eq.${SYSTEM}`,
    valid_from: `eq.${VALID_FROM}`,
    service_code: `eq.${serviceCode}`,
  });
  const res = await fetch(`${SB_URL}/rest/v1/kaigo_service_codes?${params}`, {
    method: "PATCH",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify({ formula }),
  });
  if (!res.ok) {
    console.error(`PATCH failed (${serviceCode}):`, res.status, await res.text());
    return 0;
  }
  const rows = await res.json();
  return rows.length;
}

async function main() {
  console.log(`=== 障害福祉 処遇改善加算 R8/6 formula 設定 ${EXECUTE ? "*** EXECUTE ***" : "(DRY RUN)"} ===`);
  console.log(`対象: system='${SYSTEM}', valid_from='${VALID_FROM}', category 11(居宅介護)/12(重度訪問介護)`);
  console.log("");
  console.log("率の出典 (3 情報源一致):");
  console.log("  [1] 厚労省 R8年度報酬算定構造 https://www.mhlw.go.jp/content/12200000/001663319.pdf (居宅 p.2 / 重訪 p.3)");
  console.log("  [2] https://kaibiz.jp/column/2026rinji-syogai/");
  console.log("  [3] https://tax.nodokaya.jp/shogu-kaizen-kasanritsu-r8/");
  console.log("");

  const rows = await fetchTargets();
  console.log(`DB 該当行: ${rows.length} 件`);
  console.log("");

  const plans = [];   // { code, name, action, oldNum, newFormula }
  const skipped = [];

  for (const r of rows) {
    const kubun = detectKubun(r.service_name);
    const rate = kubun != null ? RATES[r.service_category]?.[kubun] : undefined;
    if (rate === undefined) {
      skipped.push(`${r.service_code} ${r.service_name} (区分判定不可 or 率未確認)`);
      continue;
    }
    if (r.units !== 0) {
      skipped.push(`${r.service_code} ${r.service_name} (units=${r.units} ≠ 0、率ものでない)`);
      continue;
    }
    const oldNum = r.formula?.numerator ?? null;
    const newFormula = buildFormula(rate, r.service_category);
    let action;
    if (r.formula == null) action = "SET";
    else if (oldNum !== rate) action = "FIX"; // 旧 R6 率が残存 → R8/6 率に修正
    else action = "OK ";
    plans.push({ code: r.service_code, name: r.service_name, kubun, action, oldNum, rate, newFormula });
  }

  console.log("--- 計画 ---");
  for (const p of plans) {
    const before = p.oldNum == null ? "null" : `${p.oldNum}/1000`;
    console.log(`  [${p.action}] ${p.code} ${p.name.padEnd(14, "　")} ${before} -> ${p.rate}/1000`);
  }
  if (skipped.length) {
    console.log("--- skip ---");
    for (const s of skipped) console.log(`  ${s}`);
  }

  const targets = plans.filter((p) => p.action !== "OK ");
  console.log("");
  console.log(`SET (null→設定): ${plans.filter((p) => p.action === "SET").length} 件 / FIX (旧率修正): ${plans.filter((p) => p.action === "FIX").length} 件 / OK (変更不要): ${plans.filter((p) => p.action === "OK ").length} 件`);

  // 全 12 区分 (2 category × 6 区分) が揃っているか sanity check
  const expected = 12;
  if (plans.length !== expected) {
    console.warn(`⚠ 想定 ${expected} 件に対し ${plans.length} 件。コード追加/欠落の可能性 — 確認のこと`);
  }

  if (!EXECUTE) {
    console.log("");
    console.log("DRY RUN — 変更なし。--execute で PATCH 実行。");
    return;
  }

  console.log("");
  console.log("--- PATCH 実行 ---");
  let updated = 0;
  for (const p of targets) {
    const n = await patchFormula(p.code, p.newFormula);
    if (n !== 1) {
      console.error(`  ✗ ${p.code}: 更新行数 ${n} (期待 1) — 中断`);
      process.exit(1);
    }
    updated += n;
    console.log(`  ✓ ${p.code} ${p.name} -> ${p.rate}/1000`);
  }

  // 件数確認 (verify)
  const after = await fetchTargets();
  const stillNull = after.filter((r) => r.formula == null);
  const mismatch = after.filter((r) => {
    const kubun = detectKubun(r.service_name);
    const rate = kubun != null ? RATES[r.service_category]?.[kubun] : undefined;
    return rate !== undefined && r.formula?.numerator !== rate;
  });
  console.log("");
  console.log(`更新: ${updated} 件 / 残 null: ${stillNull.length} 件 / 率不一致: ${mismatch.length} 件`);
  if (stillNull.length || mismatch.length) {
    console.error("⚠ verify で不整合あり — 要確認");
    process.exit(1);
  }
  console.log("完了");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
