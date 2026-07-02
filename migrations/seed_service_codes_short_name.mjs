// kaigo_service_codes.short_name を auto 生成 (パターンマッチ + 手動 seed)
//
// 主要ルール:
//   身体介護   → 身
//   生活援助   → 生
//   身体・生活 (組合わせ) → 身X生Y  (例 身体介護1・生活1 → 身1生1)
//   通院等介助 → 通
//   通院等乗降介助 → 乗
//   居宅介護   → 居宅  (障害)
//   重度訪問介護 → 重訪 (障害)
//   行動援護   → 行動
//   同行援護   → 同行
//   訪問看護   → 看
//   訪問リハ   → リハ
//   通所介護   → デ
//   通所リハ   → 通リ
//   認知症通所 → 認デ
//   小規模多機能 → 小多
//   看護小規模多機能 → 看小多
//   短期入所生活介護 → 短生
//   短期入所療養介護 → 短療
//   特定施設入居者生活介護 → 特施
//   福祉用具貸与 → 福貸
//   介護予防... → 予...
//
// 実行:
//   node migrations/seed_service_codes_short_name.mjs
//   node migrations/seed_service_codes_short_name.mjs --execute
import { createClient } from "@supabase/supabase-js";
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("env missing"); process.exit(1); }
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, SB_KEY);

// 全角数字 <-> ASCII
const Z2A = { "０":"0","１":"1","２":"2","３":"3","４":"4","５":"5","６":"6","７":"7","８":"8","９":"9" };
const zenkakuToAscii = (s) => s.replace(/[０-９]/g, ch => Z2A[ch] ?? ch);
const A2Z = { "0":"０","1":"１","2":"２","3":"３","4":"４","5":"５","6":"６","7":"７","8":"８","9":"９" };
const asciiToZenkaku = (s) => s.replace(/[0-9]/g, ch => A2Z[ch] ?? ch);

/**
 * service_name → 略称 の変換ルール。順序が重要 (=より特殊 な pattern を先に検査)。
 * 各 rule: { test: (name)=>boolean, transform: (name)=>string }
 */
