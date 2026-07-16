/**
 * 国保連伝送ファイル (介護予防・日常生活支援総合事業費 請求書・明細書情報) 生成
 *
 * 介護給付 (build.ts の 7111/7131) とは別様式。
 * 国保中央会「インタフェース仕様書 (サービス事業所編 R5.4版)」の総合事業様式:
 *   - 請求書情報 = 交換情報識別番号 "7113" (介護予防・日常生活支援総合事業費請求書情報。
 *     12項目。_if_form2.txt 末尾「71R1/7113/種別14 抜粋」参照 = 仕様書全文 3483-3535行)
 *   - 明細書情報 = 交換情報識別番号 "71R1" (介護予防・日常生活支援総合事業費請求明細書情報
 *     = 様式第二の三。仕様書全文 2765-2780行 / 対応様式 3717-3718行)
 *   ※ "7112"/"71P1" (様式(予)) は「総合事業費（経過措置）」= みなし指定サービス
 *     (A1/A5 等) 用の別様式であり、独自サービス (A2 等) では使わない (2026-07-13 是正済。
 *     仕様書全文 2343-2358行 / 2750-2764行。旧実装は請求書・明細書とも 7112 を誤設定していた)。
 *
 * 様式第二の三 のレコード構成 (仕様書全文 3842-3923行 の様式対応表):
 *   基本情報 (01) ◎ / 明細情報 (02) ○※7 / 明細情報(住所地特例) (14) ○※7 /
 *   集計情報 (10) ◎ / 社会福祉法人軽減額 ○ (軽減がある場合のみ — 本実装は未出力)
 *   ※7 = 明細情報レコード、明細情報(住所地特例)レコードの「いずれか一方、又は両方」入力。
 *   基本/明細/集計 のレコードレイアウト自体は介護給付 (7131) と共通
 *   (仕様書全文 5846-6129行 / 6164-6259行 / 6873-7036行)。
 *
 * 住所地特例 (2026-07 実装):
 *   住所地特例対象者 (clients.jusho_tokurei) の明細行は 種別02 ではなく
 *   種別14 (明細情報(住所地特例)。全19項目) で出力する。
 *   項番1〜17・19 は明細02と同構成、項番18 = 施設所在保険者番号 (数字6桁)
 *   =「住所地特例対象者が入所（居）する施設の所在する市町村の証記載保険者番号」
 *   (利用者単位の属性。仕様書全文 6263-6331行)。
 *   施設所在保険者番号が未設定/6桁数字でない場合は warning を出して種別02 で出力する (安全側)。
 *
 * レコード構造:
 *   請求書 (7113) 保険請求分 1 レコード + 公費請求分 n
 *   明細書 (71R1) 利用者ごと: 基本情報 (01) → 明細情報 (02/14)×n → 集計情報 (10)
 *
 * ⚠ 要取込チェック (初回伝送時に伝送通信ソフトの取込チェックで要確認):
 *   - コントロールレコードのデータ種別 (711 → 総合事業は別値か)。本実装は "711" のまま。
 *   - 請求書 (7113) の請求情報区分コード。本実装は "01" (居宅サービス系) を踏襲。
 *   - 住所地特例対象者 (種別14) の単位数を集計情報 (10) にどう算入するか。
 *     本実装は種別02 と同様に全量算入 (仕様上 14 は「02 の住所地特例版」で同構成のため)。
 *
 * 限度額管理 (2026-07 正式化。aggregate-sougou.ts で超過分離済):
 *   集計 10 の 計画単位数 = 認定/標準の限度額 (limitUnits) フォールバック、
 *   限度額管理対象単位数 = 基準内の本体単位 (baseUnits)、
 *   対象外単位数 = 処遇改善等%加算 (kanriTaishougaiUnits)。7131 (build.ts) と同方針。
 *
 * Shift_JIS への変換は呼出側 (UI) で行う (build.ts と同じ)。
 */

