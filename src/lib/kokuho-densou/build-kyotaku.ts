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
 *
 * 短期入所 (サービス種類 21/22/23/2A) の扱い (_if_kyotaku.txt ※6):
 *   対象年月が平成14年1月以降は「3:居宅サービス給付管理票」1 本に
 *   短期入所も給付計画「単位数」で記載する (種別 1/2 の分離・日数管理・
 *   8211 項15-17 の短期入所票件数は 対象年月が平成13年12月以前のみ)。
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
  短期入所: "21", // 施設区分の無い略称は生活介護 (21) 扱い (create 画面等の語彙)
  短期入所療養介護: "22", // 施設区分の無い名称は老健 (22) を既定 (billing-content.tsx と同じ)
  "短期入所療養介護(老健)": "22",
  "短期入所療養介護(病院療養型)": "23",
  "短期入所療養介護(医療院)": "2A", // kaigo_service_codes 実データも 2A 系 (例: 2A1201)
  居宅療養管理指導: "31",
  "定期巡回・随時対応型訪問介護看護": "32",
  夜間対応型訪問介護: "33",
  認知症対応型通所介護: "36",
  小規模多機能型居宅介護: "37",
};

/**
 * 短期入所系サービス種類コード (21/22/23/2A)。
 * _if_kyotaku.txt ※6 (8221 レイアウト備考): 対象年月が平成14年1月以降は
 * 短期入所も含めて「3:居宅サービス給付管理票」1 本に単位数で記載するため、
 * この区別は 対象年月が平成13年12月以前 (種別 1/2 の分離・日数管理) でのみ必要。
 */
const SHORT_STAY_KIND_CODES = new Set(["21", "22", "23", "2A"]);

/** 平成14年1月 (200201) = 給付管理票が種別3 (居宅サービス) に一本化された対象年月 */
const UNIFIED_KYUFU_KANRI_YM = 200201;

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

/** 給付管理票情報作成区分コード (8221 項5): 1=新規 / 2=修正 / 3=取消 */
export type KyufuKanriSakuseiKubun = "1" | "2" | "3";

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
  /**
   * 給付管理票情報作成区分 (1=新規 / 2=修正 / 3=取消)。
   * 省略時は "1" (新規)。月遅れ・返戻の再請求分は通常 "2" (修正)。
   */
  sakuseiKubun?: KyufuKanriSakuseiKubun;
}

export interface KyotakuDensouOptions {
  /** 居宅介護支援事業所番号 (10 桁) */
  officeNumber: string;
  /** サービス提供 (対象) 年月 */
  year: number;
  month: number;
  /** 地域区分単価 (円) — 計画費の請求金額計算用 */
  unitPrice: number;
  /**
   * コントロールレコードの処理対象年月 (国保連が電算処理=審査を実行する年月)。
   * 省略時はサービス提供月の翌月。
   * 月遅れ再請求 (元提供月ファイル) を今月提出する場合は「今月+1」を明示指定する。
   */
  shoriYear?: number;
  shoriMonth?: number;
}

interface BuildResult {
  content: string;
  fileName: string;
  dataRecordCount: number;
  warnings: string[];
}

/**
 * コントロール/データ/エンドレコードを組み立てる。
 * ⚠ shoriYm (項11 処理対象年月) は「国保連合会での電算処理 (審査) を実行する年月」
 *   (_if_kyotaku.txt 注1)。サービス提供月ではない。
 *   通常 = サービス提供月の翌月 (= 提出月と同月)。
 *   例: 2000年4月サービス提供分を 5月に審査 → "200005"。
 *   月遅れ再請求では元提供月に関わらず「今回提出分の審査月」を設定する。
 */
function assemble(dataParts: string[][], dataKind: string, office: string, shoriYm: string, fileName: string): Omit<BuildResult, "warnings"> {
  const lines: string[] = [];
  let recNo = 1;
  lines.push(
    ["1", String(recNo++), "0", String(dataParts.length), dataKind, "0", "0", office, "0", "1", shoriYm, "1"].join(","),
  );
  for (const parts of dataParts) lines.push(["2", String(recNo++), ...parts].join(","));
  lines.push(["3", String(recNo++)].join(","));
  return { content: lines.join("\r\n") + "\r\n", fileName, dataRecordCount: dataParts.length };
}

