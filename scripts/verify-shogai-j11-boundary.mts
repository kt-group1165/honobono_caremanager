/**
 * 障害 請求書(J111) / 明細書(J121) の境界値検証 — buildShogaiDensou の純関数テスト
 *
 * ⚠ **DB には一切触らない。**buildShogaiDensou は supabase を参照しない純関数なので、
 *   本番DBに marker 付きサンプルを入れずに in-memory fixture で検算できる。
 *
 * 検証する境界:
 *   A. 上限管理なし
 *   B. 上限管理あり (自事業所 / 他事業所) — 項15/16/17/25/26
 *   C. 複数サービス種別の混在 (11 居宅介護 + 12 重度訪問介護)
 *   D. 市町村が複数 (J111 は市町村ごとに 1 セット)
 *   E. 明細行 (03) の並び順・加算の桁溢れ警告
 *   F. 上限月額調整 = min(上限月額, 1割相当額) の境界
 *
 *   npx tsx scripts/verify-shogai-j11-boundary.mts
 */
import { buildShogaiDensou, type ShogaiDensouUser } from "../src/lib/shogai-densou/build";
import type { ShogaiSeikyuRow } from "../src/lib/shogai-seikyu/aggregate";

const OPTS = { officeNumber: "1210102263", year: 2026, month: 6, unitPrice: 10.9, areaCategory: "その他" };

function row(over: Partial<ShogaiSeikyuRow> = {}): ShogaiSeikyuRow {
  const base: ShogaiSeikyuRow = {
    user_id: "u1",
    user_name: "検証 太郎",
    user_name_kana: "ケンショウ タロウ",
    beneficiary_number: "1234567890",
    municipality: "121004",
    support_level: "区分3",
    self_payment_limit: 9300,
    seiho: false,
    details: [{ service_type: "居宅介護", service_category: "身体", service_code: "111111", unit_per: 250, count: 10, units: 2500 }],
    addons: [],
    addonUnits: 0,
    addonLabel: null,
    addonCode: null,
    totalUnits: 2500,
    unitPrice: 10.9,
    totalAmount: 27250,
    userAmount: 2725,
    benefitAmount: 24525,
    jogenKanriKubun: "なし",
    jogenKanriOfficeNumber: null,
    jogenKanriOfficeName: null,
    kanriResult: null,
    kanriResultAmount: null,
    certStart: "2026-04-01",
    certEnd: "2027-03-31",
    shikyuryoOver: [],
    ...over,
  };
  return base;
}

function user(r: ShogaiSeikyuRow, visitDates: string[] = ["2026-06-03", "2026-06-10"]): ShogaiDensouUser {
  return {
    row: r,
    visits: visitDates.map((date) => ({
      date, startTime: "09:00", endTime: "10:00", durationMinutes: 60,
      category: "身体", serviceCode: r.details[0]?.service_code ?? "111111", serviceName: "身体介護",
    })),
    contractAmountText: null,
    contractStartDate: "2026-04-01",
    contractEntryNumber: "1",
    jogenOfficeLines: null,
  };
}

/** J11 の content から `種別,連番` を落として 項番=index+1 に揃える */
function parseJ11(content: string, kind: string, rec: string): string[][] {
  return content
    .split(/\r?\n/).filter((l) => l.trim())
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")))
    .filter((c) => c[2] === kind && c[3] === rec)
    .map((c) => c.slice(2));
}
const f = (r: string[], no: number) => r[no - 1];

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n      期待 ${JSON.stringify(expected)}\n      実際 ${JSON.stringify(actual)}`}`);
}

// ── A. 上限管理なし ─────────────────────────────────────────────────
console.log("\n【A】上限管理なし");
{
  const res = buildShogaiDensou([user(row())], OPTS);
  const j121 = parseJ11(res.seikyuFile.content, "J121", "01")[0];
  check("項15 上限額管理事業所番号 は空", f(j121, 15), "");
  check("項16 管理結果 は空", f(j121, 16), "");
  check("項25 調整後利用者負担額 は空", f(j121, 25), "");
  check("項26 上限額管理後利用者負担額 は空", f(j121, 26), "");
  check("項27 決定利用者負担額 = userAmount", f(j121, 27), "2725");
  check("項22 上限月額調整 = min(9300, 1割2725) = 2725", f(j121, 22), "2725");
  check("項28 請求額 = benefitAmount", f(j121, 28), "24525");
}

