// v1 の paragraphs すべてを marker='none' に統一 (= docx 原本忠実)
// docx 原本には ①② marker は使われていないため、既存 seed で付与した
// ①② 表記を render しないよう marker='none' を焼き付ける。
//
// 実行:
//   node migrations/set_paragraph_marker_none_docx_align.mjs
//   node migrations/set_paragraph_marker_none_docx_align.mjs --execute
import { createClient } from "@supabase/supabase-js";
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

async function main() {
  console.log(`\n📂 paragraph.marker → 'none' (docx 忠実)`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");

  const { data: rows, error } = await sb
    .from("kaigo_contract_templates")
    .select("id, kind, version_no, content")
    .eq("kind", "契約書兼重要事項説明書");
  if (error) { console.error(error); process.exit(1); }

  for (const row of rows) {
    const content = row.content ?? {};
    const articles = Array.isArray(content.articles) ? content.articles : [];
    if (articles.length === 0) {
      console.log(`  v${row.version_no}: articles 無し → skip`);
      continue;
    }
    let touched = 0;
    for (const a of articles) {
      for (const p of a.paragraphs ?? []) {
        if (p.marker !== "none") {
          p.marker = "none";
          touched++;
        }
      }
    }
    console.log(`  v${row.version_no}: 項 ${touched} 個を marker='none' へ`);
    if (!EXECUTE) continue;
    const { error: eUp } = await sb
      .from("kaigo_contract_templates")
      .update({ content: { ...content, articles } })
      .eq("id", row.id);
    if (eUp) { console.error(`  ❌ ${row.id} UPDATE 失敗:`, eUp.message); process.exit(1); }
    console.log(`  ✅ v${row.version_no} UPDATE 完了`);
  }
  console.log(EXECUTE ? "\n完了" : "\n(DRY RUN, --execute で実行)");
}

main().catch(e => { console.error(e); process.exit(1); });
