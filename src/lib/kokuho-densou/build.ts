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
import { compareByInsurer, formatRecordLikeHonobono } from "@/lib/kokuho-densou/honobono-format";
import { insurerNumberWarning } from "@/lib/insurer-number";

/**
 * 伝送用の 1 行。月遅れ・返戻の再請求では利用者ごとに
 * サービス提供年月 (元提供月) が当月と異なるため、行に ym (YYYYMM) を
 * 持たせられるようにした。ym が無い行は opts.year/month を使う (後方互換)。
 */
export type DensouRow = UserSeikyuRow & { ym?: string };

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

// 共通編 1.4 コード一覧 (項番79/80) で検証済:
//   保険・公費等区分コード 1=保険請求 / 2=公費請求
//   請求情報区分コード 01=居宅サービス・施設・予防・地域密着型 / 02=居宅介護支援・介護予防支援
const HOKEN_KOHI_KUBUN_HOKEN = "1"; // 保険・公費等区分コード: 保険請求分
const SEIKYU_JOHO_KUBUN = "01"; // 請求情報区分コード: 居宅サービス (訪問介護)

export interface DensouBuildOptions {
  /** 請求事業所番号 (10 桁) */
  officeNumber: string;
  /** サービス提供年月 */
  year: number;
  month: number; // 1-12
  /** 地域区分単価 (円)。集計情報レコードの単位数単価 (×100 の 4 桁) に使用 */
  unitPrice: number;
  /**
   * 今回の請求 (提出) バッチの請求月。未指定は year/month (提供月) を請求月とみなす。
   * コントロールレコードの処理対象年月 (項11) = この翌月 (= 審査月) を設定する。
   * 月遅れ・返戻の再請求ファイル (提供月が過去) でも「同じ提出バッチの審査月」を
   * 使うため、呼出側は選択中の請求月をここに渡すこと。
   */
  seikyuYear?: number;
  seikyuMonth?: number; // 1-12
  /**
   * ファイル名の枝番 (総合事業のみ)。事業所番号が保険者で分かれて 1 提供月に複数ファイル
   * 出る場合に付ける (2 本目以降に 1,2,… を渡す)。未指定なら枝番なし。
   * 例) SG202606.CSV / SG26061.CSV — いずれも英字始まり 8 桁以内。
   */
  fileSeq?: number;
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

/**
 * 明細書 項35 / 集計 項17「利用者負担額」= **保険分の法定負担のみ**。
 * 公費分の本人負担は公費欄 (項41/20) に出すため、ここから除く。
 * 生保の全量公費では aggregate が `userAmount = kohiHonninFutan` としているので、
 * 引かないと同じ額を 2 か所に計上してしまう (2026-08-04 是正)。
 * 本人負担上限額が 0 円の従来ケースは差引 0 = 挙動不変。
 */
const hokenUserAmountOf = (r: DensouRow): number =>
  Math.max(0, r.userAmount - ((r.kohiHonninFutan ?? 0) + (r.kohi2HonninFutan ?? 0)));

const genderCode = (g: string | null) =>
  g == null ? "" : g.includes("女") ? "2" : g.includes("男") ? "1" : "";

export function buildKokuhoDensou(
  inputRows: DensouRow[],
  opts: DensouBuildOptions,
): DensouBuildResult {
  const warnings: string[] = [];
  // 保険者番号・被保険者番号のどちらかが空の行は **伝送に載せない**。
  // 国保連で確実に返戻になるうえ、請求書 (7111) の件数・金額まで水増しされるため。
  // 該当するのは「勤務実績はあるが介護保険の資格 (認定) が DB に無い利用者」で、
  // ほのぼの側も請求していないケース (2026-08-04: 姉ム 工藤 孝子 = 81,999円が
  // 被保番なしで載っていた。MEISAI はヘルパー勤務実績であって請求実績ではない)。
  const rows = inputRows.filter((r) => {
    const hasInsurer = !!(r.insurer_number ?? "").trim();
    const hasInsured = !!(r.insured_number ?? "").trim();
    if (hasInsurer && hasInsured) {
      // 番号は揃っているが検証数字が合わない = 返戻になる。除外はせず警告だけ出す
      // (正しい番号は被保険者証を見ないと決められないため自動では直さない)
      const w = insurerNumberWarning(r.insurer_number, r.user_name);
      if (w) warnings.push(w);
      return true;
    }
    const miss = [!hasInsurer && "保険者番号", !hasInsured && "被保険者番号"]
      .filter(Boolean)
      .join("・");
    warnings.push(
      `${r.user_name}: ${miss}が未登録のため伝送から除外しました (${r.totalAmount.toLocaleString()}円) — 介護保険の資格が無い利用者の実績が混入していないか確認してください`,
    );
    return false;
  });
  // 明細書の並び順を ほのぼの に合わせる (保険者番号+被保険者番号 の昇順)。
  // 仕様に並び順の規定は無いが、実伝送と行単位で突き合わせられる状態を保つため。
  rows.sort(compareByInsurer);
  // opts の年月 (= 処理対象年月 / 通常請求の提供年月)。
  // 行に ym があればそれを優先し、無ければこの opts 年月にフォールバック。
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
  // 公費単独 (被保険者番号 H = 生保 10割公費) は保険請求分レコードに含めない
  // (様式第一の記載例: 保険請求欄には記載せず、公費請求欄の生保行に合算)。
  const hokenRows = rows.filter((r) => !r.kohiTandoku);
  const totalCount = hokenRows.length;
  const totalUnits = hokenRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalCost = hokenRows.reduce((s, r) => s + r.totalAmount, 0);
  const totalInsurance = hokenRows.reduce((s, r) => s + r.insuranceAmount, 0);
  // 公費請求額は公費1 + 公費2 (複数公費の併用。公費2なしの行は従来どおり公費1のみ)
  const totalKohi = hokenRows.reduce(
    (s, r) => s + (r.kohiAmount ?? 0) + (r.kohi2Amount ?? 0),
    0,
  );
  // 請求書 (7111) の利用者負担合計は **公費分の本人負担も含む** 総額。
  // 明細書の項35/17 が「保険分のみ」なのとは別物 (ほのぼの実伝送で確認 2026-08-04:
  // 茂原 齊藤 一夫の公費本人負担 4,000円は明細書 項17 では空だが請求書には乗る)。
  const totalUser = hokenRows.reduce((s, r) => s + r.userAmount, 0);
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
  // 公費単独 (H番号) は法別未登録でも生保 (12) として合算する (未登録は warning)。
  // 複数公費の併用行は公費1・公費2 をそれぞれの法別の行に積む
  // (1 明細書 = その法別の件数 1 件。公費2なしの行は従来と同一出力)。
  interface KohiSummaryEntry {
    hobetsu: string;
    units: number;
    cost: number;
    insurance: number;
    kohi: number;
    honnin: number;
  }
  const kohiEntries: KohiSummaryEntry[] = [];
  for (const r of rows) {
    if ((r.kohiHobetsu || r.kohiTandoku) && (r.kohiAmount ?? 0) > 0) {
      kohiEntries.push({
        hobetsu: r.kohiHobetsu ?? "12",
        units: r.kohiUnits ?? r.totalUnits,
        cost: r.kohiTargetCost ?? r.totalAmount,
        insurance: r.kohiTargetInsurance ?? r.insuranceAmount,
        kohi: r.kohiAmount ?? 0,
        honnin: r.kohiHonninFutan ?? 0,
      });
    }
    if (r.kohi2Hobetsu && (r.kohi2Amount ?? 0) > 0) {
      kohiEntries.push({
        hobetsu: r.kohi2Hobetsu,
        units: r.kohi2Units ?? 0,
        cost: r.kohi2TargetCost ?? 0,
        insurance: r.kohi2TargetInsurance ?? 0,
        kohi: r.kohi2Amount ?? 0,
        honnin: r.kohi2HonninFutan ?? 0,
      });
    }
  }
  const byHobetsu = new Map<string, KohiSummaryEntry[]>();
  for (const e of kohiEntries) {
    if (!byHobetsu.has(e.hobetsu)) byHobetsu.set(e.hobetsu, []);
    byHobetsu.get(e.hobetsu)!.push(e);
  }
  for (const [hobetsu, es] of byHobetsu) {
    // 公費請求分: 単位数・費用は公費対象分の再掲 (kohiUnits/kohiTargetCost)。
    // 保険請求額(項番10)は 0 とする — 保険給付は「保険請求分レコード」で計上済みで、
    // 公費請求分レコードに再掲すると国保連取込で保険請求が二重計上になるため
    // (ほのぼの伝送準拠。様式第一の公費請求欄には保険請求額を記載しない)。
    // 利用者負担 = 公費分本人負担 (本人負担上限月額の適用分。上限 0 なら従来どおり 0)。
    dataParts.push([
      "7111",
      ym,
      office,
      "2", // 保険・公費等区分コード (2:公費請求。共通編1.4 項番79)
      hobetsu, // 法別番号 (12=生活保護, 21=精神通院, 54=難病 等)
      // ⚠ 法別81 (原爆) だけ請求情報区分コードが "0"。ほのぼの実伝送 3/3 で例外なし
      //   (7111 大網・市原 / 7113 やわた)。他の法別は通常どおり。
      hobetsu === "81" ? "0" : SEIKYU_JOHO_KUBUN,
      String(es.length),
      String(es.reduce((s, e) => s + e.units, 0)),
      String(es.reduce((s, e) => s + e.cost, 0)),
      "0", // 保険請求額: 公費請求分では 0 (保険請求分レコードで計上済。二重計上防止)
      String(es.reduce((s, e) => s + e.kohi, 0)),
      "0", // 利用者負担: 公費請求分では 0 (利用者負担は保険請求分レコードで計上済。ほのぼの準拠)
      "", "", "", "", "", "",
    ]);
  }

  // ── 7131 明細書 (利用者ごと: 基本 01 → 明細 02×n → 集計 10) ──
  for (const r of rows) {
    // 提供年月: 月遅れ/返戻の再請求では利用者ごとに元の提供月を使う (行 ym 優先)
    const rowYm = r.ym ?? ym;
    // 証記載保険者番号は数字8桁 (6桁の保険者は前0埋め) — IF仕様
    const insurerRaw = (r.insurer_number ?? "").trim();
    const insurer = insurerRaw ? insurerRaw.padStart(8, "0") : "";
    const insured = (r.insured_number ?? "").trim();
    // 保険者・被保険者番号が空の行は冒頭で除外済み (ここには来ない)
    const careLevelCode = CARE_LEVEL_CODE[(r.care_level ?? "").trim()] ?? "";
    if (!careLevelCode) warnings.push(`${r.user_name}: 要介護度 ("${r.care_level ?? "未設定"}") をコードに変換できません`);
    if (!r.birthDate) warnings.push(`${r.user_name}: 生年月日が未登録です`);
    if (!r.careOfficeNumber) warnings.push(`${r.user_name}: 担当居宅介護支援事業所 (事業所番号) が未登録です`);
    // 区分支給限度基準の超過分は保険請求から除外済み (aggregate.ts で 10割自費へ振替)。
    // 明細 02 レコードは実績全量、集計 10 の限度額管理対象単位数 (baseUnits) は
    // 基準内のみ = 差分が超過分、という様式第二どおりの構造で出るが、取込側の
    // 突合で気付けるよう warning で明示する。
    if (r.overUnits > 0) {
      warnings.push(
        `${r.user_name}: 区分支給限度基準を ${r.overUnits} 単位超過しています — 超過分 (${r.overAmount.toLocaleString()}円) は保険請求に含めず全額自費 (利用請求) 扱いです`,
      );
    }
    // 保険者変更 (転居) による分割明細書 (Phase 2): 1 行 = 1 明細書のままレコードを
    // 組むため自動的に保険者ごとの明細書に分かれる。項21「開始年月日」は未設定
    // (下の基本情報レコードのコメント参照) — 取込チェックで要確認のため warning で明示。
    if ((r.segmentCount ?? 1) > 1) {
      warnings.push(
        `${r.user_name}: 保険者変更による分割明細書 (${(r.segmentIndex ?? 0) + 1}/${r.segmentCount}, ${r.periodFrom ?? "?"}〜${r.periodTo ?? "?"}) です — 基本情報レコード項21「開始年月日」は未設定で出力します (⚠要取込チェック: 転居分割時にセグメント開始日の設定が必要かは伝送ソフトの取込テストで確認)`,
      );
    }

    // 公費単独 (H番号 10割公費): 保険給付率は空欄、公費1給付率 100。
    // 給付率は整数演算: copay 0.1/0.2/0.3 → 1/2/3 → 90/80/70 (float 1円ズレ防止と同方針)
    const benefitRate = r.kohiTandoku ? "" : String((10 - Math.round(r.copay_rate * 10)) * 10); // 90 等
    // 公費欄 (負担者番号・受給者番号・対象単位数・請求額・本人負担) を出すかどうかは
    // 「対象月に有効な公費があるか」で決める。**公費請求額 0 でも出す**。
    // 生保併用で本人負担上限額が保険給付後負担と同額のとき kohiAmount=0 になり、
    // 以前の `kohiAmount > 0` 条件だと公費欄が丸ごと落ちていた
    // (2026-08-04: 姉ム 鈴木 渉 = ほのぼのは 公費対象1,114単位・請求0円・本人1,192円を出力)。
    // ※ 請求書 (7111) 側の公費請求分レコードは「公費請求額 > 0」で判定する (:166) —
    //   請求が発生しない公費は請求書に載せないため、そちらの条件は変えない。
    const hasKohi = r.kohiTandoku || !!r.kohiHobetsu;
    // 本人負担のうち公費分 (項41/20 に出す分) は保険側の利用者負担から除く。
    // 生保全量公費では aggregate が userAmount = kohiHonninFutan としているため、
    // 引かないと同じ額を項35/17 と項41/20 に二重計上する。
    // 部分公費では userAmount = 公費対象外分 + 公費分本人負担 なので、引いた残りが正。
    const hokenUserAmount = hokenUserAmountOf(r);
    // 公費2 (複数公費の併用)。公費1と同じく請求額 > 0 の場合のみ公費2欄を出力する
    // (公費2なしの行は全欄空 = 従来出力とバイト一致)
    const hasKohi2 = !!(r.kohi2Hobetsu && (r.kohi2Amount ?? 0) > 0);
    if (hasKohi2 && !r.kohi2FutanshaNumber) {
      warnings.push(
        `${r.user_name}: 公費2 (法別${r.kohi2Hobetsu}) の負担者番号が未登録です`,
      );
    }
    if (r.kohiTandoku && !r.kohiHobetsu) {
      warnings.push(
        `${r.user_name}: 公費単独 (被保険者番号 H) なのに公費情報 (法別番号) が未登録です — 保険情報に法別12 (生活保護) を登録してください`,
      );
    }
    if (hasKohi && !r.kohiFutanshaNumber) {
      warnings.push(`${r.user_name}: 公費 (法別${r.kohiHobetsu ?? "12"}) の負担者番号が未登録です`);
    }

    // 基本情報レコード (01) — 様式第二で使用しない施設系項目は空欄
    dataParts.push([
      "7131", // 1 交換情報識別番号
      "01", // 2 レコード種別コード
      rowYm, // 3 サービス提供年月 (行 ym 優先 = 月遅れ/返戻は元提供月)
      office, // 4 事業所番号
      insurer, // 5 証記載保険者番号
      insured, // 6 被保険者番号
      hasKohi ? r.kohiFutanshaNumber ?? "" : "", // 7 公費1 負担者番号
      hasKohi ? r.kohiJukyushaNumber ?? "" : "", // 8 公費1 受給者番号
      hasKohi2 ? r.kohi2FutanshaNumber ?? "" : "", // 9 公費2 負担者番号
      hasKohi2 ? r.kohi2JukyushaNumber ?? "" : "", // 10 公費2 受給者番号
      "", // 11 公費3 負担者番号
      "", // 12 公費3 受給者番号
      dateNum(r.birthDate), // 13 生年月日
      genderCode(r.gender), // 14 性別コード
      careLevelCode, // 15 要介護状態区分コード
      "", // 16 旧措置入所者特例コード
      dateNum(r.certStart), // 17 認定有効期間 開始
      dateNum(r.certEnd), // 18 認定有効期間 終了
      // 19 居宅サービス計画作成区分コード。1=居宅介護支援事業所作成(→項20必須), 2=被保険者(自己)作成(→項20空でも可)。
      // careOfficeNumber 未解決で "1" 固定にすると項20空欄=必須欠落で返戻するため、番号が無ければ "2" で出す
      // (該当利用者にケアマネがいる場合は warning(:171) が出るので、care_office_number を登録すれば "1" に戻る)。
      // 取込済の区分があればそれを使う (利用者ごとに違う)。無ければ従来の既定。
      r.careOfficeNumber ? (r.planCreatorKubun ?? "1") : "2", // 19
      r.careOfficeNumber ?? "", // 20 事業所番号 (居宅介護支援事業所。区分2のときは空)
      // 21 開始年月日: 当該月に当事業所の提供を開始した利用者のみ設定する。
      //    ⚠ **初回訪問日ではなく契約日**。実証で 33 名中 初回訪問日と一致したのは
      //      4 名だけで、残りは訪問日より前だった (花見川 尾崎脩二 伝送 20260615 /
      //      初回訪問 20260626)。実績からは導けないので ほのぼのの
      //      「介護請求(明細付)_一覧」の「サービス開始年月日」を取り込んで使う
      //      (client_insurance_records.service_start_date)。
      //    client_office_assignments.start_date は一括取込の既定値が全員に入っており使えない。
      // ⚠ 要取込チェック: 保険者変更 (転居) の分割明細書 (segmentCount>1) に
      //    セグメント開始日 (periodFrom) を設定すべきかは IF 仕様書に明文が無く未確認。
      r.serviceStartDate ? r.serviceStartDate.replace(/-/g, "") : "", // 21 開始年月日
      "", // 22 中止年月日
      "", // 23 中止理由・入所前状況
      "", // 24 入所年月日
      "", // 25 退所年月日
      "", // 26 入所実日数
      "", // 27 外泊日数
      "", // 28 退所後の状態
      // 公費単独 (H番号): 29 空欄 / 30=100。合計欄は 33 単位数のみ設定し
      // 34 請求額=0・35 負担=0、39-44 公費1 に全額 (kohiAmount=totalAmount) が入る。
      // ※ 要取込チェック: 公費単独の 33-35 の扱い (単位数を設定 or 全欄空) は
      //    国保連の取込テストで要確認。ここでは「保険請求額=0・公費請求額=10割」の素直な形。
      benefitRate, // 29 保険給付率 (公費単独は空欄)
      hasKohi ? "100" : "", // 30 公費1給付率 (生活保護等は 100)
      hasKohi2 ? "100" : "", // 31 公費2給付率 (介護の保険優先公費は 100)
      "", // 32 公費3給付率
      String(r.totalUnits), // 33 合計 保険 サービス単位数
      String(r.insuranceAmount), // 34 同 請求額 (公費単独は 0)
      // 35 利用者負担額 = 保険分の法定負担のみ。公費分の本人負担は項41 に出すため
      //    ここには含めない (含めると二重計上になる)
      String(hokenUserAmount),
      "", // 36 緊急時施設療養費請求額
      "", // 37 特定診療費請求額
      "", // 38 特定入所者介護サービス費等請求額
      // 39-44 公費1 合計情報 (サービス単位数 / 請求額 / 本人負担額 / 緊急時 / 特定診療 / 特定入所者)
      // 39 公費1対象サービス単位数 (部分公費は公費適用期間内の実績分のみ)
      hasKohi ? String(r.kohiUnits ?? r.totalUnits) : "",
      hasKohi ? String(r.kohiAmount ?? 0) : "", // 40 公費1請求額
      hasKohi ? String(r.kohiHonninFutan ?? 0) : "", // 41 公費1本人負担額 (上限月額の適用分)
      "", "", "",
      // 45-50 公費2 合計情報 (サービス単位数 / 請求額 / 本人負担額 / 緊急時 / 特定診療 / 特定入所者)
      hasKohi2 ? String(r.kohi2Units ?? 0) : "", // 45 公費2対象サービス単位数
      hasKohi2 ? String(r.kohi2Amount ?? 0) : "", // 46 公費2請求額
      hasKohi2 ? String(r.kohi2HonninFutan ?? 0) : "", // 47 公費2本人負担額
      "", "", "",
      "", "", "", "", "", "", // 51-56 公費3 合計情報
    ]);

    // 明細情報レコード (02) — サービスコードごと。
    // 実績単位の月次加算 (初回 114001 / 緊急時 114000 / 生活機能向上連携 114003・114002) は
    // aggregate.ts が details[] に加算行として積んでいるため、ここでそのまま 02 行になる。
    // 処遇改善等の%加算 (addonCode) のみ別枠で 1 行追加する (従来どおり)。
    // 公費対象が按分されている行 (kohiUnits < totalUnits = 部分公費の期間按分・
    // 月途中開始の生保・限度額超過キャップ) は明細の公費対象欄 (項11/15) を
    // aggregate.ts の期間按分値 (kohi_count/kohi_units) で出し、%加算行の公費対象分も
    // 按分して Σ明細(項15) = 集計(項18) の突合を保つ (Phase 1 で法別12にも適用)。
    // 全量公費 (kohiUnits == totalUnits = フル月の生保・公費単独 等) は従来どおり全量。
    const kohiPriority =
      hasKohi && r.kohiUnits != null && r.kohiUnits < r.totalUnits;
    const kohi2Priority =
      hasKohi2 && r.kohi2Units != null && r.kohi2Units < r.totalUnits;
    const detailLines: {
      code: string;
      unitPer: number;
      count: number;
      units: number;
      kohiCount?: number;
      kohiUnits?: number;
      kohi2Count?: number;
      kohi2Units?: number;
    }[] = [];
    for (const d of r.details) {
      if (!d.service_code) {
        warnings.push(`${r.user_name}: "${d.service_type}" のサービスコードがマスタから引けません`);
        continue;
      }
      detailLines.push({
        code: d.service_code,
        unitPer: d.unit_per,
        count: d.count,
        units: d.units,
        kohiCount: d.kohi_count,
        kohiUnits: d.kohi_units,
        kohi2Count: d.kohi2_count,
        kohi2Units: d.kohi2_units,
      });
    }
    if (r.addonUnits > 0) {
      if (r.addonCode) {
        // 処遇改善等の月次加算: 単位数 = 加算単位数、回数 = 1
        if (r.addonUnits > 9999) {
          warnings.push(`${r.user_name}: 処遇改善加算の単位数 (${r.addonUnits}) が4桁を超えています — 明細の単位数欄(4バイト)で桁溢れの可能性があります`);
        }
        const addonLine: (typeof detailLines)[number] = {
          code: r.addonCode,
          unitPer: r.addonUnits,
          count: 1,
          units: r.addonUnits,
        };
        if (kohiPriority) {
          // 部分公費: %加算行の公費対象分 = 集計の公費対象単位数 − 明細行の公費対象合計
          // (Σ明細(15) = 集計(18) の突合を成立させる。全量公費なら addonUnits と一致)
          const detailKohiSum = detailLines.reduce(
            (s, d) => s + (d.kohiUnits ?? d.units),
            0,
          );
          const addonKohi = Math.min(
            Math.max((r.kohiUnits ?? r.totalUnits) - detailKohiSum, 0),
            r.addonUnits,
          );
          addonLine.kohiCount = addonKohi > 0 ? 1 : 0;
          addonLine.kohiUnits = addonKohi;
        }
        if (kohi2Priority) {
          // 公費2の%加算按分も公費1と同方針 (Σ明細(16) = 集計(21) の突合)
          const detailKohi2Sum = detailLines.reduce(
            (s, d) => s + (d.kohi2Units ?? d.units),
            0,
          );
          const addonKohi2 = Math.min(
            Math.max((r.kohi2Units ?? 0) - detailKohi2Sum, 0),
            r.addonUnits,
          );
          addonLine.kohi2Count = addonKohi2 > 0 ? 1 : 0;
          addonLine.kohi2Units = addonKohi2;
        }
        detailLines.push(addonLine);
      } else {
        warnings.push(`${r.user_name}: 加算 (${r.addonLabel ?? "処遇改善"}) のサービスコードが不明です`);
      }
    }
    // 明細行の並びを ほのぼの に合わせる = **サービスコード昇順**。
    // (実伝送 1,969 グループすべてこの順。当方は単位数の降順だった)
    detailLines.sort((a, b) => a.code.localeCompare(b.code));
    for (const d of detailLines) {
      // 項10 日数・回数 / 項11 公費1対象日数・回数 は「数字2桁」(_if_form2.txt L7666-7669) —
      // 100 回以上は桁溢れで取込エラー/切り捨ての恐れがあるため warning で明示する
      if (d.count > 99) {
        warnings.push(
          `${r.user_name}: サービスコード ${d.code} の回数 (${d.count}) が明細行の日数・回数欄 (数字2桁 = 上限99) を超えています — 取込エラーの可能性があるため実績を確認してください`,
        );
      }
      dataParts.push([
        "7131", // 1
        "02", // 2 レコード種別コード
        rowYm, // 3 サービス提供年月 (行 ym 優先)
        office, // 4
        insurer, // 5
        insured, // 6
        d.code.slice(0, 2), // 7 サービス種類コード
        d.code.slice(2, 6), // 8 サービス項目コード
        String(d.unitPer), // 9 単位数
        String(d.count), // 10 日数・回数
        // 11 公費1対象日数・回数 (部分公費は公費適用期間内の実績のみ。全量公費は count と同値)
        hasKohi ? String(d.kohiCount ?? d.count) : "",
        hasKohi2 ? String(d.kohi2Count ?? d.count) : "", // 12 公費2対象日数・回数
        "", // 13 公費3対象日数・回数
        String(d.units), // 14 サービス単位数
        hasKohi ? String(d.kohiUnits ?? d.units) : "", // 15 公費1対象サービス単位数
        hasKohi2 ? String(d.kohi2Units ?? d.units) : "", // 16 公費2対象サービス単位数
        "", // 17 公費3対象サービス単位数
        "", // 18 摘要
      ]);
    }

    // 集計情報レコード (10) — サービス種類 (訪問介護 = 11) 単位
    const svcKindCode = detailLines[0]?.code.slice(0, 2) ?? "11";
    // 限度額管理対象外 (契約 C1) = 処遇改善等%加算 + 初回加算 + 緊急時訪問介護加算。
    // 管理対象 (基準内) = baseUnits − 初回・緊急時分 (= baseUnits − (対象外 − %加算))。
    // 恒等式: 保険単位数合計 (14) = 管理対象 (10) + 管理対象外 (11)。
    const kanriGaiUnits = r.kanriTaishougaiUnits;
    const kanriInUnits = r.baseUnits - (kanriGaiUnits - r.addonUnits);
    dataParts.push([
      "7131", // 1
      "10", // 2 レコード種別コード
      rowYm, // 3 サービス提供年月 (行 ym 優先)
      office, // 4
      insurer, // 5
      insured, // 6
      svcKindCode, // 7 サービス種類コード
      String(r.serviceDays), // 8 サービス実日数
      // 9-11: 超過分は保険請求外 (aggregate.ts で除外済み・selfPayAmount へ分離)。
      // 超過がある場合、管理対象 (10) は明細 02 行の合計より小さくなり、その差 =
      // 超過分は保険請求外 (全額自費) — 様式第二の標準的な扱い。
      // 9 計画単位数: 月次情報の計画単位数 > 認定の区分支給限度基準 > 基準内 (最終フォールバック)。
      // 旧: 無条件で基準内 (=⑤と同値) → 超過ありのとき「計画通りなのに超過」の矛盾が様式に残るため、
      // 限度額があればそれを計画とみなす (ほのぼの同様の既定)。
      String(r.planUnits ?? r.limitUnits ?? kanriInUnits),
      // 10 限度額管理対象単位数 = **実績の合計** (超過分を含む)。
      //   様式第二の 項10 は「該当サービス種類の集計限度額管理対象単位数」= 明細 02 行の
      //   限度額管理対象単位数の合計。明細 02 は実績全量で出しているので、ここを基準内に
      //   丸めると 02 と 10 が食い違う。超過分を保険から外すのは 項14「単位数合計」
      //   (= 保険給付対象単位数) の側で、項10 ではない。
      //   実証: 五井 大澤陽子 (要介護2 / 限度 19,705) 実績 20,199 → ほのぼのは 項9=19,705
      //   (給付管理票の計画) / 項10=20,199 (実績) / 項14=24,947 (基準内 + 対象外)。
      String(kanriInUnits + (r.overUnits ?? 0)),
      String(kanriGaiUnits), // 11 限度額管理対象外単位数 (処遇改善等 + 初回 + 緊急時)
      "", // 12 短期入所計画日数
      "", // 13 短期入所実日数
      String(r.totalUnits), // 14 保険 単位数合計
      String(Math.round(opts.unitPrice * 100)), // 15 単位数単価 (10.00円 → 1000)
      String(r.insuranceAmount), // 16 保険 請求額
      String(hokenUserAmount), // 17 利用者負担額 (保険分のみ。公費分本人負担は項20)
      // 18-20 公費1 (単位数合計 / 請求額 / 本人負担額)
      hasKohi ? String(r.kohiUnits ?? r.totalUnits) : "", // 18 公費対象単位数
      hasKohi ? String(r.kohiAmount ?? 0) : "", // 19 公費請求額
      hasKohi ? String(r.kohiHonninFutan ?? 0) : "", // 20 公費分本人負担額
      // 21-23 公費2 (単位数合計 / 請求額 / 本人負担額) — 複数公費の併用時のみ
      hasKohi2 ? String(r.kohi2Units ?? 0) : "", // 21 公費2単位数合計
      hasKohi2 ? String(r.kohi2Amount ?? 0) : "", // 22 公費2請求額
      hasKohi2 ? String(r.kohi2HonninFutan ?? 0) : "", // 23 公費2本人負担額
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
  // 処理対象年月 (項11) = 審査月。
  // 仕様書 (migrations/_if_kyotaku.txt 注1「処理対象年月について」):
  //   「保険者／事業所等から国保連合会へ受け渡す交換情報の場合、
  //     国保連合会での電算処理を実行する年月を設定する」
  // = 提供月ではなく審査月。提供月 M の請求は M+1 月 10 日までに提出し M+1 月に
  // 審査されるため、審査月 = 請求月 (提出バッチの月 = opts.seikyuYear/Month、
  // 未指定は提供月) の翌月。月遅れ・返戻の再請求ファイルも同じ提出バッチの審査月。
  // ⚠ 要取込チェック: 初回伝送時に伝送通信ソフトの取込チェックで処理対象年月が
  //    受理されるか確認すること (過誤・審査依頼の要望月指定がある場合は別途調整)。
  const sy = opts.seikyuYear ?? opts.year;
  const sm = opts.seikyuMonth ?? opts.month;
  const shinsaYm =
    sm === 12 ? `${sy + 1}01` : `${sy}${String(sm + 1).padStart(2, "0")}`;
  // コントロールレコード: 種別1, 連番, ボリューム通番0, データ件数, データ種別711,
  //   福祉事務所0, 保険者番号0, 事業所番号, 都道府県番号0, 媒体区分7(インターネット伝送), 処理対象年月(審査月), 管理番号1
  //   (共通編: 1=伝送(ISDN) / 2=MO / 4=FD・CD-R / 7=伝送(インターネット)。現行はインターネット請求=7)
  lines.push(
    ["1", String(recNo++), "0", String(dataParts.length), "711", "0", "0", office, "0", "7", shinsaYm, "1"].join(","),
  );
  // ほのぼの実伝送と同じ書式 (引用符・未使用項目の 0 埋め) に整える。値は変えない。
  for (const parts of dataParts) {
    lines.push(["2", String(recNo++), ...formatRecordLikeHonobono(parts)].join(","));
  }
  lines.push(["3", String(recNo++)].join(","));

  return {
    content: lines.join("\r\n") + "\r\n",
    fileName: `J${ym}.CSV`, // 英字始まり 8 桁以内 + .CSV
    dataRecordCount: dataParts.length,
    warnings,
  };
}
