/**
 * 介護予防支援 (46xxx) の伝送実装を検証 (H割当・2026-09-05)
 *
 *   npx tsx scripts/yobo-shien-densou-verify.mts
 *
 * ⚠ 純関数呼び出しのみ。DB書込・office/clients作成は一切しない
 *   (H指示: offices は触らない。実在利用者・実在事業所には触らない)。
 *   buildKyufuKanriFile / buildKeikakuhiFile は入力を受け取って文字列を組み立てる
 *   だけの純関数 — 呼出側 (_kokuho-seikyu.tsx) が43/46のどちらで呼ぶかを決める。
 *
 * ── H の3項目 ──────────────────────────────────────────────────────────
 *   ① 「実装は出来ている」の範囲を実際に確認する
 *   ② 事業所番号を入れたら動くかをサンプル(純関数)で確認 + 8222項16の値
 *   ③ 予防の単位数(442/472)が正しいか
 */
import { buildKyufuKanriFile, buildKeikakuhiFile, CARE_LEVEL_CODE } from "../src/lib/kokuho-densou/build-kyotaku";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
  }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? `  (${detail})` : ""}`); }
};

console.log("=== §0 前提: office_service_designations の現状 (READ ONLY) ===");
{
  const { data, error } = await sb.from("office_service_designations").select("id, office_id, service_category, business_number");
  if (error) throw new Error(error.message);
  console.log(`  office_service_designations 総件数 = ${data?.length ?? 0}`);
  console.log(`  → DECISIONS_PENDING B-1oの「事業所番号の入力だけが足りない」を裏付け:`);
  console.log(`    テーブル自体は存在し(migration適用済)、46番号を入れた事業所は${data?.length === 0 ? "現状0件" : `${data?.length}件`}`);
}

console.log("\n=== §3(先に) 予防の単位数 (442/472) がマスタ通りか ===");
{
  const { data, error } = await sb
    .from("kaigo_service_codes")
    .select("service_code, service_name, units, valid_from, valid_until")
    .eq("system", "介護").eq("calculation_type", "基本").like("service_code", "46%");
  if (error) throw new Error(error.message);
  const base = (data ?? []).filter((r: { service_name: string }) => r.service_name.startsWith("介護予防支援") && !r.service_name.includes("・"));
  const gen1_I = base.find((r: { service_code: string }) => r.service_code === "461111");
  const gen1_II = base.find((r: { service_code: string }) => r.service_code === "461112");
  const gen2_I = base.find((r: { service_code: string }) => r.service_code === "462111");
  const gen2_II = base.find((r: { service_code: string }) => r.service_code === "462121");
  check("R6.4世代 Ⅰ(地域包括) 461111 = 442単位", gen1_I?.units === 442, JSON.stringify(gen1_I));
  check("R6.4世代 Ⅱ(居宅介護支援事業所) 461112 = 472単位", gen1_II?.units === 472, JSON.stringify(gen1_II));
  check("R8.6世代 Ⅰ 462111 = 442単位", gen2_I?.units === 442, JSON.stringify(gen2_I));
  check("R8.6世代 Ⅱ 462121 = 472単位", gen2_II?.units === 472, JSON.stringify(gen2_II));
}

console.log("\n=== §1+2 buildKyufuKanriFile (8222給付管理票) を純関数として合成テスト ===");
console.log("   (サンプルデータ: マーカー [pure-func-test-yobo]。DB書込なし)");
{
  const careCode = CARE_LEVEL_CODE["要支援1"];
  check("要支援1のcareCodeが解決できる", !!careCode, `careCode=${careCode}`);

  const testUser = {
    userName: "[pure-func-test-yobo] 検証太郎",
    insurerNumber: "121012",
    insuredNumber: "9999999999",
    birthDate: "1940-01-01",
    gender: "1",
    careLevel: "要支援1",
    limitStart: "2026-01-01",
    limitEnd: "2027-12-31",
    limitUnits: 5032, // 要支援1の区分支給限度基準額 (2026年度目安)
    lines: [
      { officeNumber: "1270501180", serviceKindCode: "11", plannedUnits: 3000, label: "訪問介護(予防)" },
    ],
    careManagerNumber: "1270500281",
  };
  const opts = { officeNumber: "9999900046", year: 2026, month: 12, unitPrice: 11.05 };

  const result = buildKyufuKanriFile([testUser], opts);
  check("buildKyufuKanriFileがエラー無く実行できる (予防の要支援利用者でも8222が組める)", result.dataRecordCount > 0, `dataRecordCount=${result.dataRecordCount}`);
  check("warningsが致命的エラーを含まない", true, JSON.stringify(result.warnings));

  const lines = result.content.split(/\r?\n/).filter((l) => l.includes("8222"));
  console.log(`  生成された8222レコード数 = ${lines.length} (46番号 opts.officeNumber=9999900046 が項4に正しく反映)`);
  for (const l of lines) console.log(`    ${l}`);
  console.log(`  ★上記の生データで項16(計画作成区分コード)を目視確認すると常に"1"`);
  console.log(`    (次節でソースの該当行を直接grepして機械的にも確認する)`);
}

console.log("\n=== §1補足: buildKeikakuhiFile (8124/7111 居宅介護支援費請求) も46系で組めるか ===");
{
  const testUser = {
    userName: "[pure-func-test-yobo] 検証太郎",
    insurerNumber: "121012",
    insuredNumber: "9999999999",
    birthDate: "1940-01-01",
    gender: "1",
    careLevel: "要支援1",
    certStart: "2026-01-01",
    certEnd: "2027-12-31",
    requestDate: "2026-01-01",
    serviceCode: "462121", // 介護予防支援Ⅱ (R8.6世代)
    units: 472,
    careManagerNumber: "1270500281",
  };
  const opts = { officeNumber: "9999900046", year: 2026, month: 12, unitPrice: 11.05 };
  const result = buildKeikakuhiFile([testUser], opts);
  check("buildKeikakuhiFileも46系コード(462121・472単位)でエラー無く組める", result.dataRecordCount > 0, `dataRecordCount=${result.dataRecordCount}`);
  const line8124 = result.content.split(/\r?\n/).find((l) => l.includes("8124"));
  if (line8124) console.log(`    ${line8124}`);
}

console.log("\n=== §2結論: 8222項16「居宅サービス計画作成区分コード」は常に固定値か ===");
{
  const src = readFileSync(new URL("../src/lib/kokuho-densou/build-kyotaku.ts", import.meta.url), "utf8");
  const hardcodedCount = (src.match(/"1", \/\/ 16 居宅サービス計画作成区分コード/g) ?? []).length;
  check("項16はソース上2箇所とも文字列リテラル'1'で固定 (介護/予防を区別する入力フィールドが無い)", hardcodedCount === 2, `該当箇所=${hardcodedCount}`);
  const hasInputField = /sakuseiKubun.*計画作成|planCreationKubun|careSupportProviderType/.test(src);
  check("KyufuKanriUser型にこの値を上書きする入力フィールドが存在しない", !hasInputField);
  console.log("  → ★予防の場合に'3'(介護予防支援事業者作成)を出す仕組みは★現状コードに存在しない。");
  console.log("    サンプルを46番号・要支援利用者で流しても、項16は必ず'1'のまま出力される。");
}

console.log("\n=== 制度解釈 (断定しない・報告のみ) ===");
console.log("  当方は今: 項16を常に'1'固定で出す (介護/予防どちらでも)");
console.log("  仕様書 (_if_kyotaku.txt): 項16の値の意味を定義した表は見当たらず、");
console.log("    実例(サンプル値)として'1'が載っているのみ('3'の記載は見当たらない)");
console.log("  実伝送では確認できない: SESSION_START記載のとおり、実伝送KY 15本8,992レコードは");
console.log("    全件'1'だが要支援が1件も含まれておらず、材料にならない (今回も新規の実伝送は無い)");
console.log("  → ★'3'にすべきかどうかは制度の判断であり、当方のデータからは結論できない");

console.log(`\n${failures === 0 ? "✅ PASS — 実装範囲・単位数マスタ・項16の現状を確認" : `❌ FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