// ── B. 上限管理あり ─────────────────────────────────────────────────
console.log("\n【B】上限管理あり");
{
  console.log(" B-1 自事業所が管理者");
  const rSelf = row({ jogenKanriKubun: "自事業所", kanriResult: 1, kanriResultAmount: 2725, userAmount: 2725 });
  const resSelf = buildShogaiDensou([user(rSelf)], OPTS);
  const jSelf = parseJ11(resSelf.seikyuFile.content, "J121", "01")[0];
  check("項15 = 自事業所番号", f(jSelf, 15), OPTS.officeNumber);
  check("項16 管理結果 = 1", f(jSelf, 16), "1");
  check("項17 管理結果額 = userAmount", f(jSelf, 17), "2725");
  check("項25/26 も同額", [f(jSelf, 25), f(jSelf, 26)], ["2725", "2725"]);

  console.log(" B-2 他事業所が管理者");
  const rOther = row({
    jogenKanriKubun: "他事業所", jogenKanriOfficeNumber: "1210999999",
    kanriResult: 3, kanriResultAmount: 1500, userAmount: 1500,
  });
  const resOther = buildShogaiDensou([user(rOther)], OPTS);
  const jOther = parseJ11(resOther.seikyuFile.content, "J121", "01")[0];
  check("項15 = 受給者証記載の他事業所番号", f(jOther, 15), "1210999999");
  check("項16 管理結果 = 3", f(jOther, 16), "3");
  check("項17/25/26 = 管理結果後の当事業所分", [f(jOther, 17), f(jOther, 25), f(jOther, 26)], ["1500", "1500", "1500"]);

  console.log(" B-3 他事業所管理なのに事業所番号が未設定 (既知の返戻要因)");
  const rMiss = row({ jogenKanriKubun: "他事業所", jogenKanriOfficeNumber: null, kanriResult: 1, kanriResultAmount: 2725 });
  const resMiss = buildShogaiDensou([user(rMiss)], OPTS);
  const jMiss = parseJ11(resMiss.seikyuFile.content, "J121", "01")[0];
  check("項15 が空のまま出力される (= 国保連で返戻)", f(jMiss, 15), "");
  const warned = resMiss.warnings.some((w) => /上限額管理事業所番号|管理事業所/.test(w));
  console.log(`  ・警告の有無: ${warned ? "あり" : "★なし (check:densou 側で拾う設計)"}`);
}

// ── C. 複数サービス種別の混在 ───────────────────────────────────────
console.log("\n【C】複数サービス種別の混在 (11 居宅介護 + 12 重度訪問介護)");
{
  const r = row({
    details: [
      { service_type: "居宅介護", service_category: "身体", service_code: "111111", unit_per: 250, count: 10, units: 2500 },
      { service_type: "重度訪問介護", service_category: "重訪", service_code: "121121", unit_per: 98, count: 20, units: 1960 },
    ],
    totalUnits: 4460, totalAmount: 48614, userAmount: 4861, benefitAmount: 43753,
  });
  const u = user(r);
  u.visits = [
    { date: "2026-06-03", startTime: "09:00", endTime: "10:00", durationMinutes: 60, category: "身体", serviceCode: "111111", serviceName: "身体介護" },
    { date: "2026-06-05", startTime: "13:00", endTime: "21:00", durationMinutes: 480, category: "重訪", serviceCode: "121121", serviceName: "重度訪問介護" },
  ];
  const res = buildShogaiDensou([u], OPTS);
  const j111_02 = parseJ11(res.seikyuFile.content, "J111", "02");
  const j121_02 = parseJ11(res.seikyuFile.content, "J121", "02");
  const j121_04 = parseJ11(res.seikyuFile.content, "J121", "04");
  check("J111-02 はサービス種類ごとに1行 (11/12)", j111_02.map((r2) => f(r2, 7)), ["11", "12"]);
  check("J121-02 日数レコードも種類ごと", j121_02.map((r2) => f(r2, 7)), ["11", "12"]);
  check("J121-04 集計レコードも種類ごと", j121_04.map((r2) => f(r2, 7)), ["11", "12"]);
  check("J121-04 集計欄分類番号は 1 から採番", j121_04.map((r2) => f(r2, 8)), ["1", "2"]);
  const sumUnits = j121_04.reduce((s, r2) => s + Number(f(r2, 10)), 0);
  check("種類別の給付単位数の和 = 総単位数 4460", sumUnits, 4460);
  const j121_01 = parseJ11(res.seikyuFile.content, "J121", "01")[0];
  check("J121-01 項20 総給付単位数", f(j121_01, 20), "4460");
}