import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";
import type { SougouSeikyuRow } from "@/lib/visit-seikyu/aggregate-sougou";
import type { DensouBuildOptions, DensouBuildResult } from "@/lib/kokuho-densou/build";

/** 総合事業の伝送行 = SougouSeikyuRow (住所地特例 optional 拡張込み) + 再請求時の元提供月 */
export type SougouDensouRow = SougouSeikyuRow & { ym?: string };

// ─── コード値 ────────────────────────────────────────────────────────────────
// 交換情報識別番号 (是正 2026-07-13: 旧実装の "7112" は経過措置=みなし用で誤り)
const KOKAN_ID_SEIKYUSHO = "7113"; // 総合事業費請求書情報 (12項目)
const KOKAN_ID_MEISAISHO = "71R1"; // 総合事業費請求明細書情報 (様式第二の三)

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
// 総合事業の請求情報区分コード = "05" (総合事業。ほのぼの正解伝送 KK260702 と一致。
// 介護給付の居宅サービス系 "01" とは別値。2026-07-16 是正)。
const SEIKYU_JOHO_KUBUN = "05";

const dateNum = (iso: string | null) => (iso ? iso.replaceAll("-", "") : "");
const genderCode = (g: string | null) =>
  g == null ? "" : g.includes("女") ? "2" : g.includes("男") ? "1" : "";

/**
 * 総合事業のサービスコード (CB_A21111 / MB_A21111 / IC_A31031 等) から、
 * 伝送用の サービス種類コード (2桁) + サービス項目コード (4桁) を取り出す。
 * 自治体プレフィックス (CB_/K_/IH_/MB_/IC_/CS_ 等、英大文字+_) を除去し、
 * 残り 6 桁 (A2 + 4桁) を分解する (伝送はprefix無しの公式コードで出す)。
 */
function splitSougouCode(
  code: string,
): { kind: string; item: string } | null {
  // "MB_A21111" → "A21111" / "IC_A31031" → "A31031" (任意の自治体prefixを除去)
  const stripped = code.replace(/^[A-Z]+_/, "");
  // 英字1 + 数字1 + 数字4 = 6 桁 (A2 + 1111)
  if (!/^[A-Z]\d{5}$/.test(stripped)) return null;
  return { kind: stripped.slice(0, 2), item: stripped.slice(2, 6) };
}

/**
 * 総合事業費 (明細書 71R1 / 請求書 7113) の伝送ファイルを生成する。
 * rows は system='総合事業' の SougouSeikyuRow (aggregateSougouSeikyu の出力)。
 */
