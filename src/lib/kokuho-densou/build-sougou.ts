/**
 * 国保連伝送ファイル (介護予防・日常生活支援総合事業費 請求書・明細書情報) 生成
 *
 * 介護給付費 (build.ts の 7111/7131) とは別様式。
 * 国保中央会「インタフェース仕様書」の総合事業様式:
 *   - 請求書情報   = 交換情報識別番号 "7112" (仕様書 _if_form2.txt 287-429行)
 *   - 明細書情報   = 様式(予) 介護予防・日常生活支援総合事業費請求明細書
 *                    (_if_form2.txt 3487-3670行)。交換情報識別番号 "7112"。
 *
 * レコード構造は 7131 (build.ts) とほぼ同一:
 *   請求書 (7112) 保険請求分 1 レコード + 公費請求分 n
 *   明細書 (7112) 利用者ごと: 基本情報 (01) → 明細情報 (02)×n → 集計情報 (10)
 * 差分は 交換情報識別番号 (7112) と サービス種類コード (A2 等 = 総合事業の英字始まりコード)。
 *
 * ⚠ 要取込チェック (初回伝送時に伝送通信ソフトの取込チェックで要確認):
 *   - 交換情報識別番号 7112 / 様式(予) の項目構成が 7131 と完全一致か
 *     (本実装は 7131 の項目順を流用。仕様書上は基本/明細/集計とも 7131 と同構成)
 *   - サービス種類コード = 英字 "A2" の 2 桁でよいか (数字前提の欄に英字を出す)
 *   - コントロールレコードのデータ種別 (711 → 総合事業は別値か)。本実装は "711" のまま。
 *   - 限度額管理: 総合事業は要支援枠。集計 10 の計画/管理対象/対象外は暫定で全量を管理対象とする。
 *
 * Shift_JIS への変換は呼出側 (UI) で行う (build.ts と同じ)。
 */

import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import type { DensouRow, DensouBuildOptions, DensouBuildResult } from "@/lib/kokuho-densou/build";

// ─── コード値 ────────────────────────────────────────────────────────────────
// 要介護状態区分コード (総合事業は要支援・事業対象者が中心)
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

const HOKEN_KOHI_KUBUN_HOKEN = "1"; // 保険・公費等区分コード: 保険請求分
// 総合事業の請求情報区分コード。様式(予) は "01" (居宅サービス系) を踏襲。
// ⚠ 要取込チェック: 総合事業専用の区分値がある場合は差し替える。
const SEIKYU_JOHO_KUBUN = "01";

const dateNum = (iso: string | null) => (iso ? iso.replaceAll("-", "") : "");
const genderCode = (g: string | null) =>
  g == null ? "" : g.includes("女") ? "2" : g.includes("男") ? "1" : "";

/**
 * 総合事業のサービスコード (CB_A21111 / K_A26184 等) から、
 * 伝送用の サービス種類コード (2桁) + サービス項目コード (4桁) を取り出す。
 * 保険者プレフィックス (CB_ / K_) を除去し、残り 6 桁 (A2 + 4桁) を分解する。
 */
function splitSougouCode(
  code: string,
): { kind: string; item: string } | null {
  // "CB_A21111" → "A21111" / "K_A26184" → "A26184"
  const stripped = code.replace(/^(CB_|K_)/, "");
  // 英字1 + 数字1 + 数字4 = 6 桁 (A2 + 1111)
  if (!/^[A-Z]\d{5}$/.test(stripped)) return null;
  return { kind: stripped.slice(0, 2), item: stripped.slice(2, 6) };
}

/**
 * 総合事業費 (7112) の伝送ファイルを生成する。
 * rows は system='総合事業' の UserSeikyuRow (aggregateSougouSeikyu の出力)。
 */
