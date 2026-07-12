/**
 * 国保連通知ファイル取込の机上検証スクリプト (READ-ONLY / DB 書込なし)
 *
 *   node migrations/test_kokuho_tsuchi_parse.mjs
 *
 * 内容:
 *   0. src/lib/kokuho-tsuchi/*.ts を一時 dir に CJS コンパイルして実ソースを検証
 *   1. 仕様書レイアウト (_if_kyotaku.txt / _if_svc.txt) から擬似通知ファイルを自作
 *      (7411 居宅13項目 + svc14項目 / 7511 / 7513 / 7521 / 7211 / 未対応種別)
 *   2. Shift_JIS 往復 → parse → 期待値 assert
 *   3. 実 DB (REST 読み取りのみ) で被保険者番号 → client 突合を検証
 *   4. kaigo_billing_status へ upsert 「される予定の」payload を dry-run 表示 (書込はしない)
 *
 * ⚠ 実ファイル未検証: 擬似ファイルは仕様書の項目順から自作したもの。
 *   国保連の実ファイルで列位置を検証するまでは取込プレビューの目視確認が必須。
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname2, "..");
const require2 = createRequire(pathToFileURL(join(appRoot, "package.json")).href);
const Encoding = require2("encoding-japanese");
const { createClient } = require2("@supabase/supabase-js");

/* ── 0. 実ソース (parse.ts / apply.ts) を CJS コンパイルして読み込む ──
   (node_modules 解決のため app 配下に一時 dir を作る。終了時に削除) */
const buildDir = mkdtempSync(join(appRoot, "migrations", "_tmp_tsuchi_test_"));
try {
  execSync(
    `npx tsc "${join(appRoot, "src/lib/kokuho-tsuchi/parse.ts")}" "${join(appRoot, "src/lib/kokuho-tsuchi/apply.ts")}"` +
      ` --outDir "${buildDir}" --module commonjs --target es2020 --moduleResolution node` +
      ` --esModuleInterop --skipLibCheck --strict false`,
    { cwd: appRoot, stdio: "inherit" },
  );
} catch {
  console.error("コンパイルに失敗しました");
  rmSync(buildDir, { recursive: true, force: true });
  process.exit(1);
}
const { parseNoticeFileText, decodeNoticeSjis } = require2(join(buildDir, "parse.js"));
const { resolveClientsByInsuredNumber } = require2(join(buildDir, "apply.js"));

