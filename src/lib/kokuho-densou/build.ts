/**
 * 国保連伝送ファイル (介護給付費請求書・明細書情報) 生成
 *
 * 国保中央会「インタフェース仕様書 (サービス事業所編)」準拠。
 * 仕様書の抜粋は apps/kaigo-app/migrations/_if_svc.txt / _if_form2.txt に保存済み。
 *
 * ファイル構成 (伝送 = カンマ区切り可変長 CSV / Shift_JIS / CRLF):
 *   1 行目:   コントロールレコード (レコード種別 1)
 *   2 行目〜: データレコード       (レコード種別 2) — 7111 請求書 + 7131 明細書
 *   最終行:   エンドレコード       (レコード種別 3)
 *
 * 7131 (居宅サービス介護給付費明細書 = 様式第二) は利用者ごとに
 *   基本情報レコード (01) → 明細情報レコード (02) × n → 集計情報レコード (10)
 * の順で格納する。
 *
 * 注意: 空欄項目は空文字のまま出力する (可変長 CSV)。
 * Shift_JIS への変換は呼出側 (UI) で行う。
 */

import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

// ─── コード値 ────────────────────────────────────────────────────────────────
// 要介護状態区分コード (被保険者証記載の標準コード)
const CARE_LEVEL_CODE: Record<string, string> = {
  事業対象者: "06",
  要支援1: "12",
  要支援2: "13",
  要介護1: "21",
  要介護2: "22",
  要介護3: "23",
  要介護4: "24",
  要介護5: "25",
};

// ※ 以下 2 つは共通編コード一覧の値が未確認のため、伝送通信ソフトの
//    取込チェックで要検証 (エラー時はここを修正する)
const HOKEN_KOHI_KUBUN_HOKEN = "1"; // 保険・公費等区分コード: 保険請求分
const SEIKYU_JOHO_KUBUN = "01"; // 請求情報区分コード

export interface DensouBuildOptions {
  /** 請求事業所番号 (10 桁) */
  officeNumber: string;
  /** サービス提供年月 */
  year: number;
  month: number; // 1-12
  /** 地域区分単価 (円)。集計情報レコードの単位数単価 (×100 の 4 桁) に使用 */
  unitPrice: number;
}

export interface DensouBuildResult {
  /** ファイル内容 (CRLF 区切り。Shift_JIS 変換前の文字列) */
  content: string;
  /** 推奨ファイル名 (英字始まり 8 桁以内 + .CSV) */
  fileName: string;
  /** データレコード件数 */
  dataRecordCount: number;
  /** 取込前に確認が必要な事項 */
  warnings: string[];
}

const dateNum = (iso: string | null) => (iso ? iso.replaceAll("-", "") : "");

const genderCode = (g: string | null) =>
  g == null ? "" : g.includes("女") ? "2" : g.includes("男") ? "1" : "";

