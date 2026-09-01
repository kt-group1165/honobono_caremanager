// ============================================================================
// 障害の上限額管理事業所番号「他事業所」ぶんを、WAM NET (障害福祉サービス等情報
// 公表システム・独立行政法人福祉医療機構が運営する公的オープンデータ) の
// 事業所名検索で照合し、正式な事業所番号を埋める。
//
// 背景: `fix_jogen_kanri_office_number.mjs` の DRY RUN で「他社 21件 — 上限額管理
// 結果票 / 受給者証の記載から入力するしかない」とされていたが、これは障害福祉
// サービス事業所のマスタを自前で持っていないという意味であり、公的な検索システム
// (https://www.wam.go.jp/sfkohyoout/) 自体は存在する。事業所名で 1 社ずつ検索し、
// 千葉県内の該当事業所番号を突き合わせた (2026-09-01, I)。
//
//   node migrations/fix_jogen_kanri_office_number_external.mjs             # DRY RUN (既定)
//   node migrations/fix_jogen_kanri_office_number_external.mjs --execute   # 実行
//
// ── 見つかったもの (11社。RESOLVED に記載。出典 = WAM NET 事業所名検索、千葉県内で照合) ──
//
// ── 副産物: 「他社」に分類されていたが実際は自社事業所だったもの (2件) ──
//   `fix_jogen_kanri_office_number.mjs` の名称マッチ (norm + includes) は
//   クライアント側の名称に「ヘルパーステーション」プレフィックスや法人名プレフィックスが
//   無いと一致しない設計だったため、以下 2 件を見落として「他社」に振り分けていた:
//     ・黒田緑   「リンクス大網白里事業所」        → 自社「リンクスヘルパーステーション大網白里」
//     ・酒井雫   「ヘルパーステーションHanaちはら台（居宅介護）」
//                                              → 自社「ケイ・ティ・グループヘルパーステーションＨａｎａちはら台」
//   WAM NET 側の番号とも一致したので二重に確認できている。
//
// ── まだ見つからないもの (5社。UNRESOLVED に記載・番号は入れない) ──
//   ケアステーション ミミズク / (有)あまくさ太陽介護センター / 株式会社コネクトドット365(誉田) /
//   新松戸第2事業所 / りべるたす株式会社ブレイブ
//   → WAM NET の名称検索で該当なし、または同名の別法人 (別県) しか出なかった。
//     りべるたすは千葉市中央区に複数事業所があるが「ブレイブ」を含む名称が無く、
//     どれが該当か決められないため候補を出さない。上限額管理結果票 / 受給者証の
//     実物を見て判断すること。
//
// ⚠ この script は `jogen_kanri_office_number` のみ更新する。`jogen_kanri_kubun`
//   (自事業所/他事業所の区分) は変更しない。2件の自社ぶんも kubun はそのまま
//   「他事業所」で残るが、伝送の項15 は区分に関わらずこの number 列を使うので
//   請求上の実害はない (区分の是正は別途データ整備の話として user 判断)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

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

const PAGE = 1000;
async function fetchAll(table, select) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

/** 表記ゆれを吸収する (全半角・空白・記号を除去)。既存 script と同じ考え方。 */
function norm(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[\s()（）[\]{}・,、。]/g, "");
}