export function buildSougouDensou(
  rows: SougouDensouRow[],
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
  // ⚠ 要取込チェック: 基本情報 (01) 項19 の区分値 (下記コメント参照)
  if (rows.some((r) => r.careOfficeNumber)) {
    warnings.push(
      "総合事業明細書 (71R1) の居宅サービス計画作成区分コード (基本01 項19) は「3=介護予防支援事業所・地域包括支援センター作成」で出力します — 居宅介護支援事業所への委託等で「1」が正しい場合があるため、初回は伝送ソフトの取込チェックで確認してください",
    );
  }

  const dataParts: string[][] = [];

  // ── 7113 総合事業費請求書情報 (保険請求分 1 レコード + 公費請求分) ──
  // 12項目構成 (7111 の18項目 = 特定入所者介護サービス費等 13-18 は 7113 に存在しない)。
  // 項番10 は 7113 では「事業費請求額」(7112 の「保険請求額」に相当する総合事業費の請求額)。
  const hokenRows = rows.filter((r) => !r.kohiTandoku);
  const totalCount = hokenRows.length;
  const totalUnits = hokenRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalCost = hokenRows.reduce((s, r) => s + r.totalAmount, 0);
  const totalInsurance = hokenRows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalKohi = hokenRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0);
  const totalUser = hokenRows.reduce((s, r) => s + r.userAmount, 0);
  dataParts.push([
    KOKAN_ID_SEIKYUSHO, // 1 交換情報識別番号 ("7113" 固定)
    ym, // 2 サービス提供年月
    office, // 3 事業所番号
    HOKEN_KOHI_KUBUN_HOKEN, // 4 保険・公費等区分コード (1:保険請求)
    "0", // 5 法別番号 (保険者請求分は 0)
    SEIKYU_JOHO_KUBUN, // 6 請求情報区分コード
    String(totalCount), // 7 サービス費用 件数
    String(totalUnits), // 8 同 単位数
    String(totalCost), // 9 同 費用合計
    String(totalInsurance), // 10 同 事業費請求額
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
      KOKAN_ID_SEIKYUSHO,
      ym,
      office,
      "2", // 保険・公費等区分コード (2:公費請求)
      hobetsu, // 法別番号
      SEIKYU_JOHO_KUBUN,
      String(hRows.length),
      String(hRows.reduce((s, r) => s + r.totalUnits, 0)),
      String(hRows.reduce((s, r) => s + r.totalAmount, 0)),
      "0", // 事業費請求額: 公費請求分では 0 (保険請求分レコードで計上済。二重計上防止・ほのぼの準拠)
      String(hRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0)),
      "0", // 利用者負担 (公費振替後は 0)
    ]);
  }

  // ── 71R1 様式第二の三 明細書 (利用者ごと: 基本 01 → 明細 02/14×n → 集計 10) ──
  for (const r of rows) {
    const rowYm = r.ym ?? ym;
    // 証記載保険者番号は数字8桁 (6桁の保険者は前0埋め) — IF仕様
    const insurerRaw = (r.insurer_number ?? "").trim();
    const insurer = insurerRaw ? insurerRaw.padStart(8, "0") : "";
    const insured = (r.insured_number ?? "").trim();
    if (!insurer) warnings.push(`${r.user_name}: 保険者番号が未登録です`);
    if (!insured) warnings.push(`${r.user_name}: 被保険者番号が未登録です`);
    const careLevelCode = CARE_LEVEL_CODE[(r.care_level ?? "").trim()] ?? "";
    if (!careLevelCode)
      warnings.push(`${r.user_name}: 要介護度 ("${r.care_level ?? "未設定"}") をコードに変換できません`);
    if (!r.birthDate) warnings.push(`${r.user_name}: 生年月日が未登録です`);
    if (!r.careOfficeNumber)
      warnings.push(`${r.user_name}: 担当居宅介護支援事業所 (事業所番号) が未登録です`);
    // 明細 02/14 レコードは実績全量、集計 10 の限度額管理対象単位数 (baseUnits) は
    // 基準内のみ — 超過分は保険請求から除外済 (aggregate-sougou.ts)。build.ts と同方針。
    if (r.overUnits > 0) {
      warnings.push(
        `${r.user_name}: 総合事業の限度額 (${(r.limitUnits ?? 0).toLocaleString()}単位) を ${r.overUnits.toLocaleString()} 単位超過しています — 超過分 (${r.overAmount.toLocaleString()}円) は保険請求に含めず全額自費 (利用請求) 扱いです`,
      );
    }

    // ── 住所地特例 (種別14) 判定 ──
    // フラグ true かつ施設所在保険者番号が数字6桁のときのみ種別14。
    // 番号が未設定/不正のときは種別02 で出力する (安全側 = 取込エラーを避ける)。
    const jushoInsurer = (r.jushoTokureiInsurerNumber ?? "").trim();
    let useJushoTokurei = false;
    if (r.jushoTokurei === true) {
      if (/^\d{6}$/.test(jushoInsurer)) {
        useJushoTokurei = true;
        warnings.push(
          `${r.user_name}: 住所地特例対象者のため明細を種別14 (明細情報(住所地特例)・施設所在保険者番号 ${jushoInsurer}) で出力します — 集計情報への算入方法は初回取込チェックで要確認`,
        );
      } else if (jushoInsurer) {
        warnings.push(
          `${r.user_name}: 住所地特例対象者ですが施設所在保険者番号 ("${jushoInsurer}") が数字6桁ではありません — 種別02で出力します。介護認定タブで修正してください`,
        );
      } else {
        warnings.push(
          `${r.user_name}: 住所地特例対象者ですが施設所在保険者番号が未設定です — 種別02で出力します`,
        );
      }
    }

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

    // 基本情報レコード (01) — 7131 の 01 と同構成 (仕様書全文 5846-6129行)。
    dataParts.push([
      KOKAN_ID_MEISAISHO, // 1 交換情報識別番号 ("71R1")
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
      // 19 居宅サービス計画作成区分コード。総合事業 (介護予防ケアマネジメント) は
      //    「3=介護予防支援事業所・地域包括支援センター作成」が本則
      //    (r5_full.txt L5925-5942: 項20 は項19が「居宅介護支援事業所作成」又は
      //    「介護予防支援事業所・地域包括支援センター作成」のとき必須 — 区分値として
      //    包括作成が存在する。手元のコード一覧抜粋 _if_kyotaku.txt L14299-14301 は
      //    1:居宅介護支援事業所作成 / 2:自己作成 のみ記載の旧版のため値 3 は取込チェックで要確認)。
      //    careOfficeNumber 未解決で "1"/"3" 固定にすると項20空欄=必須欠落で返戻するため、
      //    番号が無ければ "2" (自己作成) で出す (build.ts:269-273 の 7131 と同ロジック)。
      r.careOfficeNumber ? "3" : "2", // 19
      r.careOfficeNumber ?? "", // 20 事業所番号 (居宅介護支援事業所。区分2のときは空)
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

    // 明細情報レコード (02 / 住所地特例は 14) — サービスコードごと。
    // 総合事業のサービスコードは CB_ / K_ プレフィックス付きなので、
    // splitSougouCode で サービス種類 (A2) + 項目 (4桁) に分解する。
    const detailLines: { kind: string; item: string; unitPer: number; count: number; units: number; isMonthly: boolean }[] = [];
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
      detailLines.push({ kind: parts.kind, item: parts.item, unitPer: d.unit_per, count: d.count, units: d.units, isMonthly: d.is_monthly === true });
    }
    // 処遇改善等の%加算 (addonCode) を 1 行追加。処遇改善は月額扱い (項9 単位数=0)。
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
            isMonthly: true,
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
      // 項10 日数・回数 / 項11 公費1対象日数・回数 は「数字2桁」(_if_form2.txt L7666-7669) —
      // 100 回以上は桁溢れで取込エラー/切り捨ての恐れがあるため warning で明示する
      if (d.count > 99) {
        warnings.push(
          `${r.user_name}: 総合事業コード ${d.kind}${d.item} の回数 (${d.count}) が明細行の日数・回数欄 (数字2桁 = 上限99) を超えています — 取込エラーの可能性があるため実績を確認してください`,
        );
      }
      // 項番1〜17 は 02/14 で同構成。14 のみ 項18=施設所在保険者番号 が挟まり摘要は項19。
      const common = [
        KOKAN_ID_MEISAISHO, // 1 交換情報識別番号 ("71R1")
        useJushoTokurei ? "14" : "02", // 2 レコード種別コード
        rowYm, // 3 サービス提供年月
        office, // 4 事業所番号
        insurer, // 5 証記載保険者番号
        insured, // 6 被保険者番号
        d.kind, // 7 サービス種類コード (A2 等)
        d.item, // 8 サービス項目コード (4桁)
        // 9 単位数: ほのぼの正解伝送は 定率(1回/1日につき) は単位数、月額包括(1月につき)と
        //   処遇改善は 0 で出す (単価はサービス単位数=項14 で表現)。判定は unit_type ベース。
        //   ※ kind(A2/A3)基準は誤り: 千葉市の A22511/A22621 は A2 だが定率(179×回)で単位数を出す。
        d.isMonthly ? "0" : String(d.unitPer), // 9 単位数
        String(d.count), // 10 日数・回数
        hasKohi ? String(d.count) : "", // 11 公費1対象日数・回数
        "", // 12 公費2対象日数・回数
        "", // 13 公費3対象日数・回数
        String(d.units), // 14 サービス単位数
        hasKohi ? String(d.units) : "", // 15 公費1対象サービス単位数
        "", // 16 公費2対象サービス単位数
        "", // 17 公費3対象サービス単位数
      ];
      dataParts.push(
        useJushoTokurei
          ? [...common, jushoInsurer, ""] // 18 施設所在保険者番号 (数字6桁) / 19 摘要
          : [...common, ""], // 18 摘要
      );
    }

    // 集計情報レコード (10) — サービス種類 (A2) 単位。
    // 限度額管理 (2026-07 正式化): 管理対象 = 基準内の本体単位 (baseUnits。超過分は
    // aggregate-sougou.ts で保険請求から除外済)、対象外 = 処遇改善等%加算。
    // 計画単位数は build.ts (7131) と同じフォールバック (計画 > 限度額 > 基準内)。
    // ⚠ 要取込チェック: 総合事業の集計 10 の計画/管理対象/対象外の扱いを取込テストで確認。
    //   住所地特例 (種別14) 分も 02 と同様に全量算入している (仕様上 14 は 02 の住所地特例版)。
    const svcKindCode = detailLines[0]?.kind ?? "A2";
    const kanriGaiUnits = r.kanriTaishougaiUnits; // = addonUnits (処遇改善%加算 = 管理対象外)
    const kanriInUnits = r.baseUnits; // 基準内の本体単位 = 限度額管理対象
    dataParts.push([
      KOKAN_ID_MEISAISHO, // 1 交換情報識別番号 ("71R1")
      "10", // 2 レコード種別コード
      rowYm, // 3 サービス提供年月
      office, // 4
      insurer, // 5
      insured, // 6
      svcKindCode, // 7 サービス種類コード (A2)
      String(r.serviceDays), // 8 サービス実日数
      // 9 計画単位数: ほのぼの正解伝送は「限度額管理対象単位数(基準内)」と同値を出す
      //   (区分支給限度額そのものではない)。計画(給付管理)がある場合のみそれを優先。
      //   限度額(limitUnits)へのフォールバックは誤り(要支援1=5032等が出てしまう)なので外す。
      String(r.planUnits ?? kanriInUnits),
      String(kanriInUnits), // 10 限度額管理対象単位数 (基準内)
      String(kanriGaiUnits), // 11 限度額管理対象外単位数 (処遇改善%加算)
      "", // 12 短期入所計画日数
      "", // 13 短期入所実日数
      String(r.totalUnits), // 14 保険 単位数合計
      String(Math.round(r.unitPrice * 100)), // 15 単位数単価 (利用者の保険者=市町村別。aggregate-sougouで解決)
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
  // コントロールレコード: build.ts (7131) と同構成。データ種別は総合事業=「71R」
  // (ほのぼの正解伝送 KK260702 と一致。介護給付の "711" とは別値。2026-07-16 是正)。
  lines.push(
    ["1", String(recNo++), "0", String(dataParts.length), "71R", "0", "0", office, "0", "1", shinsaYm, "1"].join(","),
  );
  for (const parts of dataParts) {
    lines.push(["2", String(recNo++), ...parts].join(","));
  }
  lines.push(["3", String(recNo++)].join(","));

  return {
    content: lines.join("\r\n") + "\r\n",
    // ファイル名: 英字始まり半角英数字8桁以内 + .CSV (_if_kyotaku.txt L11282。同一月の
    // 交換情報は同一ファイル名を使わず送付元で識別できる名称とする — 同 L13460-13463)。
    // 旧 `S{YYYYMM}` は build-kyotaku.ts の計画費請求ファイルと衝突するため
    // 総合事業は `SG` 始まり (SG+YYYYMM = 8文字。介護給付は J、給付管理は K、計画費は S)
    fileName: `SG${ym}.CSV`,
    dataRecordCount: dataParts.length,
    warnings,
  };
}
