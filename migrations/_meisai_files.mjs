// ============================================================================
// MEISAI_*.csv を **再帰的に** 探す共通ヘルパー。
//
//   ほのぼのから出したフォルダ構成が事業所ごとに揃っていない:
//     サービス実績データ/茂原/202606/MEISAI_*.csv
//     サービス実績データ/大網/202606/MEISAI_*.csv
//     サービス実績データ/さつきが丘/202606/介護/ほのぼの/MEISAI_*.csv
//   毎回 AREA_DIR の指定を変えて合わせるのは事故のもと (取込 0 件でも気付きにくい) なので、
//   対象月フォルダ配下を丸ごと掘って集める。
//
//   ⚠ 同名ファイルが複数階層にあると二重取込になるので、**basename の重複は中断**する。
// ============================================================================
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const MEISAI_RE = /^MEISAI_.*\.csv$/i;

/** dir 配下 (再帰) の MEISAI_*.csv の絶対パス一覧。見つからなければ空配列 */
export function findMeisaiFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return; // 存在しない階層は黙って無視
    }
    for (const name of entries) {
      const p = path.join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (MEISAI_RE.test(name)) out.push(p);
    }
  };
  walk(dir);
  out.sort();

  const byBase = new Map();
  for (const p of out) {
    const b = path.basename(p);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  const dup = [...byBase].filter(([, ps]) => ps.length > 1);
  if (dup.length) {
    console.error(`✗ 同名の MEISAI が複数階層にあります (二重取込になるので中断):`);
    for (const [b, ps] of dup) console.error(`   ${b}\n     ${ps.join("\n     ")}`);
    process.exit(1);
  }
  return out;
}