// norm() 済みキー → { number, name, note }
// name は WAM NET (または自社 offices) 側の正式名称。note は出典・補足。
const RESOLVED = [
  {
    match: "太陽の丘ホーム",
    number: "1210600324",
    name: "太陽の丘ホーム",
    note: "WAM NET / 千葉県市原市畑木246-2 / 短期入所ほか",
  },
  {
    match: "ニチイケアセンター城見ヶ丘",
    number: "1213700089",
    name: "ニチイケアセンター城見ヶ丘",
    note: "WAM NET / 千葉県夷隅郡大多喜町",
  },
  {
    match: "介護サービスえいと千葉中央事業所",
    number: "1210104301",
    name: "介護サービスえいと千葉中央事業所",
    note: "WAM NET / 千葉市中央区弁天",
  },
  {
    match: "介護サービスえいとちはら台事業所",
    number: "1210601538",
    name: "介護サービスえいと　ちはら台事業所",
    note: "WAM NET / 千葉県市原市ちはら台東 (自社「Ｈａｎａちはら台」とは別法人)",
  },
  {
    match: "リンクス大網白里事業所",
    number: "1210700306",
    name: "リンクスヘルパーステーション大網白里",
    note: "★自社事業所。WAM NET でも同番号を確認 (二重確認済み)",
  },
  {
    match: "ヘルパーステーションなのはな幕張事業所",
    number: "1210100556",
    name: "ヘルパーステーションなのはな幕張事業所",
    note: "WAM NET / 千葉市花見川区幕張町",
  },
  {
    match: "社福千葉県身体障害者福祉事業団千葉ﾘハ愛育園短期入所",
    number: "1210101158",
    name: "愛育園",
    note: "WAM NET / 千葉市緑区誉田町 / 療養介護・短期入所",
  },
  {
    match: "土屋訪問介護事業所千葉若葉センター",
    number: "1210105589",
    name: "土屋訪問介護事業所　千葉若葉センター",
    note: "WAM NET / 千葉市若葉区加曽利町",
  },
  {
    match: "ヘルパーステーションHanaちはら台居宅介護",
    number: "1210601116",
    name: "ケイ・ティ・グループヘルパーステーションＨａｎａちはら台",
    note: "★自社事業所。WAM NET でも同番号を確認 (二重確認済み)",
  },
  {
    match: "くつろぎ処やよい",
    number: "1214900209",
    name: "くつろぎ処やよい",
    note: "WAM NET / 千葉県いすみ市岬町 / 就労継続支援Ｂ型",
  },
  {
    match: "ワークショップしらさと",
    number: "1210700157",
    name: "ワークショップしらさと",
    note: "WAM NET / 千葉県大網白里市細草 / 就労継続支援Ｂ型ほか",
  },
  {
    match: "SOMPOケア八千代",
    number: "1210400253",
    name: "SOMPOケア八千代　訪問介護",
    note: "WAM NET / 千葉県八千代市ゆりのき台",
  },
  {
    match: "SOMPOケア八千",
    number: "1210400253",
    name: "SOMPOケア八千代　訪問介護",
    note: "受給者証PDFで名称が17字程度で切れた表記。上と同一事業所",
  },
];
const RESOLVED_MAP = new Map(RESOLVED.map((r) => [norm(r.match), r]));

async function main() {
  console.log(`=== 上限額管理事業所番号「他事業所」の WAM NET 照合 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const [certs, clients] = await Promise.all([
    fetchAll(
      "shougai_certifications",
      "id, client_id, jogen_kanri_kubun, jogen_kanri_office_name, jogen_kanri_office_number",
    ),
    fetchAll("clients", "id, name"),
  ]);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));

  const targets = certs.filter(
    (c) => (c.jogen_kanri_kubun ?? "").trim() === "他事業所" && !(c.jogen_kanri_office_number ?? "").trim(),
  );

  const hits = [];
  const misses = [];
  for (const c of targets) {
    const key = norm(c.jogen_kanri_office_name);
    const hit = RESOLVED_MAP.get(key);
    if (hit) hits.push({ cert: c, hit });
    else misses.push(c);
  }

  console.log(`対象 (他事業所・番号未設定) ${targets.length} 件 中`);
  console.log(`  照合できた ${hits.length} 件 → 番号を埋める`);
  for (const { cert, hit } of hits) {
    console.log(
      `    ${String(nameOf.get(cert.client_id) ?? "?").padEnd(10)}  ` +
        `${cert.jogen_kanri_office_name}\n      → ${hit.number}  (${hit.name})  ${hit.note}`,
    );
  }
  console.log(`\n  照合できなかった ${misses.length} 件 → 触らない (上限額管理結果票/受給者証の実物で確認)`);
  const seen = new Map();
  for (const c of misses) {
    const k = (c.jogen_kanri_office_name ?? "").trim();
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(nameOf.get(c.client_id) ?? "?");
  }
  for (const [office, users] of seen) {
    console.log(`    ${office || "(名称も空)"}  — ${users.join(" / ")}`);
  }

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。--execute で ${hits.length} 件を更新します。`);
    return;
  }
  if (hits.length === 0) {
    console.log("\n更新するものはありません。");
    return;
  }
  let n = 0;
  for (const { cert, hit } of hits) {
    const { error } = await sb
      .from("shougai_certifications")
      .update({ jogen_kanri_office_number: hit.number })
      .eq("id", cert.id);
    if (error) {
      console.error(`✗ 更新失敗 (${n} 件済) id=${cert.id}: ${error.message}`);
      process.exit(1);
    }
    n += 1;
  }
  console.log(`\n✓ ${n} 件に事業所番号を入れました。`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
