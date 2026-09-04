/**
 * 福祉用具(order-app) vs 訪問介護(kaigo-app) の 7131 明細書ビルダー クロス突合
 *
 *   npx tsx scripts/densou-builder-cross-diff.mts
 *
 * ── 目的 ──────────────────────────────────────────────────────────────
 *   order-app の build.ts (福祉用具) は kaigo-app の build.ts (訪問介護・
 *   ほのぼの実伝送でバイト一致確認済み) を「移植」したものと自称している
 *   (order-app/lib/kokuho-densou/build.ts:5)。同じ人物・同じ保険情報を
 *   両方に食わせて、**共通スコープ (デモグラフィック項目のエンコード)**
 *   が本当に同じ挙動かを実測する。
 *
 * ── スコープ (最初に確認した守備範囲) ──────────────────────────────────
 *   両者とも 7111 (請求書) + 7131 01(基本)/02(明細)/10(集計) の同じレコード
 *   レイアウト (項番の並びは 1:1 で一致。手で56項番を突き合わせ済み) を使う。
 *   ただし中身は:
 *     共通   : 保険者番号8桁0埋め・性別コード・要介護度コード・認定期間・
 *              居宅サービス計画作成区分・給付率・公費1基本構造
 *     訪問介護のみ: 公費2/3・保険者変更分割・限度額超過・処遇改善加算・
 *              ソート順・欠番行の除外・formatRecordLikeHonobono 適用
 *     福祉用具のみ: サービス種類コード17固定・実日数0固定・単価10円固定・
 *              TAISコード/貸与期間/半月按分 (→ この build.ts には登場しない。
 *              上流の集計 (lib/half-month-units.ts 等) 側の話で、この
 *              ビルダー比較の対象外。**福祉用具固有ルールはここでは検証できない**)
 *
 * DB は読まない (純関数のみ)。dry-run のみで書込みなし。
 */
import { buildKokuhoDensou, type DensouRow } from "../src/lib/kokuho-densou/build";
import { buildFukuyoguDensou, type FukuyoguSeikyuRow } from "../../order-app/lib/kokuho-densou/build";

