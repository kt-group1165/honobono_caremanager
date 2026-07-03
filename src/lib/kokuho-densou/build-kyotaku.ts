/**
 * 国保連伝送ファイル: 居宅介護支援事業所分 (給付管理票 + 居宅介護支援費請求)
 *
 * インタフェース仕様書 (居宅介護支援事業所編) 準拠。抜粋は
 * apps/kaigo-app/migrations/_if_kyotaku.txt に保存済み。
 *
 * ファイル 1: 給付管理票 (データ種別 821)
 *   8211 給付管理票総括票情報 (17 項目) × 1
 *   8221 給付管理票情報 (24 項目) — 利用者ごとに 明細行 01〜98 + 終端行 99
 * ファイル 2: 居宅介護支援費請求 (データ種別 711)
 *   7111 介護給付費請求書情報 (18 項目) × 1
 *   8121 介護給付費請求明細書 (居宅サービス計画費) 情報 (18 項目) × 利用者
 *
 * コントロール/データ/エンドレコードの枠組み・Shift_JIS 出力は
 * build.ts (サービス事業所分) と共通。
 */

// 要介護状態区分コード (被保険者証記載の標準コード)
export const CARE_LEVEL_CODE: Record<string, string> = {
  事業対象者: "06",
  要支援1: "12",
  要支援2: "13",
  要介護1: "21",
  要介護2: "22",
  要介護3: "23",
  要介護4: "24",
  要介護5: "25",
};

// サービス種類コード (名称 → 2 桁)
export const SERVICE_KIND_CODE: Record<string, string> = {
  訪問介護: "11",
  訪問入浴介護: "12",
  訪問看護: "13",
  訪問リハビリテーション: "14",
  訪問リハ: "14",
  通所介護: "15",
  通所リハビリテーション: "16",
  通所リハ: "16",
  福祉用具貸与: "17",
  短期入所生活介護: "21",
  居宅療養管理指導: "31",
  定期巡回・随時対応型訪問介護看護: "32",
  夜間対応型訪問介護: "33",
  認知症対応型通所介護: "36",
  小規模多機能型居宅介護: "37",
};

const genderCode = (g: string | null | undefined) =>
  g == null ? "" : g.includes("女") ? "2" : g.includes("男") ? "1" : "";
const dateNum = (iso: string | null | undefined) => (iso ? iso.replaceAll("-", "") : "");
const ymNum = (iso: string | null | undefined) => (iso ? iso.replaceAll("-", "").slice(0, 6) : "");

export interface KyufuKanriLine {
  /** サービス事業所番号 (10 桁) */
  officeNumber: string;
  /** サービス種類コード (2 桁) */
  serviceKindCode: string;
  /** 給付計画単位数 */
  plannedUnits: number;
}

export interface KyufuKanriUser {
  userName: string;
  insurerNumber: string;
  insuredNumber: string;
  birthDate: string | null;
  gender: string | null;
  careLevel: string | null;
  /** 限度額適用期間 (認定有効期間で代用可) */
  limitStart: string | null;
  limitEnd: string | null;
  /** 区分支給限度基準額 (単位) */
  limitUnits: number;
  lines: KyufuKanriLine[];
}

export interface KyotakuDensouOptions {
  /** 居宅介護支援事業所番号 (10 桁) */
  officeNumber: string;
  /** サービス提供 (対象) 年月 */
  year: number;
  month: number;
  /** 地域区分単価 (円) — 計画費の請求金額計算用 */
  unitPrice: number;
}

interface BuildResult {
  content: string;
  fileName: string;
  dataRecordCount: number;
  warnings: string[];
}

function assemble(dataParts: string[][], dataKind: string, office: string, ym: string, fileName: string): Omit<BuildResult, "warnings"> {
  const lines: string[] = [];
  let recNo = 1;
  lines.push(
    ["1", String(recNo++), "0", String(dataParts.length), dataKind, "0", "0", office, "0", "1", ym, "1"].join(","),
  );
  for (const parts of dataParts) lines.push(["2", String(recNo++), ...parts].join(","));
  lines.push(["3", String(recNo++)].join(","));
  return { content: lines.join("\r\n") + "\r\n", fileName, dataRecordCount: dataParts.length };
}

