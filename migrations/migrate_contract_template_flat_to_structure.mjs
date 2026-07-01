// contract_templates.content の flat article_01..article_22 を content.articles ツリーに変換
// = 既存 flat key は残す (= 後方互換 fallback として)、articles を新規追加
//
// 実行:
//   node migrations/migrate_contract_template_flat_to_structure.mjs
//   node migrations/migrate_contract_template_flat_to_structure.mjs --execute
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

// parser を Node にも移植 (= src/lib/contract-structure/parser.ts と同ロジック)
function newId() { return randomUUID(); }

const PARAGRAPH_MARKER_RE = /^([①-⑳㉑-㉚])\s*(.*)$/;
const NAKAGURO_ITEM_RE = /^[・･]\s*(.*)$/;
const IROHA_ITEM_RE = /^([イロハニホヘトチリヌルヲワカヨタレソツネナラム])\s+(.*)$/;
const ARABIC_ITEM_RE = /^(\d+)[.\.]\s*(.*)$/;

function parseArticleText(raw, title) {
  const lines = raw.split(/\r?\n/).map(l => l.replace(/　/g, " ").trimEnd());
  const chapeauLines = [];
  const paragraphs = [];
  let curPara = null;

  function appendContinuation(line) {
    if (!curPara) { chapeauLines.push(line); return; }
    if (curPara.items.length === 0) {
      curPara.chapeau = curPara.chapeau + (curPara.chapeau ? "\n" : "") + line;
      return;
    }
    const last = curPara.items[curPara.items.length - 1];
    last.text = last.text + (last.text ? "\n" : "") + line;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimStart();
    if (!line.trim()) { appendContinuation(""); continue; }
    const pm = PARAGRAPH_MARKER_RE.exec(line);
    if (pm) {
      curPara = { id: newId(), chapeau: pm[2].trim(), items: [] };
      paragraphs.push(curPara);
      continue;
    }
    if (curPara) {
      const naka = NAKAGURO_ITEM_RE.exec(line);
      if (naka) { curPara.items.push({ id: newId(), marker: "nakaguro", text: naka[1].trim() }); continue; }
      const iroha = IROHA_ITEM_RE.exec(line);
      if (iroha) { curPara.items.push({ id: newId(), marker: "iroha", text: iroha[2].trim() }); continue; }
      const arabic = ARABIC_ITEM_RE.exec(line);
      if (arabic) { curPara.items.push({ id: newId(), marker: "arabic", text: arabic[2].trim() }); continue; }
    }
    appendContinuation(line);
  }
  return { id: newId(), title, chapeau: chapeauLines.join("\n").trim(), paragraphs };
}

const ARTICLE_TITLES = {
  article_01: "契約の目的",
  article_02: "契約期間",
  article_03: "介護支援専門員",
  article_04: "居宅サービス計画作成の支援",
  article_05: "状況観察・再評価",
  article_06: "施設入所への支援",
  article_07: "居宅サービス計画の変更",
  article_08: "給付管理",
  article_09: "要介護認定等の申請に係る援助",
  article_10: "サービスの提供の記録",
  article_11: "料金",
  article_12: "契約の終了",
  article_13: "秘密保持",
  article_14: "賠償責任",
  article_15: "身分証携行義務",
  article_16: "相談・苦情対応",
  article_17: "善管注意義務",
  article_18: "代理人選任",
  article_19: "不可抗力免責",
  article_20: "災害等発生時のサービス提供",
  article_21: "誠実履行・協議",
  article_22: "合意管轄",
};

async function main() {
  console.log(`\n📂 contract_templates flat → structure migration`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");

  const { data: rows, error } = await sb
    .from("kaigo_contract_templates")
    .select("id, kind, version_no, content")
    .eq("kind", "契約書兼重要事項説明書");
  if (error) { console.error(error); process.exit(1); }
  console.log(`対象 ${rows.length} 件`);

  for (const row of rows) {
    const content = row.content ?? {};
    if (Array.isArray(content.articles) && content.articles.length > 0) {
      console.log(`  v${row.version_no} は既に articles ツリー保持済 → skip`);
      continue;
    }
    const articles = [];
    for (let i = 1; i <= 22; i++) {
      const key = `article_${String(i).padStart(2, "0")}`;
      const raw = content[key];
      if (typeof raw !== "string" || !raw.trim()) continue;
      articles.push(parseArticleText(raw, ARTICLE_TITLES[key]));
    }
    console.log(`  v${row.version_no}: 条 ${articles.length} 個、項合計 ${articles.reduce((s,a)=>s+a.paragraphs.length,0)}、号合計 ${articles.reduce((s,a)=>s+a.paragraphs.reduce((s2,p)=>s2+p.items.length,0),0)}`);
    if (!EXECUTE) continue;
    const newContent = { ...content, articles };
    const { error: eUp } = await sb
      .from("kaigo_contract_templates")
      .update({ content: newContent })
      .eq("id", row.id);
    if (eUp) { console.error(`  ❌ ${row.id} UPDATE 失敗:`, eUp.message); process.exit(1); }
    console.log(`  ✅ v${row.version_no} UPDATE 完了`);
  }
  console.log(EXECUTE ? "\n完了" : "\n(DRY RUN, --execute で実行)");
}

main().catch(e => { console.error(e); process.exit(1); });
