// 既存 kaigo_visit_procedure_step_templates の name を keyword マッチで
// category を自動分類して UPDATE する one-shot script。
//
// Usage:
//   node migrations/classify_existing_templates.mjs              # DRY RUN (件数と sample 表示)
//   node migrations/classify_existing_templates.mjs --execute    # 本番 UPDATE
//
// 仕様 (2026-06-24 user 確定):
//   - keyword は name に対して大文字小文字無視で部分一致
//   - 既に「その他」以外が設定されている template は skip (= user が手動で振った可能性)
//   - マッチしなかったものは「その他」のまま (UPDATE 不要なので skip)
//   - soft delete 済 (deleted_at NOT NULL) は対象外
//   - silent failure 防止: 全 supabase 呼出を { error } で check

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("環境変数 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要です");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const EXECUTE = process.argv.includes("--execute");
const MODE = EXECUTE ? "EXECUTE" : "DRY-RUN";

console.log(`[mode] ${MODE}\n`);

/**
 * キーワード → category マッピング (上から順に評価、最初にマッチしたものを採用)
 *
 * 順序の理由:
 *  - 「服薬」「バイタル」など固有度高いものを先に評価する。
 *    (= 後の方に「確認」を置くと "服薬確認" / "薬の確認" 等が「挨拶・確認」に
 *       吸われるのを防ぐ)
 *  - 「記録」も "片付け・記録" が「掃除・洗濯」に吸われないよう先頭側へ。
 */
const RULES = [
  { category: "バイタル",   keywords: ["バイタル", "血圧", "BP", "SpO2", "脈拍"] },
  { category: "服薬",       keywords: ["服薬", "薬"] },
  { category: "排泄",       keywords: ["排泄", "トイレ", "尿", "便", "オムツ", "おむつ"] },
  { category: "入浴",       keywords: ["入浴", "洗体", "洗髪", "脱衣", "湯", "シャワー", "清拭"] },
  { category: "食事",       keywords: ["食事", "配膳", "調理", "食前", "食後", "下膳", "食器"] },
  { category: "移乗・歩行", keywords: ["移乗", "歩行", "車椅子", "車いす", "起床", "離床", "立位"] },
  { category: "買物・通院", keywords: ["買物", "買い物", "通院", "送迎", "通所"] },
  { category: "記録",       keywords: ["記録"] },
  { category: "掃除・洗濯", keywords: ["掃除", "洗濯", "ゴミ", "ごみ", "片付け", "片づけ", "整理"] },
  // 「挨拶・確認」は最後に評価 (= 「確認」が他カテゴリに吸われないよう)
  { category: "挨拶・確認", keywords: ["挨拶", "声かけ", "確認"] },
];

/** name から category を推定。マッチ無しは null (= 「その他」維持で skip) */
function classify(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw.toLowerCase())) return rule.category;
    }
  }
  return null;
}

// 1) 既存 templates を全件取得 (PostgREST 1000 行 limit を page-loop で回避)
const PAGE = 1000;
const allTemplates = [];
let from = 0;
while (true) {
  const { data, error } = await sb
    .from("kaigo_visit_procedure_step_templates")
    .select("id, name, category, office_id")
    .is("deleted_at", null)
    .range(from, from + PAGE - 1);
  if (error) {
    console.error("templates fetch error:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) break;
  allTemplates.push(...data);
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log(`[1] 取得済 templates: ${allTemplates.length} 件`);

// 2) classify & filter
//    - 既に「その他」以外 → skip (user が手動で振った可能性)
//    - matched が「その他」 / null → UPDATE 不要 (= 元から「その他」なので skip)
//    - matched が現値と同じ → UPDATE 不要 (skip)
const updates = []; // { id, name, before, after }
const skipPreset = []; // 既に振られていた件
const noMatch = []; // マッチしなかった件
for (const t of allTemplates) {
  const current = t.category ?? "その他";
  if (current !== "その他") {
    skipPreset.push(t);
    continue;
  }
  const next = classify(t.name);
  if (!next || next === current) {
    noMatch.push(t);
    continue;
  }
  updates.push({ id: t.id, name: t.name, before: current, after: next });
}

console.log(`[2] 既に「その他」以外 (skip): ${skipPreset.length} 件`);
console.log(`[3] マッチ無し (= 「その他」維持): ${noMatch.length} 件`);
console.log(`[4] UPDATE 対象: ${updates.length} 件\n`);

// 3) category 別件数サマリ
const summary = new Map();
for (const u of updates) {
  summary.set(u.after, (summary.get(u.after) ?? 0) + 1);
}
if (summary.size > 0) {
  console.log("== UPDATE 内訳 (category 別) ==");
  for (const [cat, n] of summary) {
    console.log(`  ${cat.padEnd(8, "　")} ${n} 件`);
  }
  console.log("");
}

// 4) sample 出力 (先頭 15 件)
if (updates.length > 0) {
  console.log("== sample (先頭 15 件) ==");
  for (const u of updates.slice(0, 15)) {
    console.log(`  - "${u.name}" → ${u.after}`);
  }
  console.log("");
}

if (updates.length === 0) {
  console.log("UPDATE 対象なし。終了。");
  process.exit(0);
}

if (!EXECUTE) {
  console.log("本番 UPDATE は --execute を付けて再実行。");
  process.exit(0);
}

// 5) UPDATE 実行 (1 件ずつ。件数少ないので bulk RPC は不要)
let ok = 0;
let ng = 0;
for (const u of updates) {
  const { error } = await sb
    .from("kaigo_visit_procedure_step_templates")
    .update({ category: u.after })
    .eq("id", u.id);
  if (error) {
    console.error(`✗ UPDATE failed id=${u.id} name="${u.name}": ${error.message}`);
    ng += 1;
  } else {
    ok += 1;
  }
}

console.log(`\n✓ UPDATE 完了: 成功 ${ok} 件 / 失敗 ${ng} 件`);
if (ng > 0) process.exit(1);