/** ファイル 1: 給付管理票 (8211 + 8221) */
export function buildKyufuKanriFile(
  users: KyufuKanriUser[],
  opts: KyotakuDensouOptions,
): BuildResult {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const office = (opts.officeNumber ?? "").trim();
  if (!/^\d{10}$/.test(office)) warnings.push(`居宅介護支援事業所番号が 10 桁ではありません ("${office}")`);
  const today = new Date();
  const todayNum = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  // 提出年月 = サービス対象月の翌月
  const submitDate = new Date(opts.year, opts.month, 1);
  const submitYm = `${submitDate.getFullYear()}${String(submitDate.getMonth() + 1).padStart(2, "0")}`;

  const dataParts: string[][] = [];

  // 8211 総括票 (自県分 新規のみの前提)
  dataParts.push([
    "8211", // 1 交換情報識別番号
    submitYm, // 2 提出年月
    "0", // 3 保険者番号 ("0" 固定)
    office, // 4 事業所番号 (居宅介護支援事業所)
    "1", // 5 居宅サービス計画作成区分コード (1=居宅介護支援事業所作成)
    "0", "0", "0", "0", "0", "0", // 6-11 他県分 (訪問通所・居宅/短期入所 × 新規/修正/取消)
    String(users.length), "0", "0", // 12-14 自県分 訪問通所・居宅 新規/修正/取消
    "0", "0", "0", // 15-17 自県分 短期入所 新規/修正/取消
  ]);

  for (const u of users) {
    const careCode = CARE_LEVEL_CODE[(u.careLevel ?? "").trim()] ?? "";
    if (!u.insurerNumber) warnings.push(`${u.userName}: 保険者番号が未登録です`);
    if (!u.insuredNumber) warnings.push(`${u.userName}: 被保険者番号が未登録です`);
    if (!careCode) warnings.push(`${u.userName}: 要介護度 ("${u.careLevel ?? "未設定"}") をコードに変換できません`);
    if (!u.birthDate) warnings.push(`${u.userName}: 生年月日が未登録です`);
    if (u.limitUnits <= 0) warnings.push(`${u.userName}: 区分支給限度基準額が未登録です`);

    const head = (lineNo: string) => [
      "8221", // 1
      ym, // 2 対象年月
      u.insurerNumber, // 3 証記載保険者番号
      office, // 4 事業所番号 (居宅介護支援事業所)
      "1", // 5 給付管理票情報作成区分コード (1=新規)
      todayNum, // 6 給付管理票作成年月日
      "3", // 7 給付管理票種別区分コード (3=居宅サービス給付管理票)
      lineNo, // 8 給付管理票明細行番号
      u.insuredNumber, // 9 被保険者番号
      dateNum(u.birthDate), // 10 被保険者生年月日
      genderCode(u.gender), // 11 性別コード
      careCode, // 12 要介護状態区分コード
      ymNum(u.limitStart), // 13 限度額適用期間 (開始)
      ymNum(u.limitEnd), // 14 限度額適用期間 (終了)
    ];

    // 明細行 (01〜98)
    let total = 0;
    u.lines.forEach((l, i) => {
      if (!l.officeNumber) warnings.push(`${u.userName}: サービス事業所番号が未設定の行があります`);
      total += l.plannedUnits;
      dataParts.push([
        ...head(String(i + 1).padStart(2, "0")),
        "", // 15 訪問通所/短期入所支給限度額 (明細行は未設定)
        "1", // 16 居宅サービス計画作成区分コード
        l.officeNumber, // 17 事業所番号 (サービス事業所)
        "1", // 18 指定/基準該当等事業所区分コード (1=指定)
        l.serviceKindCode, // 19 サービス種類コード
        String(l.plannedUnits), // 20 給付計画単位数
        "", // 21 前月までの給付計画日数 (短期入所のみ)
        "", "", "", // 22-24 (明細行は未設定)
      ]);
    });

    // 終端行 (99)
    dataParts.push([
      ...head("99"),
      String(u.limitUnits), // 15 支給限度額 (単位)
      "1", // 16 居宅サービス計画作成区分コード
      "", // 17 事業所番号 (終端行は未設定)
      "", // 18
      "", // 19
      "", // 20
      "", // 21
      String(total), // 22 指定サービス分小計
      "0", // 23 基準該当サービス分小計
      String(total), // 24 給付計画合計単位数
    ]);
  }

  return { ...assemble(dataParts, "821", office, ym, `K${ym}.CSV`), warnings };
}

