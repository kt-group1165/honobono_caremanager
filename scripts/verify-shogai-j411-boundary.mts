/**
 * 障害 利用者負担上限額管理結果票 (J411) の境界値検証 — buildShogaiDensou の純関数テスト
 *
 * ⚠ DB には触らない (buildShogaiDensou は純関数)。
 *
 * 検証する境界:
 *   A. 自事業所が管理者で複数事業所を取りまとめる (明細の出方・項番・合計の一致)
 *   B. 管理結果区分 1 / 2 / 3 の 3 分岐
 *   C. 関係事業所が多いケース (明細行の上限)
 *   D. 上限額 0 円 (生保)
 *   E. J411 を出さない条件 (他事業所管理 / 調整計算が未保存)
 *
 *   npx tsx scripts/verify-shogai-j411-boundary.mts
 */
import { buildShogaiDensou, type ShogaiDensouUser, type ShogaiDensouKanriLine } from "../src/lib/shogai-densou/build";
import type { ShogaiSeikyuRow } from "../src/lib/shogai-seikyu/aggregate";

const OFFICE = "1210102263";
const OPTS = { officeNumber: OFFICE, year: 2026, month: 6, unitPrice: 10.9, areaCategory: "その他" };

function row(over: Partial<ShogaiSeikyuRow> = {}): ShogaiSeikyuRow {
  return {
    user_id: "u1", user_name: "検証 太郎", user_name_kana: "ケンショウ タロウ",
    beneficiary_number: "1234567890", municipality: "121004", support_level: "区分3",
    self_payment_limit: 9300, seiho: false,
    details: [{ service_type: "居宅介護", service_category: "身体", service_code: "111111", unit_per: 250, count: 10, units: 2500 }],
    addons: [], addonUnits: 0, addonLabel: null, addonCode: null,
    totalUnits: 2500, unitPrice: 10.9, totalAmount: 27250, userAmount: 2725, benefitAmount: 24525,
    jogenKanriKubun: "自事業所", jogenKanriOfficeNumber: null, jogenKanriOfficeName: null,
    kanriResult: 1, kanriResultAmount: 2725,
    certStart: "2026-04-01", certEnd: "2027-03-31", shikyuryoOver: [],
    ...over,
  } as ShogaiSeikyuRow;
}

const kline = (o: Partial<ShogaiDensouKanriLine>): ShogaiDensouKanriLine => ({
  office_number: "1210999999", office_name: "他社事業所", total_amount: 0, user_amount: 0, adjusted_amount: 0, is_self: false, ...o,
});

function user(r: ShogaiSeikyuRow, lines: ShogaiDensouKanriLine[] | null): ShogaiDensouUser {
  return {
    row: r,
    visits: [{ date: "2026-06-03", startTime: "09:00", endTime: "10:00", durationMinutes: 60, category: "身体", serviceCode: "111111", serviceName: "身体介護" }],
    contractAmountText: null, contractStartDate: "2026-04-01", contractEntryNumber: "1",
    jogenOfficeLines: lines,
  };
}

function parseJ411(content: string | undefined, rec: string): string[][] {
  if (!content) return [];
  return content.split(/\r?\n/).filter((l) => l.trim())
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")))
    .filter((c) => c[2] === "J411" && c[3] === rec)
    .map((c) => c.slice(2));
}
const f = (r: string[], no: number) => r[no - 1];

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n      期待 ${JSON.stringify(expected)}\n      実際 ${JSON.stringify(actual)}`}`);
}