const RULES = [
  // ─── 介護保険 訪問介護 ───────────────────
  // 身体介護X・生活Y (組合わせ) → 身X生Y
  { re: /^身体介護([0-9０-９]+)・生活([0-9０-９]+)/, out: (m) => `身${zenkakuToAscii(m[1])}生${asciiToZenkaku(zenkakuToAscii(m[2]))}` },
  { re: /^身体介護([0-9０-９]+)/, out: (m) => `身${zenkakuToAscii(m[1])}` },
  { re: /^生活援助([0-9０-９]+)/, out: (m) => `生${zenkakuToAscii(m[1])}` },
  { re: /^通院等介助/, out: () => "通" },
  { re: /^通院等乗降介助/, out: () => "乗" },
  { re: /^身体介護/, out: () => "身" },
  { re: /^生活援助/, out: () => "生" },

  // ─── 介護保険 その他 (category ごと prefix) ─────
  { re: /^認知症対応型通所介護|^認知症対応型共同生活介護/, out: () => "認" },
  { re: /^小規模多機能型居宅介護/, out: () => "小多" },
  { re: /^看護小規模多機能型居宅介護/, out: () => "看小多" },
  { re: /^通所介護|^地域密着型通所介護/, out: () => "デ" },
  { re: /^通所リハビリテーション/, out: () => "通リ" },
  { re: /^短期入所生活介護/, out: () => "短生" },
  { re: /^短期入所療養介護/, out: () => "短療" },
  { re: /^特定施設入居者生活介護/, out: () => "特施" },
  { re: /^福祉用具貸与|^福祉用具/, out: () => "福貸" },
  { re: /^訪問看護/, out: () => "看" },
  { re: /^訪問リハビリテーション/, out: () => "訪リ" },
  { re: /^訪問入浴/, out: () => "入" },
  { re: /^居宅療養管理指導/, out: () => "居療" },
  { re: /^居宅介護支援/, out: () => "居ケ" },
  { re: /^介護予防/, out: (_m, name) => `予${(name.replace(/^介護予防/, "").slice(0, 2)) || ""}` },
  { re: /^住宅改修/, out: () => "改" },
  { re: /^定期巡回・随時対応型|^定期巡回/, out: () => "定巡" },
  { re: /^夜間対応型訪問介護/, out: () => "夜訪" },

  // ─── 障害福祉 訪問系 ─────────────────
  { re: /^居宅介護/, out: () => "居宅" },
  { re: /^重度訪問介護/, out: () => "重訪" },
  { re: /^行動援護/, out: () => "行動" },
  { re: /^同行援護/, out: () => "同行" },
  { re: /^療養介護/, out: () => "療養" },
  { re: /^生活介護/, out: () => "生介" },
  { re: /^短期入所/, out: () => "短入" },
  { re: /^共同生活援助|^グループホーム/, out: () => "GH" },
  { re: /^重度障害者等包括支援/, out: () => "重包" },
  { re: /^施設入所支援/, out: () => "施入" },
  { re: /^自立訓練[（(]機能訓練/, out: () => "自機" },
  { re: /^自立訓練[（(]生活訓練/, out: () => "自生" },
  { re: /^就労移行/, out: () => "就移" },
  { re: /^就労継続支援A/, out: () => "就A" },
  { re: /^就労継続支援B/, out: () => "就B" },
  { re: /^就労定着/, out: () => "就定" },
  { re: /^就労選択/, out: () => "就選" },
  { re: /^計画相談支援/, out: () => "計相" },
  { re: /^障害児相談支援/, out: () => "児相" },
  { re: /^児童発達支援|^医療型児童発達支援|^居宅訪問型児童発達支援/, out: () => "児発" },
  { re: /^放課後等デイサービス/, out: () => "放デ" },
  { re: /^保育所等訪問支援/, out: () => "保訪" },
  { re: /^福祉型障害児入所|^医療型障害児入所/, out: () => "障児入" },

  // ─── 総合事業 ───────────────────
  { re: /^訪問型独自サービス|^訪問型サービスA/, out: () => "総訪A" },
  { re: /^訪問型サービスB/, out: () => "総訪B" },
  { re: /^訪問型サービスC/, out: () => "総訪C" },
  { re: /^訪問型サービスD/, out: () => "総訪D" },
  { re: /^通所型独自サービス|^通所型サービスA/, out: () => "総通A" },
  { re: /^通所型サービスB/, out: () => "総通B" },
  { re: /^通所型サービスC/, out: () => "総通C" },
  { re: /^生活援助型訪問サービス/, out: () => "総生訪" },
  { re: /^ミニデイ型通所サービス/, out: () => "ミニ" },
  { re: /^介護予防ケアマネジメント/, out: () => "予ケマ" },
];

function makeShortName(name) {
  if (!name) return null;
  const trimmed = name.trim();
  for (const rule of RULES) {
    const m = trimmed.match(rule.re);
    if (m) {
      try {
        return rule.out(m, trimmed);
      } catch (e) {
        console.error("rule error:", rule.re, e);
        return null;
      }
    }
  }
  // fallback: 先頭 2 文字 (漢字・カタカナ想定)
  return trimmed.slice(0, 2);
}

async function main() {
  console.log(`\n📂 short_name auto 生成`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE" : "🔍 DRY RUN");

  const PAGE = 1000;
  let from = 0;
  let totalUpdates = 0;
  let updated = 0;
  const sample = [];
  while (true) {
    const { data, error } = await sb
      .from("kaigo_service_codes")
      .select("service_code, service_name, short_name")
      .is("short_name", null)
      .range(from, from + PAGE - 1);
    if (error) { console.error(error); process.exit(1); }
    if (!data || data.length === 0) break;
    for (const row of data) {
      const s = makeShortName(row.service_name);
      if (!s) continue;
      totalUpdates++;
      if (sample.length < 15) sample.push({ code: row.service_code, name: row.service_name, short: s });
      if (EXECUTE) {
        const { error: e } = await sb
          .from("kaigo_service_codes")
          .update({ short_name: s })
          .eq("service_code", row.service_code)
          .is("short_name", null);
        if (e) { console.error(`❌ ${row.service_code}:`, e.message); continue; }
        updated++;
      }
    }
    from += PAGE;
    if (data.length < PAGE) break;
  }
  console.log(`\nマッチ数 (short_name 割当予定): ${totalUpdates}`);
  console.log(`\n先頭 15 件 sample:`);
  sample.forEach(s => console.log(`  ${s.code}  ${s.name}  →  ${s.short}`));
  if (!EXECUTE) console.log("\n(DRY RUN — 実行時 --execute)");
  else console.log(`\n✅ UPDATE 完了 ${updated} 件`);
}

main().catch(e => { console.error(e); process.exit(1); });