export interface KeikakuhiUser {
  userName: string;
  insurerNumber: string;
  insuredNumber: string;
  birthDate: string | null;
  gender: string | null;
  careLevel: string | null;
  certStart: string | null; // 認定有効期間 (YYYY-MM-DD)
  certEnd: string | null;
  /** 居宅サービス計画作成依頼届出年月日 (無ければ認定開始日で代用) */
  requestDate: string | null;
  /** 居宅介護支援費のサービスコード (6 桁) と単位数 (年度別マスタから) */
  serviceCode: string;
  units: number;
}

/** ファイル 2: 居宅介護支援費請求 (7111 + 8121) */
export function buildKeikakuhiFile(
  users: KeikakuhiUser[],
  opts: KyotakuDensouOptions,
): BuildResult {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const office = (opts.officeNumber ?? "").trim();
  if (!/^\d{10}$/.test(office)) warnings.push(`居宅介護支援事業所番号が 10 桁ではありません ("${office}")`);
  const unitPrice100 = Math.round(opts.unitPrice * 100); // 単位数単価 (10.84円 → 1084)

  const dataParts: string[][] = [];

  const totalUnits = users.reduce((s, u) => s + u.units, 0);
  // 計画費は 10 割給付 (利用者負担なし)
  const amounts = users.map((u) => Math.floor((u.units * unitPrice100) / 100));
  const totalAmount = amounts.reduce((s, a) => s + a, 0);

  // 7111 請求書情報
  dataParts.push([
    "7111",
    ym,
    office,
    "1", // 保険・公費等区分コード (1:保険請求。共通編1.4 項番79)
    "0", // 法別番号 (保険請求分は0)
    "02", // 請求情報区分コード (02:居宅介護支援・介護予防支援。共通編1.4 項番80)
    String(users.length), // 件数
    String(totalUnits), // 単位数
    String(totalAmount), // 費用合計
    String(totalAmount), // 保険請求額 (10 割)
    "0", // 公費請求額
    "0", // 利用者負担
    "", "", "", "", "", "", // 特定入所者 (対象外)
  ]);

  for (const u of users) {
    const careCode = CARE_LEVEL_CODE[(u.careLevel ?? "").trim()] ?? "";
    if (!careCode) warnings.push(`${u.userName}: 要介護度 ("${u.careLevel ?? "未設定"}") をコードに変換できません`);
    if (!u.serviceCode) warnings.push(`${u.userName}: 居宅介護支援費のサービスコードが年度別単位数マスタにありません`);
    if (!u.requestDate) warnings.push(`${u.userName}: 計画作成依頼届出年月日が無いため認定開始日で代用しました`);
    dataParts.push([
      "8121", // 1
      office, // 2 事業所番号
      "1", // 3 指定/基準該当等事業所区分コード
      ym, // 4 サービス提供年月
      u.insurerNumber, // 5 証記載保険者番号
      String(unitPrice100), // 6 単位数単価
      u.insuredNumber, // 7 被保険者番号
      "", // 8 公費負担者番号 (生保単独時のみ)
      "", // 9 公費受給者番号
      dateNum(u.birthDate), // 10 被保険者生年月日
      genderCode(u.gender), // 11 性別コード
      careCode, // 12 要介護状態区分コード
      dateNum(u.certStart), // 13 認定有効期間 (開始)
      dateNum(u.certEnd), // 14 認定有効期間 (終了)
      dateNum(u.requestDate ?? u.certStart), // 15 計画作成依頼届出年月日
      u.serviceCode, // 16 サービスコード
      String(u.units), // 17 単位数
      String(Math.floor((u.units * unitPrice100) / 100)), // 18 請求金額
    ]);
  }

  return { ...assemble(dataParts, "711", office, ym, `S${ym}.CSV`), warnings };
}