let failed = 0;
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label} = ${a}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}: actual=${a} expected=${e}`);
  }
}

function sjisRoundtrip(text) {
  const sjis = Encoding.convert(Encoding.stringToCode(text), { to: "SJIS", from: "UNICODE" });
  return decodeNoticeSjis(new Uint8Array(sjis));
}

/* ── 1. 擬似ファイル (レイアウト根拠は parse.ts 冒頭コメントの仕様書行番号) ── */

// 7411 返戻（保留）一覧表: H1 + 居宅版 D1(13項目) + svc版 D1(14項目)
const henreiFile = [
  "1,1,0,3,741,0,0,1234567890,0,1,202605,1",
  // H1: 事業所番号,事業所名,審査年月,作成年月日,頁,国保連合会名
  "2,2,7411,H1,1234567890,テスト居宅介護支援事業所,202605,20260610,1,千葉県国保連合会",
  // D1 (居宅13項目): 保険者番号,保険者名,被保険者番号,カナ,種別,提供年月,種類ｺｰﾄﾞ,単位数,事由,内容,備考
  "2,3,7411,D1,12345678,千葉市,0000012345,ﾃｽﾄ ﾀﾛｳ,給,202604,43,12345,C,給付管理票と突合不一致,保留",
  // D1 (svc14項目): +サービス項目コード等。単位数は符号付き (マイナス) を検証
  "2,4,7411,D1,12345678,千葉市,9999999999,ﾃｽﾄ ﾊﾅｺ,請,202604,11,-2500,B,資格エラー ERR01,,111111",
  "3,5",
].join("\r\n");

// 7511 支払決定額通知書 (居宅版20項目)
const shiharai7511 = [
  "1,1,0,1,751,0,0,1234567890,0,1,202605,1",
  // H1: 審査年月,郵3,郵4,住所,事業所名,開設者,事業所番号,振込金額,介護給付費支払額,
  //     主治医意見書作成料,同税,認定調査費,同税,合計金額,金融機関名,支店名,作成年月日,国保連合会名
  "2,2,7511,H1,202605,260,0001,千葉市中央区1-1,テスト事業所,テスト太郎,1234567890,1234567,1200000,30000,3000,1000,100,1234567,テスト銀行,本店,20260615,千葉県国保連合会",
  "3,3",
].join("\r\n");

// 7513 支払決定額通知書 (サービス事業所版22項目 = +総合事業費,電子証明書手数料)
const shiharai7513 = [
  "1,1,0,1,751,0,0,9876543210,0,1,202605,1",
  "2,2,7513,H1,202605,260,0002,千葉市花見川区2-2,テスト訪問介護,テスト花子,9876543210,2000000,1900000,0,0,0,0,90000,10000,2000000,テスト銀行,支店,20260615,千葉県国保連合会",
  "3,3",
].join("\r\n");

// 7521 内訳書: H1 + D1 + T1/T2/T3
const uchiwakeFile = [
  "1,1,0,5,752,0,0,1234567890,0,1,202605,1",
  "2,2,7521,H1,1234567890,テスト事業所,202605,20260610,1,千葉県国保連合会",
  // D1: 保険者番号,提供年月,種類ｺｰﾄﾞ,種類名,件数,日数,単位数,金額,介護給付費,食事件数,食事回数,食事提供費,食事負担額
  "2,3,7521,D1,12345678,202604,11,訪問介護,10,55,123456,1234560,1111104,0,0,0,0",
  "2,4,7521,T1,10,55,123456,1234560,1111104,0,0,0,0",
  "2,5,7521,T2,1,5,1000,10000,9000,0,0,0,0",
  "2,6,7521,T3,9,50,122456,1224560,1102104,0,0,0,0",
  "3,7",
].join("\r\n");

// 7211 増減表 + 未対応種別 (7911) 混在
const zougenFile = [
  "1,1,0,3,721,0,0,1234567890,0,1,202605,1",
  "2,2,7211,H1,1234567890,テスト事業所,202605,20260610,1,千葉県国保連合会",
  // D1: 保険者番号,提供年月, 返戻[件数介,件数食,単位数介,食事費], 査定増減[〃], 保留[〃], 保留復活[〃]
  "2,3,7211,D1,12345678,202604,2,0,15000,0,1,0,-500,0,1,0,3000,0,0,0,0,0",
  "2,4,7911,D1,ダミー未対応レコード",
  "3,5",
].join("\r\n");

/* ── 2. パース検証 ── */

console.log("── 7411 返戻（保留）一覧表 ──");
{
  const p = parseNoticeFileText(sjisRoundtrip(henreiFile), "74110000.CSV");
  assertEq("control.dataType", p.control?.dataType, "741");
  assertEq("control.officeNumber", p.control?.officeNumber, "1234567890");
  assertEq("shinsaYm", p.shinsaYm, "2026-05");
  assertEq("headerOfficeNumber", p.headerOfficeNumber, "1234567890");
  assertEq("henreiHeaders[0].officeName", p.henreiHeaders[0]?.officeName, "テスト居宅介護支援事業所");
  assertEq("henreiRows.length", p.henreiRows.length, 2);
  const r0 = p.henreiRows[0];
  assertEq("r0.insuredNumber", r0.insuredNumber, "0000012345");
  assertEq("r0.shubetsu", r0.shubetsu, "給");
  assertEq("r0.serviceYm", r0.serviceYm, "2026-04");
  assertEq("r0.serviceKindCode", r0.serviceKindCode, "43");
  assertEq("r0.tanisu", r0.tanisu, 12345);
  assertEq("r0.jiyuCode", r0.jiyuCode, "C");
  assertEq("r0.biko(保留)", r0.biko, "保留");
  assertEq("r0.serviceItemCode(居宅版=null)", r0.serviceItemCode, null);
  const r1 = p.henreiRows[1];
  assertEq("r1.tanisu(符号付き)", r1.tanisu, -2500);
  assertEq("r1.serviceItemCode(svc版)", r1.serviceItemCode, "111111");
  assertEq("warnings", p.warnings, []);
  assertEq("unsupported", p.unsupported, []);
}

console.log("── 7511 支払決定額通知書 (居宅版20項目) ──");
{
  const p = parseNoticeFileText(sjisRoundtrip(shiharai7511), "75100000.CSV");
  assertEq("shiharaiKettei.length", p.shiharaiKettei.length, 1);
  const k = p.shiharaiKettei[0];
  assertEq("k.shinsaYm", k.shinsaYm, "2026-05");
  assertEq("k.officeNumber", k.officeNumber, "1234567890");
  assertEq("k.furikomiAmount", k.furikomiAmount, 1234567);
  assertEq("k.kaigoKyufuhiAmount", k.kaigoKyufuhiAmount, 1200000);
  assertEq("k.sougouJigyouhi(7511=null)", k.sougouJigyouhi, null);
  assertEq("k.goukeiAmount", k.goukeiAmount, 1234567);
  assertEq("k.bankName", k.bankName, "テスト銀行");
  assertEq("k.furikomiDate", k.furikomiDate, "20260615");
  assertEq("warnings", p.warnings, []);
}

console.log("── 7513 支払決定額通知書 (svc版22項目) ──");
{
  const p = parseNoticeFileText(sjisRoundtrip(shiharai7513), "75100001.CSV");
  const k = p.shiharaiKettei[0];
  assertEq("k.exchangeNumber", k.exchangeNumber, "7513");
  assertEq("k.furikomiAmount", k.furikomiAmount, 2000000);
  assertEq("k.sougouJigyouhi", k.sougouJigyouhi, 90000);
  assertEq("k.denshiShoumeisho", k.denshiShoumeisho, 10000);
  assertEq("k.goukeiAmount", k.goukeiAmount, 2000000);
  assertEq("k.branchName", k.branchName, "支店");
  assertEq("warnings", p.warnings, []);
}

console.log("── 7521 支払決定額内訳書 ──");
{
  const p = parseNoticeFileText(sjisRoundtrip(uchiwakeFile), "75200000.CSV");
  assertEq("uchiwakeHeaders[0].shinsaYm", p.uchiwakeHeaders[0]?.shinsaYm, "2026-05");
  assertEq("uchiwakeRows.length", p.uchiwakeRows.length, 1);
  const u = p.uchiwakeRows[0];
  assertEq("u.serviceKindName", u.serviceKindName, "訪問介護");
  assertEq("u.tanisu", u.tanisu, 123456);
  assertEq("u.kingaku", u.kingaku, 1234560);
  assertEq("u.kyufuhi", u.kyufuhi, 1111104);
  assertEq("trailers(T1/T2/T3)", p.uchiwakeTrailers.map((t) => t.recordKind), ["T1", "T2", "T3"]);
  assertEq("warnings", p.warnings, []);
}

console.log("── 7211 増減表 + 未対応種別 ──");
{
  const p = parseNoticeFileText(sjisRoundtrip(zougenFile), "72110000.CSV");
  assertEq("zougenRows.length", p.zougenRows.length, 1);
  const z = p.zougenRows[0];
  assertEq("z.insurerNumber", z.insurerNumber, "12345678");
  assertEq("z.henrei", z.henrei, { kensuKaigo: 2, kensuShokuji: 0, tanisuKaigo: 15000, shokujihi: 0 });
  assertEq("z.satei.tanisu(符号付き)", z.satei.tanisuKaigo, -500);
  assertEq("z.horyu.kensuKaigo", z.horyu.kensuKaigo, 1);
  assertEq("unsupported", p.unsupported, [{ exchangeNumber: "7911", count: 1 }]);
  assertEq("warnings", p.warnings, []);
}

console.log("── 異常系 (エンドレコード無し / 件数不一致) ──");
{
  const bad = ["1,1,0,99,741,0,0,1234567890,0,1,202605,1", "2,2,7411,H1,1,x,202605,20260610,1,x"].join("\r\n");
  const p = parseNoticeFileText(bad, "bad.CSV");
  assertEq("warnings.length>=2", p.warnings.length >= 2, true);
  console.log("  warnings:", p.warnings);
}

/* ── 3. 実 DB 突合 (REST 読み取りのみ) ── */

const env = Object.fromEntries(
  readFileSync(join(appRoot, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function main() {
  if (!SB_URL || !SB_KEY) {
    console.log("(.env.local に接続情報が無いため DB 突合はスキップ)");
    return;
  }
  const sb = createClient(SB_URL, SB_KEY);

  // 被保険者番号を持つ実在 client を 1 名取得 (読み取りのみ)
  const { data: sample, error } = await sb
    .from("clients")
    .select("id, name, insured_number")
    .not("insured_number", "is", null)
    .neq("insured_number", "")
    .limit(1);
  if (error) {
    console.error("  clients 読取に失敗:", error.message);
    failed += 1;
    return;
  }
  if (!sample || sample.length === 0) {
    console.log("(insured_number を持つ利用者が無いため DB 突合はスキップ)");
    return;
  }
  const c = sample[0];
  console.log(`── 実 DB 突合 (被保険者番号→client 解決 / 対象: ${c.name}) ──`);

  const matches = await resolveClientsByInsuredNumber(sb, [c.insured_number, "ZZ_NO_MATCH_99"]);
  assertEq("matched.clientId", matches.get(c.insured_number)?.clientId, c.id);
  assertEq("unmatched は Map に入らない", matches.has("ZZ_NO_MATCH_99"), false);

  // 4. 実在被保険者番号を擬似 7411 に差し込み → パース → 突合 → upsert payload の dry-run
  const realFile = [
    "1,1,0,2,741,0,0,1234567890,0,1,202605,1",
    "2,2,7411,H1,1234567890,テスト事業所,202605,20260610,1,千葉県国保連合会",
    `2,3,7411,D1,12345678,千葉市,${c.insured_number},ﾃｽﾄ,請,202604,11,3000,A,一次チェックエラー,`,
    "3,4",
  ].join("\r\n");
  const p = parseNoticeFileText(sjisRoundtrip(realFile), "74110001.CSV");
  const m = await resolveClientsByInsuredNumber(sb, p.henreiRows.map((r) => r.insuredNumber));
  const row = p.henreiRows[0];
  const matched = m.get(row.insuredNumber);
  assertEq("パース→突合 一連 (client 解決)", matched?.clientId, c.id);
  console.log("  [dry-run] kaigo_billing_status へ upsert される payload (書込はしない):");
  console.log("   ", JSON.stringify({
    client_id: matched?.clientId,
    target_month: row.serviceYm,
    henrei: true,
    notes: `[返戻取込 ${p.shinsaYm}審査] 種別${row.shubetsu} ${row.jiyuCode}(一次チェックエラー) ${row.jiyuNaiyo}`,
  }));
}

main()
  .catch((e) => {
    failed += 1;
    console.error("エラー:", e);
  })
  .finally(() => {
    rmSync(buildDir, { recursive: true, force: true });
    console.log(failed === 0 ? "\n== ALL OK ==" : `\n== ${failed} FAILED ==`);
    process.exit(failed === 0 ? 0 : 1);
  });