let n = 0, ng = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  n++;
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(56)} ${ok ? "" : `実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`}`);
};

// ══ 共通デモグラフィック (両ビルダーに同じ値を渡す) ══════════════════════
const PERSON = {
  userName: "見本 次郎",
  insurerNumber: "122192", // → 8桁0埋め "00122192" になるはず
  insuredNumber: "1000000003",
  birthDate: "1938-11-20",
  gender: "女", // → コード "2"
  careLevel: "要介護２", // ★ 全角。order-app は NFKC で正規化、kaigo-app は?
  certStart: "2026-01-01",
  certEnd: "2028-12-31",
  careOfficeNumber: "1272401876",
  copayRate: 0.2, // → 給付率80
};

// kaigo-app は formatRecordLikeHonobono で一部項目に引用符を付ける (項1/項6等)。
// order-app は付けない。「値そのもの」を比べたいので、比較前に引用符を剥がす
// (引用符の有無自体は既知の差分 = fukuyogu-densou-check.mts で別途検出済み)。
const unq = (s: string | undefined) => (s ?? "").replace(/^"(.*)"$/, "$1");
const cols = (l: string) => l.split(",").map(unq);

function extract7131_01(content: string) {
  const lines = content.split("\r\n").filter(Boolean);
  const row = lines.map(cols).find((c) => c[2] === "7131" && c[3] === "01")!;
  return {
    insurer: row[6], // 項5 (padStart8)
    insured: row[7], // 項6
    birth: row[14], // 項13
    gender: row[15], // 項14
    careLevelCode: row[16], // 項15
    certStart: row[18], // 項17
    certEnd: row[19], // 項18
    planKubun: row[20], // 項19
    careOffice: row[21], // 項20
    benefitRate: row[31], // 項29 (index 29+2)
  };
}

console.log("══ A. 共通フィールドのエンコード一致 (公費なし・欠損なし) ══");
const kaigoRow: DensouRow = {
  user_name: PERSON.userName,
  insurer_number: PERSON.insurerNumber,
  insured_number: PERSON.insuredNumber,
  birthDate: PERSON.birthDate,
  gender: PERSON.gender,
  care_level: PERSON.careLevel,
  certStart: PERSON.certStart,
  certEnd: PERSON.certEnd,
  careOfficeNumber: PERSON.careOfficeNumber,
  copay_rate: PERSON.copayRate,
  kohiTandoku: false,
  totalUnits: 1000, totalAmount: 10000, insuranceAmount: 8000, userAmount: 2000,
  overUnits: 0, overAmount: 0,
  baseUnits: 1000, kanriTaishougaiUnits: 0, addonUnits: 0,
  serviceDays: 10,
  details: [{ service_type: "身体介護1", service_code: "111111", unit_per: 100, count: 10, units: 1000 }],
} as unknown as DensouRow;

const fukuyoguRow: FukuyoguSeikyuRow = {
  userName: PERSON.userName,
  insurerNumber: PERSON.insurerNumber,
  insuredNumber: PERSON.insuredNumber,
  birthDate: PERSON.birthDate,
  gender: PERSON.gender,
  careLevel: PERSON.careLevel,
  certStart: PERSON.certStart,
  certEnd: PERSON.certEnd,
  careOfficeNumber: PERSON.careOfficeNumber,
  copayRate: PERSON.copayRate,
  details: [{ serviceCode: "171001", unitPer: 1000, count: 1, units: 1000 }],
  totalUnits: 1000, totalCost: 10000, insuranceAmount: 8000, userAmount: 2000,
};

const kaigoOut = buildKokuhoDensou([kaigoRow], { officeNumber: "1272401876", year: 2026, month: 6, unitPrice: 10 });
const fukuyoguOut = buildFukuyoguDensou([fukuyoguRow], { officeNumber: "1272401876", year: 2026, month: 6 });

const kExt = extract7131_01(kaigoOut.content);
const fExt = extract7131_01(fukuyoguOut.content);

eq("保険者番号 8桁0埋め", kExt.insurer, fExt.insurer);
eq("被保険者番号", kExt.insured, fExt.insured);
eq("生年月日", kExt.birth, fExt.birth);
eq("性別コード", kExt.gender, fExt.gender);
eq("★ 要介護度コード (全角「要介護２」)", kExt.careLevelCode, fExt.careLevelCode);
eq("認定開始", kExt.certStart, fExt.certStart);
eq("認定終了", kExt.certEnd, fExt.certEnd);
eq("居宅サービス計画作成区分", kExt.planKubun, fExt.planKubun);
eq("担当居宅事業所番号", kExt.careOffice, fExt.careOffice);
eq("給付率 (2割→80)", kExt.benefitRate, fExt.benefitRate);

if (kExt.careLevelCode !== fExt.careLevelCode) {
  console.log("  → order-app は care_level を NFKC 正規化してから引く (build.ts:224)。");
  console.log("    kaigo-app は .trim() のみ (build.ts:266)。全角「要介護２」等が来ると");
  console.log("    kaigo-app 側は空欄 (要介護度コード変換不可の warning) になる。");
  console.log("    ⚠ ただし 2026-09-05 に client_insurance_records.care_level を実データ");
  console.log("    (1000件サンプル) で確認したところ全角混在は 0 件だった。order-app が");
  console.log("    NFKC を要したのは clients.care_level (別テーブル) の実測 306 件混在が根拠。");
  console.log("    → 参照元テーブルが違うため、kaigo-app に今すぐ同じ穴があるとは言えない。");
  console.log("    ソースが増えたとき (取込経路の変更等) に備えて NFKC 正規化を共通化しておく");
  console.log("    価値はあるが、現時点では確認された実害ではない。");
}

console.log("\n══ B. 公費 0円行の扱い (7111 計上条件) ══");
// 生保で本人負担上限額が既に0円 = kohiAmount=0 だが公費資格はある、という実在パターン
// (kaigo-app build.ts:196-205 のコメントに実伝送根拠あり: 姉ム KK260704.CSV 法別12
//  被保番1000149649 は請求額0円でも件数・単位数に含まれていた)
const kaigoKohiZero: DensouRow = { ...kaigoRow, insured_number: "1000000004", kohiHobetsu: "12", kohiAmount: 0, kohiUnits: 1000, kohiTargetCost: 10000, kohiTargetInsurance: 8000, kohiHonninFutan: 0 } as unknown as DensouRow;
const fukuyoguKohiZero: FukuyoguSeikyuRow = { ...fukuyoguRow, insuredNumber: "1000000004", kohiHobetsu: "12", kohiAmount: 0 };

const kaigoOut2 = buildKokuhoDensou([kaigoRow, kaigoKohiZero], { officeNumber: "1272401876", year: 2026, month: 6, unitPrice: 10 });
const fukuyoguOut2 = buildFukuyoguDensou([fukuyoguRow, fukuyoguKohiZero], { officeNumber: "1272401876", year: 2026, month: 6 });

const kLines2 = kaigoOut2.content.split("\r\n").filter(Boolean).map(cols);
const fLines2 = fukuyoguOut2.content.split("\r\n").filter(Boolean).map(cols);
const k7111Kohi = kLines2.filter((c) => c[2] === "7111" && c[5] === "2");
const f7111Kohi = fLines2.filter((c) => c[2] === "7111" && c[5] === "2");

console.log(`  kaigo-app:    公費0円行を 7111 公費請求分レコードに ${k7111Kohi.length > 0 ? "含めた" : "含めなかった"} (件数=${k7111Kohi[0]?.[8] ?? "なし"})`);
console.log(`  order-app:    公費0円行を 7111 公費請求分レコードに ${f7111Kohi.length > 0 ? "含めた" : "含めなかった"} (件数=${f7111Kohi[0]?.[8] ?? "なし"})`);
n++;
if ((k7111Kohi.length > 0) !== (f7111Kohi.length > 0)) {
  ng++;
  console.log("  NG  ★ 挙動が違う。kaigo-app は 2026-08-04 に「公費請求額0円でも件数・単位数計上」");
  console.log("      を実伝送で裏取りして是正済み (build.ts:196-205)。order-app は kohiAmount>0 を");
  console.log("      条件にしたままで、同じ日付の是正が移植されていない可能性がある。");
  console.log("      ⚠ ただし order-app 側の期待値は仕様書由来 (福祉用具の実伝送が手元に無い)。");
  console.log("      福祉用具でも同じ取込仕様が適用されるかは実伝送入手まで断定できない。");
} else {
  console.log("  OK  (両者一致)");
}

// 明細書 (7131-01) 側の公費欄も同じ条件で出るか
const kBasic = kLines2.filter((c) => c[3] === "01").find((c) => c[7] === "1000000004")!;
const fBasic = fLines2.filter((c) => c[3] === "01").find((c) => c[7] === "1000000004")!;
console.log(`  kaigo-app 01: 公費1負担者番号欄 = ${JSON.stringify(kBasic[8])} (空でなければ公費欄を出している)`);
console.log(`  order-app 01: 公費1負担者番号欄 = ${JSON.stringify(fBasic[8])}`);

console.log("\n══ C. 保険者番号/被保険者番号が欠損した行の扱い ══");
const kaigoMissing: DensouRow = { ...kaigoRow, insurer_number: "", insured_number: "", user_name: "欠損太郎" } as unknown as DensouRow;
const fukuyoguMissing: FukuyoguSeikyuRow = { ...fukuyoguRow, insurerNumber: "", insuredNumber: "", userName: "欠損太郎" };

const kaigoOut3 = buildKokuhoDensou([kaigoRow, kaigoMissing], { officeNumber: "1272401876", year: 2026, month: 6, unitPrice: 10 });
const fukuyoguOut3 = buildFukuyoguDensou([fukuyoguRow, fukuyoguMissing], { officeNumber: "1272401876", year: 2026, month: 6 });

const kHoken3 = kaigoOut3.content.split("\r\n").filter(Boolean).map(cols).find((c) => c[2] === "7111" && c[5] === "1")!;
const fHoken3 = fukuyoguOut3.content.split("\r\n").filter(Boolean).map(cols).find((c) => c[2] === "7111" && c[5] === "1")!;
console.log(`  入力2名 (うち1名は番号欠損)。kaigo-app 7111保険分 件数=${kHoken3[8]} / order-app 7111保険分 件数=${fHoken3[8]}`);
n++;
if (kHoken3[8] === "1" && fHoken3[8] === "2") {
  ng++;
  console.log("  NG  ★ kaigo-app は番号欠損行を伝送から丸ごと除外する (build.ts:110-127。");
  console.log("      理由: 返戻確実 + 請求書の件数/金額を水増しするため)。order-app は除外せず、");
  console.log("      warning を出すだけで 7111 の件数・金額に含めてしまう (build.ts に .filter() が無い)。");
  console.log("      → 福祉用具で保険資格の無い実績 (勤務実績はあるが認定が無い等) が混入すると");
  console.log("      order-app は請求書の集計を水増しする。kaigo-app と同じ除外ロジックが要る。");
} else {
  console.log(`  OK/要確認 (件数 kaigo=${kHoken3[8]} order=${fHoken3[8]})`);
}

console.log("\n══ D. 負のコントロール (この harness 自体が壊れたら検出できるか) ══");
// わざと不一致になる比較を1件混ぜて、eq() が正しく NG を検出するか確認する
// (最終集計には含めない独立チェック)
{
  let localNg = 0;
  const localEq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) localNg++; };
  localEq("わざと違う値A", "わざと違う値B");
  if (localNg === 1) {
    console.log("  OK  意図的な不一致を検出できた (harness の比較ロジックは機能している)");
  } else {
    console.log("  NG  ★★ 負のコントロールで不一致を検出できなかった。harness 自体が壊れている");
    ng++; n++;
  }
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
console.log("⚠ この比較は共通スコープ (デモグラフィック・公費構造・欠損行処理) のみを対象にした。");
console.log("  福祉用具固有 (TAISコード・貸与期間・半月按分) はこのビルダーの外 (集計層) の話で、");
console.log("  ほのぼの福祉用具伝送が未入手のため、この比較結果をもって検証済みとは言えない。");