/** 処理対象年月 (YYYYMM)。opts.shoriYear/Month 優先、既定はサービス提供月の翌月 */
function shoriYmOf(opts: KyotakuDensouOptions): string {
  if (opts.shoriYear && opts.shoriMonth) {
    return `${opts.shoriYear}${String(opts.shoriMonth).padStart(2, "0")}`;
  }
  const d = new Date(opts.year, opts.month, 1); // 提供月の翌月 1 日
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
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
  // 提出年月 = 処理対象年月 (通常サービス対象月の翌月。再請求時は opts.shoriYear/Month)
  const submitYm = shoriYmOf(opts);

  const dataParts: string[][] = [];

  // ── 給付管理票種別区分 (_if_kyotaku.txt ※6 / コード一覧 89) ──
  // 対象年月が平成14年1月 (200201) 以降: 短期入所を含む全サービスを
  // 「3:居宅サービス給付管理票」1 本に給付計画「単位数」で記載する
  // (項15=居宅サービス区分支給限度基準額、項21=設定不要)。
  // 種別 1 (訪問通所)/2 (短期入所=日数管理・項21必須) の分離は
  // 対象年月が平成13年12月以前のみ → 本システムのデータでは発生しないため未対応。
  const isUnifiedYm = Number(ym) >= UNIFIED_KYUFU_KANRI_YM;
  if (!isUnifiedYm) {
    const affected = users
      .filter((u) => u.lines.some((l) => SHORT_STAY_KIND_CODES.has(l.serviceKindCode)))
      .map((u) => u.userName);
    warnings.push(
      `対象年月 ${ym} は平成14年1月より前のため、本来は種別1 (訪問通所) / 種別2 (短期入所=日数管理) に分離した給付管理票が必要ですが未対応です — 現行様式 (種別3: 居宅サービス給付管理票・単位数) で出力します` +
        (affected.length > 0 ? ` (短期入所を含む利用者: ${affected.join("、")})` : ""),
    );
  }

  // 8211 総括票 — 作成区分 (新規/修正/取消) ごとの件数を集計。
  // 項12-14 の欄名は「自県分 訪問通所サービス・居宅サービス給付管理票」
  // (_if_kyotaku.txt 8211 レイアウト 項12-17)。種別3 (居宅サービス給付管理票) は
  // ここに計上し、項15-17 (短期入所サービス給付管理票の件数) は種別2 の票
  // (平成13年12月以前の対象年月のみ) 専用のため、平成14年1月以降は 0 が正。
  const kubunCount: Record<KyufuKanriSakuseiKubun, number> = { "1": 0, "2": 0, "3": 0 };
  for (const u of users) kubunCount[u.sakuseiKubun ?? "1"]++;
  dataParts.push([
    "8211", // 1 交換情報識別番号
    submitYm, // 2 提出年月
    "0", // 3 保険者番号 ("0" 固定)
    office, // 4 事業所番号 (居宅介護支援事業所)
    "1", // 5 居宅サービス計画作成区分コード (1=居宅介護支援事業所作成)
    "0", "0", "0", "0", "0", "0", // 6-11 他県分 (訪問通所・居宅/短期入所 × 新規/修正/取消)
    String(kubunCount["1"]), String(kubunCount["2"]), String(kubunCount["3"]), // 12-14 自県分 訪問通所・居宅サービス給付管理票 新規/修正/取消 (種別3 はここ)
    "0", "0", "0", // 15-17 自県分 短期入所サービス給付管理票 新規/修正/取消 (種別2 = H13.12 以前のみ → 0)
  ]);

  for (const u of users) {
    const careCode = CARE_LEVEL_CODE[(u.careLevel ?? "").trim()] ?? "";
    const kubun: KyufuKanriSakuseiKubun = u.sakuseiKubun ?? "1";
    if (!u.insurerNumber) warnings.push(`${u.userName}: 保険者番号が未登録です`);
    if (!u.insuredNumber) warnings.push(`${u.userName}: 被保険者番号が未登録です`);
    if (!careCode) warnings.push(`${u.userName}: 要介護度 ("${u.careLevel ?? "未設定"}") をコードに変換できません`);
    if (!u.birthDate) warnings.push(`${u.userName}: 生年月日が未登録です`);
    if (u.limitUnits <= 0) warnings.push(`${u.userName}: 区分支給限度基準額が未登録です`);

    const head = (lineNo: string) => [
      "8221", // 1
      ym, // 2 対象年月
      u.insurerNumber ? u.insurerNumber.trim().padStart(8, "0") : "", // 3 証記載保険者番号 (数字8桁・前0埋め)
      office, // 4 事業所番号 (居宅介護支援事業所)
      kubun, // 5 給付管理票情報作成区分コード (1=新規 / 2=修正 / 3=取消)
      todayNum, // 6 給付管理票作成年月日
      // 7 給付管理票種別区分コード。H14.01 以降の対象年月は短期入所も含め
      //   常に 3 (居宅サービス給付管理票) — ※6 (1/2 は H13.12 以前のみ)
      "3",
      lineNo, // 8 給付管理票明細行番号
      u.insuredNumber, // 9 被保険者番号
      dateNum(u.birthDate), // 10 被保険者生年月日
      genderCode(u.gender), // 11 性別コード
      careCode, // 12 要介護状態区分コード
      ymNum(u.limitStart), // 13 限度額適用期間 (開始)
      ymNum(u.limitEnd), // 14 限度額適用期間 (終了)
    ];

    // 明細行 (01〜98)。99 行目は終端行のため明細は最大 98 行
    let userLines = u.lines;
    if (userLines.length > 98) {
      warnings.push(
        `${u.userName}: 給付管理票の明細が ${userLines.length} 行あり上限 98 行を超えるため 99 行目以降を出力できません (行番号 99 は終端行のため)`,
      );
      userLines = userLines.slice(0, 98);
    }
    let total = 0;
    userLines.forEach((l, i) => {
      if (!l.officeNumber) warnings.push(`${u.userName}: サービス事業所番号が未設定の行があります`);
      if (!l.serviceKindCode) warnings.push(`${u.userName}: サービス種類コード未設定の行があります (SERVICE_KIND_CODE 未登録のサービス種別の可能性)`);
      total += l.plannedUnits;
      dataParts.push([
        ...head(String(i + 1).padStart(2, "0")),
        "", // 15 訪問通所/短期入所支給限度額 (明細行は未設定 — ※4)
        "1", // 16 居宅サービス計画作成区分コード
        l.officeNumber, // 17 事業所番号 (サービス事業所)
        "1", // 18 指定/基準該当等事業所区分コード (1=指定)
        l.serviceKindCode, // 19 サービス種類コード (短期入所 21/22/23/2A も同一票に記載)
        String(l.plannedUnits), // 20 給付計画単位数 (種別3 は短期入所も単位数 — ※6。日数記載は種別2=H13.12以前のみ)
        "", // 21 限度額管理期間における前月までの給付計画日数 (種別3 は設定不要 — ※6。種別2=短期入所票のみ必須)
        "", "", "", // 22-24 (明細行は未設定 — ※4)
      ]);
    });

    // 終端行 (99)
    dataParts.push([
      ...head("99"),
      String(u.limitUnits), // 15 居宅サービス区分支給限度基準額 (単位数 — ※6。種別3 は訪問通所+短期入所 一本の限度額)
      "1", // 16 居宅サービス計画作成区分コード
      "", // 17 事業所番号 (終端行は未設定)
      "", // 18
      "", // 19
      "", // 20
      "", // 21 (種別3 は設定不要 — ※6)
      String(total), // 22 指定サービス分小計 (単位数)
      "0", // 23 基準該当サービス分小計
      String(total), // 24 給付計画合計単位数
    ]);
  }

  // ⚠ コントロールレコード項11 (処理対象年月) は「審査を実行する年月」=提出月
  //   (_if_kyotaku.txt 注1)。サービス提供月 (ym) ではない。
  return { ...assemble(dataParts, "821", office, submitYm, `K${ym}.CSV`), warnings };
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
  // ── 公費 (生活保護等)。省略時は公費なし (既存呼出互換) ──
  /**
   * 公費単独 (10割公費)。被保険者番号が 'H' 始まり (= 介護保険未加入の
   * 生保受給者 = みなし2号)。保険請求分の 7111 に含めず、公費請求分の
   * 7111 (区分2・法別12) へ全額 (10割) を計上する (build.ts の訪問介護と同じ扱い)。
   */
  kohiTandoku?: boolean;
  /** 公費 法別番号 (12=生活保護 等) */
  kohiHobetsu?: string | null;
  /** 公費負担者番号 (8桁) — 8121 項8。生活保護単独の場合必須 */
  kohiFutanshaNumber?: string | null;
  /** 公費受給者番号 (7桁) — 8121 項9。生活保護単独の場合必須 */
  kohiJukyushaNumber?: string | null;
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

  const amountOf = (u: KeikakuhiUser) => Math.floor((u.units * unitPrice100) / 100);

  // ── 公費単独 (被保険者番号 H = 生保 10割公費) は保険請求分レコードに含めない ──
  // (build.ts 訪問介護と同じ扱い。様式第一では保険請求欄に記載せず公費請求欄の生保行へ)
  const hokenUsers = users.filter((u) => !u.kohiTandoku);
  const tandokuUsers = users.filter((u) => !!u.kohiTandoku);

  const totalUnits = hokenUsers.reduce((s, u) => s + u.units, 0);
  // 計画費は 10 割給付 (利用者負担なし)
  const totalAmount = hokenUsers.reduce((s, u) => s + amountOf(u), 0);

  // 7111 請求書情報 (保険請求分)
  dataParts.push([
    "7111",
    ym,
    office,
    "1", // 保険・公費等区分コード (1:保険請求。共通編1.4 項番79)
    "0", // 法別番号 (保険請求分は0)
    "02", // 請求情報区分コード (02:居宅介護支援・介護予防支援。共通編1.4 項番80)
    String(hokenUsers.length), // 件数
    String(totalUnits), // 単位数
    String(totalAmount), // 費用合計
    String(totalAmount), // 保険請求額 (10 割)
    "0", // 公費請求額 (公費併用でも本人負担 0 円のため振替 0)
    "0", // 利用者負担
    "", "", "", "", "", "", // 特定入所者 (対象外)
  ]);

  // 7111 請求書情報 (公費請求分 — 法別番号ごと)
  // 居宅介護支援費は 10 割給付のため、公費併用 (被保険者 + 法別12) の公費請求額は
  // 0 円 → 公費請求分レコードは公費単独 (H番号) 者のみから生成する。
  // ⚠ 要取込チェック: 公費併用で公費請求額 0 円の利用者を公費請求分 7111 の
  //    件数に計上する必要があるか (ここでは build.ts 同様、請求額 0 は計上しない)。
  // 公費単独は法別未登録でも生保 (12) として合算する (未登録は warning)
  const byHobetsu = new Map<string, KeikakuhiUser[]>();
  for (const u of tandokuUsers) {
    const h = u.kohiHobetsu?.trim() || "12";
    if (!byHobetsu.has(h)) byHobetsu.set(h, []);
    byHobetsu.get(h)!.push(u);
  }
  for (const [hobetsu, hUsers] of byHobetsu) {
    dataParts.push([
      "7111",
      ym,
      office,
      "2", // 保険・公費等区分コード (2:公費請求。共通編1.4 項番79)
      hobetsu, // 法別番号 (12=生活保護 等)
      "02", // 請求情報区分コード (02:居宅介護支援・介護予防支援)
      String(hUsers.length), // 件数
      String(hUsers.reduce((s, u) => s + u.units, 0)), // 単位数
      String(hUsers.reduce((s, u) => s + amountOf(u), 0)), // 費用合計
      "0", // 保険請求額 (公費単独は保険給付なし)
      String(hUsers.reduce((s, u) => s + amountOf(u), 0)), // 公費請求額 (10 割)
      "0", // 利用者負担
      "", "", "", "", "", "",
    ]);
  }

  for (const u of users) {
    const careCode = CARE_LEVEL_CODE[(u.careLevel ?? "").trim()] ?? "";
    if (!careCode) warnings.push(`${u.userName}: 要介護度 ("${u.careLevel ?? "未設定"}") をコードに変換できません`);
    if (!u.serviceCode) warnings.push(`${u.userName}: 居宅介護支援費のサービスコードが年度別単位数マスタにありません`);
    if (!u.requestDate) warnings.push(`${u.userName}: 計画作成依頼届出年月日が無いため認定開始日で代用しました`);

    // 公費 (生活保護等): 併用 (振替 0 円) でも 8121 の項8/9 (負担者番号/受給者番号) は設定する
    const hasKohi = !!u.kohiTandoku || !!u.kohiHobetsu?.trim();
    if (u.kohiTandoku && !u.kohiHobetsu?.trim()) {
      warnings.push(
        `${u.userName}: 公費単独 (被保険者番号 H) なのに公費情報 (法別番号) が未登録です — 保険情報に法別12 (生活保護) を登録してください`,
      );
    }
    if (hasKohi && !u.kohiFutanshaNumber?.trim()) {
      warnings.push(`${u.userName}: 公費 (法別${u.kohiHobetsu?.trim() || "12"}) の負担者番号が未登録です${u.kohiTandoku ? " (生活保護単独は必須)" : ""}`);
    }
    if (u.kohiTandoku && !u.kohiJukyushaNumber?.trim()) {
      warnings.push(`${u.userName}: 公費受給者番号が未登録です (生活保護単独は必須)`);
    }

    dataParts.push([
      "8121", // 1
      office, // 2 事業所番号
      "1", // 3 指定/基準該当等事業所区分コード
      ym, // 4 サービス提供年月
      u.insurerNumber ? u.insurerNumber.trim().padStart(8, "0") : "", // 5 証記載保険者番号 (数字8桁・前0埋め)
      String(unitPrice100), // 6 単位数単価
      u.insuredNumber, // 7 被保険者番号 (英数10 — H番号可)
      // 8-9 公費負担者番号/受給者番号 — 仕様書: 生活保護単独の場合必須。
      //   併用 (振替 0 円) 時も記載する (様式第七の記載例準拠)。
      //   ※ 8121 には 7131 のような公費分単位数の独立項目は無い (全18項目、仕様書確認済)。
      hasKohi ? u.kohiFutanshaNumber?.trim() ?? "" : "", // 8 公費負担者番号
      hasKohi ? u.kohiJukyushaNumber?.trim() ?? "" : "", // 9 公費受給者番号
      dateNum(u.birthDate), // 10 被保険者生年月日
      genderCode(u.gender), // 11 性別コード
      // ⚠ 要取込チェック: 仕様書の ※5「被保険者でない生活保護受給者の場合は設定不要」が
      //    どの項目 (要介護状態区分/認定有効期間) に掛かるかレイアウト上不明確。
      //    ここでは H番号者も福祉事務所の要介護認定情報をそのまま設定する。
      careCode, // 12 要介護状態区分コード
      dateNum(u.certStart), // 13 認定有効期間 (開始)
      dateNum(u.certEnd), // 14 認定有効期間 (終了)
      dateNum(u.requestDate ?? u.certStart), // 15 計画作成依頼届出年月日
      u.serviceCode, // 16 サービスコード
      String(u.units), // 17 単位数
      // 18 請求金額 — 公費単独は全額が公費請求となるが、金額自体は同じ 10 割額。
      //    (保険/公費の別は 7111 側の区分コードで表現される)
      String(amountOf(u)), // 18 請求金額
    ]);
  }

  // ⚠ コントロールレコード項11 (処理対象年月) は「審査を実行する年月」=提出月
  //   (_if_kyotaku.txt 注1: 2000年4月提供分を5月審査なら "200005")。
  return { ...assemble(dataParts, "711", office, shoriYmOf(opts), `S${ym}.CSV`), warnings };
}