// ── A. 自事業所が複数事業所を取りまとめる ───────────────────────────
console.log("\n【A】自事業所管理・関係事業所3件 (自事業所 + 他社2件)");
{
  const lines = [
    kline({ office_number: OFFICE, office_name: "(自事業所)", total_amount: 27250, user_amount: 2725, adjusted_amount: 2725, is_self: true }),
    kline({ office_number: "1210900001", office_name: "他社A", total_amount: 50000, user_amount: 5000, adjusted_amount: 4000 }),
    kline({ office_number: "1210900002", office_name: "他社B", total_amount: 30000, user_amount: 3000, adjusted_amount: 2575 }),
  ];
  const res = buildShogaiDensou([user(row({ kanriResult: 3, userAmount: 2725 }), lines)], OPTS);
  const j01 = parseJ411(res.jogenFile?.content, "01")[0];
  const j02 = parseJ411(res.jogenFile?.content, "02");
  check("J41 ファイルが生成される", !!res.jogenFile, true);
  check("明細は関係事業所数ぶん (3行)", j02.length, 3);
  check("項7 項番は 1,2,3", j02.map((r2) => f(r2, 7)), ["1", "2", "3"]);
  check("項8 事業所番号 (自事業所行は自番号)", j02.map((r2) => f(r2, 8)), [OFFICE, "1210900001", "1210900002"]);
  check("項9 総費用額", j02.map((r2) => f(r2, 9)), ["27250", "50000", "30000"]);
  check("項10 利用者負担額", j02.map((r2) => f(r2, 10)), ["2725", "5000", "3000"]);
  check("項11 調整後利用者負担額", j02.map((r2) => f(r2, 11)), ["2725", "4000", "2575"]);
  // 合計 (基本情報 項12-14) = 明細の単純和
  check("項12 総費用額合計 = 107250", f(j01, 12), String(27250 + 50000 + 30000));
  check("項13 利用者負担額合計 = 10725", f(j01, 13), String(2725 + 5000 + 3000));
  check("項14 調整後合計 = 9300 (= 上限月額)", f(j01, 14), String(2725 + 4000 + 2575));
  check("項10 利用者負担上限月額", f(j01, 10), "9300");
  check("項11 管理結果 = 3", f(j01, 11), "3");
  check("項4 作成区分 = 1 (新規)", f(j01, 4), "1");
  console.log(`  ・調整後合計 ${2725 + 4000 + 2575} が上限月額 9300 と一致 = 管理結果3 の整合`);
}

// ── B. 管理結果区分の3分岐 ──────────────────────────────────────────
console.log("\n【B】管理結果区分 1 / 2 / 3");
{
  for (const [kanri, label] of [[1, "管理事業所で充当済"], [2, "利用者負担額が上限を超えない"], [3, "上限額調整"]] as const) {
    const lines = [
      kline({ office_number: OFFICE, office_name: "(自事業所)", total_amount: 27250, user_amount: 2725, adjusted_amount: 2725, is_self: true }),
      kline({ office_number: "1210900001", total_amount: 10000, user_amount: 1000, adjusted_amount: 1000 }),
    ];
    const res = buildShogaiDensou([user(row({ kanriResult: kanri }), lines)], OPTS);
    const j01 = parseJ411(res.jogenFile?.content, "01")[0];
    check(`区分${kanri} (${label}) が項11に出る`, f(j01, 11), String(kanri));
  }
  // 区分3 で関係事業所の総費用額が 0 のまま → 警告
  const zero = [
    kline({ office_number: OFFICE, total_amount: 27250, user_amount: 2725, adjusted_amount: 2725, is_self: true }),
    kline({ office_number: "1210900001", total_amount: 0, user_amount: 0, adjusted_amount: 0 }),
  ];
  const resZero = buildShogaiDensou([user(row({ kanriResult: 3 }), zero)], OPTS);
  check("区分3 で他事業所の総費用額が0なら警告", resZero.warnings.some((w) => w.includes("総費用額が未入力")), true);
}

// ── C. 関係事業所が多いケース ───────────────────────────────────────
console.log("\n【C】関係事業所が多いケース (明細行の上限)");
{
  const many: ShogaiDensouKanriLine[] = [
    kline({ office_number: OFFICE, total_amount: 27250, user_amount: 2725, adjusted_amount: 2725, is_self: true }),
    ...Array.from({ length: 120 }, (_, i) => kline({ office_number: String(1210900000 + i), total_amount: 1000, user_amount: 100, adjusted_amount: 100 })),
  ];
  const res = buildShogaiDensou([user(row({ kanriResult: 3 }), many)], OPTS);
  const j02 = parseJ411(res.jogenFile?.content, "02");
  check("121件すべて明細行として出る (打ち切りなし)", j02.length, 121);
  check("項番は 1..121 (3桁になる)", [f(j02[0], 7), f(j02[98], 7), f(j02[120], 7)], ["1", "99", "121"]);
  const capped = res.warnings.some((w) => /上限|件を超え/.test(w));
  console.log(`  ⚠ 明細行数の上限チェックは **無い** (警告${capped ? "あり" : "なし"})。`);
  console.log("    給付管理票(8222)は98行で打ち切り+警告があるが、J411 には同等の実装が無い。");
  console.log("    ただし実運用の関係事業所数は下の分母を参照 (現実には数件)。");
}