export function buildKokuhoDensou(
  rows: UserSeikyuRow[],
  opts: DensouBuildOptions,
): DensouBuildResult {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const office = (opts.officeNumber ?? "").trim();
  if (!/^\d{10}$/.test(office)) {
    warnings.push(
      `事業所番号が 10 桁の数字ではありません ("${office}") — 自事業所管理で正しい事業所番号を設定してください`,
    );
  }

  // データレコード (レコード種別/連番は後で付与するため、まず中身のみ組み立てる)
  const dataParts: string[][] = [];

  // ── 7111 介護給付費請求書情報 (保険請求分 1 レコード + 公費請求分) ──
  const totalCount = rows.length;
  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalCost = rows.reduce((s, r) => s + r.totalAmount, 0);
  const totalInsurance = rows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalKohi = rows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);
  dataParts.push([
    "7111", // 1 交換情報識別番号
    ym, // 2 サービス提供年月
    office, // 3 事業所番号
    HOKEN_KOHI_KUBUN_HOKEN, // 4 保険・公費等区分コード
    "0", // 5 法別番号 (保険者請求分は 0)
    SEIKYU_JOHO_KUBUN, // 6 請求情報区分コード
    String(totalCount), // 7 サービス費用 件数
    String(totalUnits), // 8 同 単位数
    String(totalCost), // 9 同 費用合計
    String(totalInsurance), // 10 同 保険請求額
    String(totalKohi), // 11 同 公費請求額
    String(totalUser), // 12 同 利用者負担
    "", // 13 特定入所者介護サービス費等 件数 (訪問介護は対象外)
    "", // 14 同 延べ日数
    "", // 15 同 費用合計
    "", // 16 同 利用者負担
    "", // 17 同 公費請求額
    "", // 18 同 保険請求額
  ]);

  // 公費請求分 (法別番号ごと。生活保護 12 等)
  const kohiRows = rows.filter((r) => r.kohiHobetsu && (r.kohiAmount ?? 0) > 0);
  const byHobetsu = new Map<string, UserSeikyuRow[]>();
  for (const r of kohiRows) {
    const h = r.kohiHobetsu as string;
    if (!byHobetsu.has(h)) byHobetsu.set(h, []);
    byHobetsu.get(h)!.push(r);
  }
  for (const [hobetsu, hRows] of byHobetsu) {
    dataParts.push([
      "7111",
      ym,
      office,
      "2", // 保険・公費等区分コード (公費請求分) ※要検証
      hobetsu, // 法別番号 (12=生活保護 等)
      SEIKYU_JOHO_KUBUN,
      String(hRows.length),
      String(hRows.reduce((s, r) => s + r.totalUnits, 0)),
      String(hRows.reduce((s, r) => s + r.totalAmount, 0)),
      String(hRows.reduce((s, r) => s + r.insuranceAmount, 0)),
      String(hRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0)),
      "0", // 利用者負担 (公費振替後は 0)
      "", "", "", "", "", "",
    ]);
  }

  // ── 7131 明細書 (利用者ごと: 基本 01 → 明細 02×n → 集計 10) ──
  for (const r of rows) {
    const insurer = (r.insurer_number ?? "").trim();
    const insured = (r.insured_number ?? "").trim();
    if (!insurer) warnings.push(`${r.user_name}: 保険者番号が未登録です`);
    if (!insured) warnings.push(`${r.user_name}: 被保険者番号が未登録です`);
    const careLevelCode = CARE_LEVEL_CODE[(r.care_level ?? "").trim()] ?? "";
    if (!careLevelCode) warnings.push(`${r.user_name}: 要介護度 ("${r.care_level ?? "未設定"}") をコードに変換できません`);
    if (!r.birthDate) warnings.push(`${r.user_name}: 生年月日が未登録です`);
    if (!r.careOfficeNumber) warnings.push(`${r.user_name}: 担当居宅介護支援事業所 (事業所番号) が未登録です`);

    const benefitRate = String(Math.round((1 - r.copay_rate) * 100)); // 90 等
    const hasKohi = !!(r.kohiHobetsu && (r.kohiAmount ?? 0) > 0);
    if (r.kohiHobetsu && !r.kohiFutanshaNumber) {
      warnings.push(`${r.user_name}: 公費 (法別${r.kohiHobetsu}) の負担者番号が未登録です`);
    }

    // 基本情報レコード (01) — 様式第二で使用しない施設系項目は空欄
    dataParts.push([
      "7131", // 1 交換情報識別番号
      "01", // 2 レコード種別コード
      ym, // 3 サービス提供年月
      office, // 4 事業所番号
      insurer, // 5 証記載保険者番号
      insured, // 6 被保険者番号
      hasKohi ? r.kohiFutanshaNumber ?? "" : "", // 7 公費1 負担者番号
      hasKohi ? r.kohiJukyushaNumber ?? "" : "", // 8 公費1 受給者番号
      "", // 9 公費2 負担者番号
      "", // 10 公費2 受給者番号
      "", // 11 公費3 負担者番号
      "", // 12 公費3 受給者番号
      dateNum(r.birthDate), // 13 生年月日
      genderCode(r.gender), // 14 性別コード
      careLevelCode, // 15 要介護状態区分コード
      "", // 16 旧措置入所者特例コード
      dateNum(r.certStart), // 17 認定有効期間 開始
      dateNum(r.certEnd), // 18 認定有効期間 終了
      "1", // 19 居宅サービス計画作成区分コード (1=居宅介護支援事業所作成)
      r.careOfficeNumber ?? "", // 20 事業所番号 (居宅介護支援事業所)
      "", // 21 開始年月日
      "", // 22 中止年月日
      "", // 23 中止理由・入所前状況
      "", // 24 入所年月日
      "", // 25 退所年月日
      "", // 26 入所実日数
      "", // 27 外泊日数
      "", // 28 退所後の状態
      benefitRate, // 29 保険給付率
      hasKohi ? "100" : "", // 30 公費1給付率 (生活保護等は 100)
      "", // 31 公費2給付率
      "", // 32 公費3給付率
      String(r.totalUnits), // 33 合計 保険 サービス単位数
      String(r.insuranceAmount), // 34 同 請求額
      String(r.userAmount), // 35 同 利用者負担額
      "", // 36 緊急時施設療養費請求額
      "", // 37 特定診療費請求額
      "", // 38 特定入所者介護サービス費等請求額
      // 39-44 公費1 合計情報 (サービス単位数 / 請求額 / 本人負担額 / 緊急時 / 特定診療 / 特定入所者)
      hasKohi ? String(r.totalUnits) : "",
      hasKohi ? String(r.kohiAmount ?? 0) : "",
      hasKohi ? "0" : "",
      "", "", "",
      "", "", "", "", "", "", // 45-50 公費2 合計情報
      "", "", "", "", "", "", // 51-56 公費3 合計情報
    ]);

    // 明細情報レコード (02) — サービスコードごと
    const detailLines: { code: string; unitPer: number; count: number; units: number }[] = [];
    for (const d of r.details) {
      if (!d.service_code) {
        warnings.push(`${r.user_name}: "${d.service_type}" のサービスコードがマスタから引けません`);
        continue;
      }
      detailLines.push({ code: d.service_code, unitPer: d.unit_per, count: d.count, units: d.units });
    }
    if (r.addonUnits > 0) {
      if (r.addonCode) {
        // 処遇改善等の月次加算: 単位数 = 加算単位数、回数 = 1
        detailLines.push({ code: r.addonCode, unitPer: r.addonUnits, count: 1, units: r.addonUnits });
      } else {
        warnings.push(`${r.user_name}: 加算 (${r.addonLabel ?? "処遇改善"}) のサービスコードが不明です`);
      }
    }
    for (const d of detailLines) {
      dataParts.push([
        "7131", // 1
        "02", // 2 レコード種別コード
        ym, // 3
        office, // 4
        insurer, // 5
        insured, // 6
        d.code.slice(0, 2), // 7 サービス種類コード
        d.code.slice(2, 6), // 8 サービス項目コード
        String(d.unitPer), // 9 単位数
        String(d.count), // 10 日数・回数
        hasKohi ? String(d.count) : "", // 11 公費1対象日数・回数
        "", // 12 公費2対象日数・回数
        "", // 13 公費3対象日数・回数
        String(d.units), // 14 サービス単位数
        hasKohi ? String(d.units) : "", // 15 公費1対象サービス単位数
        "", // 16 公費2対象サービス単位数
        "", // 17 公費3対象サービス単位数
        "", // 18 摘要
      ]);
    }

    // 集計情報レコード (10) — サービス種類 (訪問介護 = 11) 単位
    const svcKindCode = detailLines[0]?.code.slice(0, 2) ?? "11";
    dataParts.push([
      "7131", // 1
      "10", // 2 レコード種別コード
      ym, // 3
      office, // 4
      insurer, // 5
      insured, // 6
      svcKindCode, // 7 サービス種類コード
      String(r.serviceDays), // 8 サービス実日数
      String(r.baseUnits), // 9 計画単位数
      String(r.baseUnits), // 10 限度額管理対象単位数
      String(r.addonUnits), // 11 限度額管理対象外単位数 (処遇改善等は対象外)
      "", // 12 短期入所計画日数
      "", // 13 短期入所実日数
      String(r.totalUnits), // 14 保険 単位数合計
      String(Math.round(opts.unitPrice * 100)), // 15 単位数単価 (10.00円 → 1000)
      String(r.insuranceAmount), // 16 保険 請求額
      String(r.userAmount), // 17 利用者負担額
      // 18-20 公費1 (単位数合計 / 請求額 / 本人負担額)
      hasKohi ? String(r.totalUnits) : "",
      hasKohi ? String(r.kohiAmount ?? 0) : "",
      hasKohi ? "0" : "",
      "", "", "", // 21-23 公費2
      "", "", "", // 24-26 公費3
      "", "", "", // 27-29 保険分出来高医療費
      "", "", "", // 30-32 公費1分出来高医療費
      "", "", "", // 33-35 公費2分出来高医療費
      "", "", "", // 36-38 公費3分出来高医療費
    ]);
  }

  // ── レコード番号を付与してファイルを組む ──
  const lines: string[] = [];
  let recNo = 1;
  // コントロールレコード: 種別1, 連番, ボリューム通番0, データ件数, データ種別711,
  //   福祉事務所0, 保険者番号0, 事業所番号, 都道府県番号0, 媒体区分1(伝送), 処理対象年月, 管理番号1
  lines.push(
    ["1", String(recNo++), "0", String(dataParts.length), "711", "0", "0", office, "0", "1", ym, "1"].join(","),
  );
  for (const parts of dataParts) {
    lines.push(["2", String(recNo++), ...parts].join(","));
  }
  lines.push(["3", String(recNo++)].join(","));

  return {
    content: lines.join("\r\n") + "\r\n",
    fileName: `J${ym}.CSV`, // 英字始まり 8 桁以内 + .CSV
    dataRecordCount: dataParts.length,
    warnings,
  };
}