// ── D. 市町村が複数 ─────────────────────────────────────────────────
console.log("\n【D】市町村が複数 (J111 は市町村ごとに 1 セット)");
{
  const a = user(row({ user_id: "uA", user_name: "A", beneficiary_number: "1111111111", municipality: "121004" }));
  const b = user(row({ user_id: "uB", user_name: "B", beneficiary_number: "2222222222", municipality: "122192" }));
  const res = buildShogaiDensou([a, b], OPTS);
  const j111_01 = parseJ11(res.seikyuFile.content, "J111", "01");
  check("J111-01 が市町村数ぶん (2)", j111_01.length, 2);
  check("市町村番号", j111_01.map((r2) => f(r2, 4)).sort(), ["121004", "122192"]);
  check("各市町村の件数は 1 名ずつ", j111_01.map((r2) => f(r2, 7)), ["1", "1"]);
}

// ── E. 明細 (03) の並びと加算 ───────────────────────────────────────
console.log("\n【E】明細情報 (03) の並び順と加算");
{
  const r = row({
    details: [
      { service_type: "居宅介護", service_category: "家事", service_code: "116111", unit_per: 100, count: 5, units: 500 },
      { service_type: "居宅介護", service_category: "身体", service_code: "111111", unit_per: 250, count: 10, units: 2500 },
    ],
    addons: [{ service_code: "115121", service_name: "居宅介護処遇改善加算Ⅱイ", units: 400 }],
    addonUnits: 400, totalUnits: 3400,
  });
  const res = buildShogaiDensou([user(r)], OPTS);
  const j03 = parseJ11(res.seikyuFile.content, "J121", "03");
  check("本体+加算を混ぜて **サービスコード昇順**", j03.map((x) => f(x, 7)), ["111111", "115121", "116111"]);
  check("加算行は 回数=1・単位数=単位", [f(j03[1], 9), f(j03[1], 10)], ["1", "400"]);

  const rBig = row({ addons: [{ service_code: "115121", service_name: "加算", units: 123456 }], addonUnits: 123456, totalUnits: 125956 });
  const resBig = buildShogaiDensou([user(rBig)], OPTS);
  check("加算単位が5桁超なら警告", resBig.warnings.some((w) => w.includes("5 桁")), true);
}

// ── F. 上限月額調整の境界 ───────────────────────────────────────────
console.log("\n【F】上限月額調整 = min(上限月額, 1割相当額)");
{
  // 1割 = floor(27250/10) = 2725 < 上限 9300 → 2725 側が採られる
  const low = buildShogaiDensou([user(row({ self_payment_limit: 9300 }))], OPTS);
  check("1割 < 上限 → 1割相当額", f(parseJ11(low.seikyuFile.content, "J121", "01")[0], 22), "2725");
  // 上限 1000 < 1割 2725 → 上限側
  const cap = buildShogaiDensou([user(row({ self_payment_limit: 1000 }))], OPTS);
  check("上限 < 1割 → 上限月額", f(parseJ11(cap.seikyuFile.content, "J121", "01")[0], 22), "1000");
  // 生保 (上限 0)
  const seiho = buildShogaiDensou([user(row({ self_payment_limit: 0, seiho: true, userAmount: 0, benefitAmount: 27250 }))], OPTS);
  const js = parseJ11(seiho.seikyuFile.content, "J121", "01")[0];
  check("生保 (上限0) → 上限月額調整 0", f(js, 22), "0");
  check("生保 → 項12 利用者負担上限月額 = 0", f(js, 12), "0");
  // 上限未設定 (null)
  const nul = buildShogaiDensou([user(row({ self_payment_limit: null }))], OPTS);
  const jn = parseJ11(nul.seikyuFile.content, "J121", "01")[0];
  // ⚠ build.ts は空文字を出すが、wrapFile の formatRecordLikeHonobono が
  //   「ほのぼの実伝送と同じ書式」に合わせて **空欄の数値項目を 0 埋め**するため
  //   最終的な伝送値は "0" になる。仕様どおりの挙動。
  check("上限未設定 → 項12 は 0 埋めされる (ほのぼの書式)", f(jn, 12), "0");
  check("上限未設定 → 項22 は1割相当額", f(jn, 22), "2725");
  check("上限未設定なら警告が出る", nul.warnings.some((w) => w.includes("負担上限月額が未設定")), true);
  console.log("  ⚠ 未設定(null)と負担0円が伝送上どちらも 0 になる。区別は警告のみ。");
}

console.log(`\n${failures === 0 ? "✅ 全ての検算が一致しました" : `❌ ${failures} 件の不一致`}`);
process.exit(failures === 0 ? 0 : 1);