// ── D. 上限額 0 円 (生保) ───────────────────────────────────────────
console.log("\n【D】上限額 0 円 (生保)");
{
  const lines = [
    kline({ office_number: OFFICE, total_amount: 27250, user_amount: 0, adjusted_amount: 0, is_self: true }),
    kline({ office_number: "1210900001", total_amount: 10000, user_amount: 0, adjusted_amount: 0 }),
  ];
  const res = buildShogaiDensou([user(row({ self_payment_limit: 0, seiho: true, userAmount: 0, benefitAmount: 27250, kanriResult: 2 }), lines)], OPTS);
  const j01 = parseJ411(res.jogenFile?.content, "01")[0];
  check("項10 上限月額 = 0", f(j01, 10), "0");
  check("項13/14 も 0", [f(j01, 13), f(j01, 14)], ["0", "0"]);
  check("項12 総費用額は 0 ではない", f(j01, 12), "37250");
}

// ── E. J411 を出さない条件 ──────────────────────────────────────────
console.log("\n【E】J411 を出さない条件");
{
  // 他事業所管理 → 自事業所は結果票を作らない
  const other = buildShogaiDensou([user(row({ jogenKanriKubun: "他事業所", jogenKanriOfficeNumber: "1210999999" }), null)], OPTS);
  check("他事業所管理なら J41 ファイルは null", other.jogenFile, null);
  // 上限管理なし
  const none = buildShogaiDensou([user(row({ jogenKanriKubun: "なし", kanriResult: null }), null)], OPTS);
  check("上限管理なしでも J41 は null", none.jogenFile, null);
  // 自事業所管理だが調整計算が未保存
  const unsaved = buildShogaiDensou([user(row({ jogenKanriKubun: "自事業所", kanriResult: 1 }), null)], OPTS);
  check("自事業所管理でも office_lines が無ければ出力しない", unsaved.jogenFile, null);
  check("その場合は警告が出る", unsaved.warnings.some((w) => w.includes("調整計算が未保存")), true);
  console.log("  ⚠ これが『0件を作る沈黙』になりうる箇所: 保存忘れで J411 が丸ごと出ない。");
  console.log("    ただし warning は出るので気づける (握り潰しではない)。");
}

// ── F. 処理対象年月の上書き (再請求) と 実伝送とのバイト一致 ────────────
console.log("\n【F】処理対象年月の上書き + 実伝送 (おゆみ野 JJ260801) とのバイト一致");
{
  const OFF = "1210101760";
  const realLines: ShogaiDensouKanriLine[] = [
    kline({ office_number: OFF, office_name: "(自事業所)", total_amount: 2354, user_amount: 235, adjusted_amount: 235, is_self: true }),
    kline({ office_number: "1210103428", office_name: "他社", total_amount: 235679, user_amount: 9300, adjusted_amount: 9065 }),
  ];
  const realRow = row({
    user_name: "松崎 淑子", user_name_kana: "ﾏﾂｻﾞｷ ﾖｼｺ", beneficiary_number: "2000055810",
    municipality: "121004", self_payment_limit: 9300,
    totalUnits: 216, totalAmount: 2354, userAmount: 235, benefitAmount: 2119,
    kanriResult: 3, kanriResultAmount: 235,
  });
  const base = { officeNumber: OFF, year: 2026, month: 6, unitPrice: 10.9, areaCategory: "その他" };

  // 既定 (指定なし) は従来どおり 提供月+1
  const def = buildShogaiDensou([user(realRow, realLines)], base);
  const defCtrl = (def.jogenFile?.content ?? "").split(/\r?\n/)[0];
  check("shori 未指定なら従来どおり 202607 (既定の挙動を変えない)", defCtrl.includes(",202607,"), true);

  // 再請求 (提出は 8 月) を明示 → 実伝送とバイト一致するはず
  const re = buildShogaiDensou([user(realRow, realLines)], { ...base, shoriYear: 2026, shoriMonth: 8 });
  const ours = (re.jogenFile?.content ?? "").split(/\r?\n/).filter((l) => l.trim());
  const theirs = [
    `1,1,0,3,J41,0,${OFF},0,1,202608,`,
    `2,2,"J411",01,202606,1,121004,${OFF},"2000055810","ﾏﾂｻﾞｷﾖｼｺ","",9300,3,238033,9535,9300`,
    `2,3,"J411",02,202606,121004,${OFF},"2000055810",1,${OFF},2354,235,235`,
    `2,4,"J411",02,202606,121004,${OFF},"2000055810",2,1210103428,235679,9300,9065`,
    `3,5`,
  ];
  check("再請求指定で 実伝送 JJ260801 と全行バイト一致", ours, theirs);
  console.log("  ・氏名カナ (項8) も ほのぼの と同じく設定される (J411対象16名は全員フリガナあり)");
}

console.log(`\n${failures === 0 ? "✅ 全ての検算が一致しました" : `❌ ${failures} 件の不一致`}`);
process.exit(failures === 0 ? 0 : 1);