export function buildSougouDensou(
  rows: DensouRow[],
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

  const dataParts: string[][] = [];

  // ── 7112 総合事業費請求書情報 (保険請求分 1 レコード + 公費請求分) ──
  const hokenRows = rows.filter((r) => !r.kohiTandoku);
  const totalCount = hokenRows.length;
  const totalUnits = hokenRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalCost = hokenRows.reduce((s, r) => s + r.totalAmount, 0);
  const totalInsurance = hokenRows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalKohi = hokenRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0);
  const totalUser = hokenRows.reduce((s, r) => s + r.userAmount, 0);
  dataParts.push([
    "7112", // 1 交換情報識別番号 (総合事業費請求書)
    ym, // 2 サービス提供年月
    office, // 3 事業所番号
    HOKEN_KOHI_KUBUN_HOKEN, // 4 保険・公費等区分コード (1:保険請求 固定)
    "0", // 5 法別番号 (保険者請求分は 0)
    SEIKYU_JOHO_KUBUN, // 6 請求情報区分コード
    String(totalCount), // 7 サービス費用 件数
    String(totalUnits), // 8 同 単位数
    String(totalCost), // 9 同 費用合計
    String(totalInsurance), // 10 同 保険請求額
    String(totalKohi), // 11 同 公費請求額
    String(totalUser), // 12 同 利用者負担
  ]);

  // 公費請求分 (法別番号ごと)
  const kohiRows = rows.filter(
    (r) => (r.kohiHobetsu || r.kohiTandoku) && (r.kohiAmount ?? 0) > 0,
  );
  const byHobetsu = new Map<string, UserSeikyuRow[]>();
  for (const r of kohiRows) {
    const h = r.kohiHobetsu ?? "12";
    if (!byHobetsu.has(h)) byHobetsu.set(h, []);
    byHobetsu.get(h)!.push(r);
  }
  for (const [hobetsu, hRows] of byHobetsu) {
    dataParts.push([
      "7112",
      ym,
      office,
      "2", // 保険・公費等区分コード (2:公費請求)
      hobetsu, // 法別番号
      SEIKYU_JOHO_KUBUN,
      String(hRows.length),
      String(hRows.reduce((s, r) => s + r.totalUnits, 0)),
      String(hRows.reduce((s, r) => s + r.totalAmount, 0)),
      String(hRows.reduce((s, r) => s + r.insuranceAmount, 0)),
      String(hRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0)),
      "0", // 利用者負担 (公費振替後は 0)
    ]);
  }

  // ── 7112 様式(予) 明細書 (利用者ごと: 基本 01 → 明細 02×n → 集計 10) ──
  for (const r of rows) {
    const rowYm = r.ym ?? ym;
    const insurer = (r.insurer_number ?? "").trim();
    const insured = (r.insured_number ?? "").trim();
    if (!insurer) warnings.push(`${r.user_name}: 保険者番号が未登録です`);
    if (!insured) warnings.push(`${r.user_name}: 被保険者番号が未登録です`);
    const careLevelCode = CARE_LEVEL_CODE[(r.care_level ?? "").trim()] ?? "";
    if (!careLevelCode)
      warnings.push(`${r.user_name}: 要介護度 ("${r.care_level ?? "未設定"}") をコードに変換できません`);
    if (!r.birthDate) warnings.push(`${r.user_name}: 生年月日が未登録です`);
    if (!r.careOfficeNumber)
      warnings.push(`${r.user_name}: 担当居宅介護支援事業所 (事業所番号) が未登録です`);

    const benefitRate = r.kohiTandoku
      ? ""
      : String((10 - Math.round(r.copay_rate * 10)) * 10); // 90 等
    const hasKohi = r.kohiTandoku || !!(r.kohiHobetsu && (r.kohiAmount ?? 0) > 0);
    if (r.kohiTandoku && !r.kohiHobetsu) {
      warnings.push(
        `${r.user_name}: 公費単独 (被保険者番号 H) なのに公費情報 (法別番号) が未登録です`,
      );
    }
    if (hasKohi && !r.kohiFutanshaNumber) {
      warnings.push(`${r.user_name}: 公費 (法別${r.kohiHobetsu ?? "12"}) の負担者番号が未登録です`);
    }

    // 基本情報レコード (01) — 様式(予)。7131 の 01 と同構成。
    dataParts.push([
      "7112", // 1 交換情報識別番号
      "01", // 2 レコード種別コード
      rowYm, // 3 サービス提供年月
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
      benefitRate, // 29 保険給付率 (公費単独は空欄)
      hasKohi ? "100" : "", // 30 公費1給付率
      "", // 31 公費2給付率
      "", // 32 公費3給付率
      String(r.totalUnits), // 33 合計 保険 サービス単位数
      String(r.insuranceAmount), // 34 同 請求額
      String(r.userAmount), // 35 同 利用者負担額
      "", // 36 緊急時施設療養費請求額
      "", // 37 特定診療費請求額
      "", // 38 特定入所者介護サービス費等請求額
      // 39-44 公費1 合計情報
      hasKohi ? String(r.totalUnits) : "",
      hasKohi ? String(r.kohiAmount ?? 0) : "",
      hasKohi ? "0" : "",
      "", "", "",
      "", "", "", "", "", "", // 45-50 公費2 合計情報
      "", "", "", "", "", "", // 51-56 公費3 合計情報
    ]);

    // 明細情報レコード (02) — サービスコードごと。
    // 総合事業のサービスコードは CB_ / K_ プレフィックス付きなので、
    // splitSougouCode で サービス種類 (A2) + 項目 (4桁) に分解する。
    const detailLines: { kind: string; item: string; unitPer: number; count: number; units: number }[] = [];
    for (const d of r.details) {
      if (!d.service_code) {
        warnings.push(`${r.user_name}: "${d.service_type}" のサービスコードがマスタから引けません`);
        continue;
      }
      const parts = splitSougouCode(d.service_code);
      if (!parts) {
        warnings.push(
          `${r.user_name}: 総合事業コード "${d.service_code}" を種類/項目に分解できません (要取込チェック)`,
        );
        continue;
      }
      detailLines.push({ kind: parts.kind, item: parts.item, unitPer: d.unit_per, count: d.count, units: d.units });
    }
    // 処遇改善等の%加算 (addonCode) を 1 行追加
    if (r.addonUnits > 0) {
      if (r.addonCode) {
        const parts = splitSougouCode(r.addonCode);
        if (parts) {
          detailLines.push({
            kind: parts.kind,
            item: parts.item,
            unitPer: r.addonUnits,
            count: 1,
            units: r.addonUnits,
          });
        } else {
          warnings.push(
            `${r.user_name}: 総合事業 処遇改善コード "${r.addonCode}" を分解できません (要取込チェック)`,
          );
        }
      } else {
        warnings.push(`${r.user_name}: 総合事業 加算 (${r.addonLabel ?? "処遇改善"}) のサービスコードが不明です`);
      }
    }
    for (const d of detailLines) {
      dataParts.push([
        "7112", // 1
        "02", // 2 レコード種別コード
        rowYm, // 3 サービス提供年月
        office, // 4
        insurer, // 5
        insured, // 6
        d.kind, // 7 サービス種類コード (A2 等)
        d.item, // 8 サービス項目コード (4桁)
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

    // 集計情報レコード (10) — サービス種類 (A2) 単位。
    // 総合事業は要支援枠で当面 限度額超過管理をしないため、計画=管理対象=保険単位数、
    // 管理対象外=処遇改善%加算 (kanriTaishougaiUnits = addonUnits) とする。
    // ⚠ 要取込チェック: 総合事業の集計 10 の計画/管理対象/対象外の扱いを取込テストで確認。
    const svcKindCode = detailLines[0]?.kind ?? "A2";
    const kanriGaiUnits = r.kanriTaishougaiUnits; // = addonUnits (総合事業は超過管理なし)
    const kanriInUnits = r.baseUnits; // 本体単位 = 管理対象
    dataParts.push([
      "7112", // 1
      "10", // 2 レコード種別コード
      rowYm, // 3 サービス提供年月
      office, // 4
      insurer, // 5
      insured, // 6
      svcKindCode, // 7 サービス種類コード (A2)
      String(r.serviceDays), // 8 サービス実日数
      String(kanriInUnits), // 9 計画単位数 (= 管理対象。総合事業は超過管理なし)
      String(kanriInUnits), // 10 限度額管理対象単位数
      String(kanriGaiUnits), // 11 限度額管理対象外単位数 (処遇改善%加算)
      "", // 12 短期入所計画日数
      "", // 13 短期入所実日数
      String(r.totalUnits), // 14 保険 単位数合計
      String(Math.round(opts.unitPrice * 100)), // 15 単位数単価
      String(r.insuranceAmount), // 16 保険 請求額
      String(r.userAmount), // 17 利用者負担額
      // 18-20 公費1
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
  const sy = opts.seikyuYear ?? opts.year;
  const sm = opts.seikyuMonth ?? opts.month;
  const shinsaYm =
    sm === 12 ? `${sy + 1}01` : `${sy}${String(sm + 1).padStart(2, "0")}`;
  // コントロールレコード: build.ts (7131) と同構成。データ種別は "711" を踏襲。
  // ⚠ 要取込チェック: 総合事業のデータ種別コードが介護給付と別値なら差し替える。
  lines.push(
    ["1", String(recNo++), "0", String(dataParts.length), "711", "0", "0", office, "0", "1", shinsaYm, "1"].join(","),
  );
  for (const parts of dataParts) {
    lines.push(["2", String(recNo++), ...parts].join(","));
  }
  lines.push(["3", String(recNo++)].join(","));

  return {
    content: lines.join("\r\n") + "\r\n",
    fileName: `S${ym}.CSV`, // 総合事業 = S 始まり (介護給付は J 始まり)
    dataRecordCount: dataParts.length,
    warnings,
  };
}
