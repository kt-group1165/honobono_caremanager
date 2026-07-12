/**
 * 国保連 → 事業所 通知ファイル (審査結果・返戻・支払通知) のパーサ
 *
 * 対応する交換情報識別番号:
 *   - 7411: 請求明細書・給付管理票返戻（保留）一覧表情報
 *       レイアウト根拠: migrations/_if_kyotaku.txt L9102-9358 (居宅版・明細13項目)
 *                       migrations/_if_svc.txt     L18420-18668 (サービス事業所版・明細14項目
 *                       = 内容210byte/備考8byte + 項14 サービス項目コード等)
 *   - 7511/7513: 介護給付費(等)支払決定額通知書情報
 *       レイアウト根拠: _if_kyotaku.txt L9430-9624 (7511・20項目)
 *                       _if_svc.txt     L19107-19318 (7513・22項目 = +総合事業費支払額/電子証明書発行手数料)
 *   - 7521: 介護給付費支払決定額内訳書情報 (H1/D1/T1/T2/T3)
 *       レイアウト根拠: _if_kyotaku.txt L9710-10335 / _if_svc.txt L19405-20142
 *   - 7211: 介護保険審査決定増減表情報 (増減単位数（返戻）通知情報)
 *       レイアウト根拠: _if_kyotaku.txt L8448-8843 / _if_svc.txt L16553-16957
 *
 * ファイル構造 (伝送共通 / _if_kyotaku.txt L11337-11630):
 *   1行目   コントロールレコード: 1,連番,ボリューム通番,レコード件数,データ種別(3桁),福祉事務所特定番号,
 *                                 保険者番号,事業所番号,都道府県番号,媒体区分,処理対象年月,ファイル管理番号
 *   2行目〜 データレコード      : 2,連番,交換情報識別番号,帳票レコード種別(H1/D1/T1...),項目...
 *   最終行  エンドレコード      : 3,連番
 *   各レコードは可変長 CSV・CRLF 区切り・Shift_JIS (_if_kyotaku.txt L13408-13412)
 *
 * ⚠ 実ファイル未検証:
 *   本パーサはインタフェース仕様書 (上記行番号) のみを根拠に実装しており、国保連からの
 *   実ファイルではまだ検証していない。初回の実ファイル取込時に必ず列位置 (特に 7411 明細の
 *   13/14 項目差・7511/7513 の項目数差・符号付き数値の表現) をプレビュー画面で確認すること。
 */

import Encoding from "encoding-japanese";

/* ══════════════════════ 型 ══════════════════════ */

export type NoticeKind =
  | "henrei" // 7411 返戻（保留）一覧
  | "shiharai_kettei" // 7511/7513 支払決定額通知書
  | "shiharai_uchiwake" // 7521 支払決定額内訳書
  | "zougen" // 7211 審査決定増減表
  | "unknown"; // 未対応種別

/** コントロールレコード (レコード種別 1) */
export interface ControlInfo {
  /** データ種別 3桁 (交換情報識別番号の上3桁: 741/751/752/721 等) */
  dataType: string;
  /** 事業所番号 (送付先が事業所の場合。それ以外は "0") */
  officeNumber: string;
  /** 保険者番号 (送付先が保険者の場合。それ以外は "0") */
  insurerNumber: string;
  /** 媒体区分 (1=伝送 等) */
  mediaKubun: string;
  /** 処理対象年月 "YYYY-MM" */
  processYm: string | null;
  /** データレコード件数 (コントロール/エンド除く) */
  recordCount: number | null;
}

/** 7411 ヘッダ (H1) — _if_kyotaku.txt L9104-9187 */
export interface HenreiHeader {
  rowIndex: number;
  officeNumber: string; // 項3 事業所番号 (返戻対象の事業所)
  officeName: string; // 項4 事業所名
  shinsaYm: string | null; // 項5 審査年月 "YYYY-MM"
  createdDate: string; // 項6 作成年月日 YYYYMMDD
  kokuhoName: string; // 項8 国保連合会名
}

/** 7411 明細 (D1) — _if_kyotaku.txt L9197-9341 / _if_svc.txt L18507-18668 */
export interface HenreiRow {
  rowIndex: number;
  insurerNumber: string; // 項3 保険者番号 (証記載保険者番号又は公費負担者番号)
  insurerName: string; // 項4 保険者名
  insuredNumber: string; // 項5 被保険者番号
  kanaName: string; // 項6 被保険者カナ氏名 (半角カナ)
  shubetsu: string; // 項7 種別: サ=サービス計画費明細 / 請=請求明細書 / 給=給付管理票
  serviceYm: string | null; // 項8 サービス提供年月 "YYYY-MM"
  serviceKindCode: string; // 項9 サービス種類コード (2桁)
  tanisu: number | null; // 項10 単位数 (符号付き)
  jiyuCode: string; // 項11 事由 (A-E: A=一次チェック / B=資格チェック / C=突合・査定 / D=給付管理票未提出 / E=却下)
  jiyuNaiyo: string; // 項12 内容 (返戻事由の内容。svc 版はエラーコードを含む)
  biko: string; // 項13 備考 (保留区分が「保留」のとき「保留」)
  serviceItemCode: string | null; // 項14 サービス項目コード等 (svc 版のみ)
}

/** 7511/7513 支払決定額通知書 (H1 単一レコード) — _if_kyotaku.txt L9430-9624 / _if_svc.txt L19107-19318 */
export interface ShiharaiKettei {
  rowIndex: number;
  exchangeNumber: string; // "7511" (居宅版) / "7513" (サービス事業所版)
  shinsaYm: string | null; // 項3 審査年月 "YYYY-MM"
  zipcode: string; // 項4+5 郵便番号
  address: string; // 項6 住所
  officeName: string; // 項7 事業所名
  kaisetsusha: string; // 項8 開設者氏名
  officeNumber: string; // 項9 事業所番号
  furikomiAmount: number | null; // 項10 振込金額 (支払決定金額)
  kaigoKyufuhiAmount: number | null; // 項11 介護給付費支払額
  shujiiIkensho: number | null; // 項12 主治医意見書作成料
  shujiiIkenshoTax: number | null; // 項13 同 消費税
  ninteiChousa: number | null; // 項14 認定調査費委託料
  ninteiChousaTax: number | null; // 項15 同 消費税
  sougouJigyouhi: number | null; // 7513 項16 総合事業費支払額 (7511 には無い)
  denshiShoumeisho: number | null; // 7513 項17 電子証明書発行手数料 (7511 には無い)
  goukeiAmount: number | null; // 合計金額 (末尾から5番目)
  bankName: string; // 金融機関名
  branchName: string; // 金融機関支店名
  furikomiDate: string; // 作成年月日 = 金融機関への振込日 YYYYMMDD
  kokuhoName: string; // 国保連合会名
}

/** 7521 ヘッダ (H1) — _if_kyotaku.txt L9712-9793 */
export interface UchiwakeHeader {
  rowIndex: number;
  officeNumber: string;
  officeName: string;
  shinsaYm: string | null;
  createdDate: string;
  kokuhoName: string;
}

/** 7521 明細 (D1) — _if_kyotaku.txt L9805-9961 */
export interface UchiwakeRow {
  rowIndex: number;
  insurerNumber: string; // 項3 証記載保険者番号（公費負担者） 8桁
  serviceYm: string | null; // 項4 サービス提供年月 "YYYY-MM"
  serviceKindCode: string; // 項5 サービス種類コード
  serviceKindName: string; // 項6 サービス種類名
  kensu: number | null; // 項7 介護サービス件数
  nissu: number | null; // 項8 介護サービス日数
  tanisu: number | null; // 項9 介護サービス単位数
  kingaku: number | null; // 項10 介護サービス金額
  kyufuhi: number | null; // 項11 介護給付費 (保険者負担金額)
  shokujiKensu: number | null; // 項12 食事提供件数 (H17.10以降は特定入所者)
  shokujiKaisu: number | null; // 項13 食事提供回数
  shokujihi: number | null; // 項14 食事提供費
  shokujiKyufuhi: number | null; // 項15 介護給付費（食事提供費負担額）
}

/** 7211 増減表の 1 グループ (件数・単位数) */
export interface ZougenGroup {
  kensuKaigo: number | null; // 件数（介護）
  kensuShokuji: number | null; // 件数（食事 / H17.10以降は特定入所者介護等）
  tanisuKaigo: number | null; // 単位数（介護）
  shokujihi: number | null; // 食事提供費 / 特定入所者介護サービス費等
}

/** 7211 明細 (D1) — _if_kyotaku.txt L8539-8739 / _if_svc.txt L16660-16924 */
export interface ZougenRow {
  rowIndex: number;
  insurerNumber: string; // 項3 保険者番号 (8桁)
  serviceYm: string | null; // 項4 サービス提供年月 "YYYY-MM"
  henrei: ZougenGroup; // 項5-8 返戻
  satei: ZougenGroup; // 項9-12 査定増減
  horyu: ZougenGroup; // 項13-16 保留分
  horyuFukkatsu: ZougenGroup; // 項17-20 保留復活分
}

/** 7211 ヘッダ (H1) — _if_kyotaku.txt L8452-8528 */
export interface ZougenHeader {
  rowIndex: number;
  officeNumber: string;
  officeName: string;
  shinsaYm: string | null;
  createdDate: string;
  kokuhoName: string;
}

/** 汎用: 1 データレコード (raw 保存・監査用) */
export interface RawDataRecord {
  rowIndex: number; // レコード番号 (連番)
  exchangeNumber: string; // 交換情報識別番号
  recordKind: string; // 帳票レコード種別 (H1/D1/T1/T2/T3...)
  noticeKind: NoticeKind;
  fields: string[]; // 交換情報識別番号以降の全フィールド (raw)
}

export interface UnsupportedSummary {
  exchangeNumber: string;
  count: number;
}

export interface ParsedNoticeFile {
  fileName: string;
  control: ControlInfo | null;
  /** 全データレコード raw (未対応種別含む) */
  rawRecords: RawDataRecord[];
  henreiHeaders: HenreiHeader[];
  henreiRows: HenreiRow[];
  shiharaiKettei: ShiharaiKettei[];
  uchiwakeHeaders: UchiwakeHeader[];
  uchiwakeRows: UchiwakeRow[];
  uchiwakeTrailers: RawDataRecord[]; // T1/T2/T3 は raw のまま保持
  zougenHeaders: ZougenHeader[];
  zougenRows: ZougenRow[];
  zougenTrailers: RawDataRecord[];
  unsupported: UnsupportedSummary[];
  /** ファイル全体の審査年月 (ヘッダ優先 → コントロール処理対象年月) "YYYY-MM" */
  shinsaYm: string | null;
  /** ヘッダ/通知書の事業所番号 (自事業所チェック用) */
  headerOfficeNumber: string | null;
  warnings: string[];
}

/* ══════════════════════ ヘルパ ══════════════════════ */

/** Shift_JIS バイト列 → Unicode 文字列 */
export function decodeNoticeSjis(bytes: Uint8Array): string {
  return Encoding.convert(bytes, {
    to: "UNICODE",
    from: "SJIS",
    type: "string",
  }) as string;
}

/** "YYYYMM" → "YYYY-MM" (それ以外は null) */
export function ymToKey(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!/^\d{6}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}

/** 数値項目 (符号付き対応)。空・非数値は null */
export function num(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

const trim = (v: string | undefined): string => (v ?? "").trim();

function noticeKindOf(exchangeNumber: string): NoticeKind {
  if (exchangeNumber === "7411") return "henrei";
  // 7511=居宅版 / 7513=サービス事業所版 (どちらも支払決定額通知書)
  if (exchangeNumber === "7511" || exchangeNumber === "7513") return "shiharai_kettei";
  if (exchangeNumber === "7521") return "shiharai_uchiwake";
  if (exchangeNumber === "7211") return "zougen";
  return "unknown";
}

export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  henrei: "返戻（保留）一覧表 (7411)",
  shiharai_kettei: "支払決定額通知書 (7511/7513)",
  shiharai_uchiwake: "支払決定額内訳書 (7521)",
  zougen: "審査決定増減表 (7211)",
  unknown: "未対応種別",
};

/** 返戻事由コードの説明 (_if_kyotaku.txt L9324-9336) */
export const HENREI_JIYU_LABEL: Record<string, string> = {
  A: "一次チェックエラー",
  B: "受給者・事業所の資格チェックエラー",
  C: "給付管理票との突合不一致・査定エラー",
  D: "給付管理票が未提出",
  E: "審査委員会判定/時効により却下",
};

/* ══════════════════════ 本体 ══════════════════════ */

/**
 * 通知ファイル (Unicode 変換済みテキスト) をパースする。
 * Shift_JIS バイト列からは decodeNoticeSjis() を通してから渡す。
 */
export function parseNoticeFileText(text: string, fileName: string): ParsedNoticeFile {
  const out: ParsedNoticeFile = {
    fileName,
    control: null,
    rawRecords: [],
    henreiHeaders: [],
    henreiRows: [],
    shiharaiKettei: [],
    uchiwakeHeaders: [],
    uchiwakeRows: [],
    uchiwakeTrailers: [],
    zougenHeaders: [],
    zougenRows: [],
    zougenTrailers: [],
    unsupported: [],
    shinsaYm: null,
    headerOfficeNumber: null,
    warnings: [],
  };
  const unsupportedCount = new Map<string, number>();
  let sawEnd = false;

  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    out.warnings.push("空のファイルです");
    return out;
  }

  for (const line of lines) {
    // 仕様上、項目値にカンマ・引用符は現れない前提の単純 split (可変長 CSV)
    const cols = line.split(",");
    const recType = trim(cols[0]);

    if (recType === "1") {
      // コントロールレコード: 1,連番,ボリューム通番,件数,データ種別,福祉,保険者,事業所,都道府県,媒体,処理対象年月,管理番号
      if (out.control) out.warnings.push("コントロールレコードが複数あります");
      out.control = {
        recordCount: num(cols[3]),
        dataType: trim(cols[4]),
        insurerNumber: trim(cols[6]),
        officeNumber: trim(cols[7]),
        mediaKubun: trim(cols[9]),
        processYm: ymToKey(cols[10]),
      };
      continue;
    }
    if (recType === "3") {
      sawEnd = true;
      continue;
    }
    if (recType !== "2") {
      out.warnings.push(`不明なレコード種別 "${recType}" の行をスキップしました`);
      continue;
    }

    // データレコード: 2,連番,交換情報識別番号,帳票レコード種別,...
    const rowIndex = num(cols[1]) ?? out.rawRecords.length + 2;
    const fields = cols.slice(2).map((c) => c.trim());
    const exchangeNumber = trim(fields[0]);
    const recordKind = trim(fields[1]);
    const noticeKind = noticeKindOf(exchangeNumber);
    const raw: RawDataRecord = { rowIndex, exchangeNumber, recordKind, noticeKind, fields };
    out.rawRecords.push(raw);

    switch (noticeKind) {
      case "henrei": {
        if (recordKind === "H1") {
          // 項3 事業所番号 / 項4 事業所名 / 項5 審査年月 / 項6 作成年月日 / 項7 頁 / 項8 国保連合会名
          out.henreiHeaders.push({
            rowIndex,
            officeNumber: trim(fields[2]),
            officeName: trim(fields[3]),
            shinsaYm: ymToKey(fields[4]),
            createdDate: trim(fields[5]),
            kokuhoName: trim(fields[7]),
          });
        } else if (recordKind === "D1") {
          // 居宅版 13 項目 / サービス事業所版 14 項目 (項14 サービス項目コード等)
          if (fields.length < 13) {
            out.warnings.push(
              `7411 明細 (行${rowIndex}) の項目数が ${fields.length} で仕様 (13/14) より少ないため一部項目が欠落している可能性があります`,
            );
          }
          out.henreiRows.push({
            rowIndex,
            insurerNumber: trim(fields[2]),
            insurerName: trim(fields[3]),
            insuredNumber: trim(fields[4]),
            kanaName: trim(fields[5]),
            shubetsu: trim(fields[6]),
            serviceYm: ymToKey(fields[7]),
            serviceKindCode: trim(fields[8]),
            tanisu: num(fields[9]),
            jiyuCode: trim(fields[10]),
            jiyuNaiyo: trim(fields[11]),
            biko: trim(fields[12]),
            serviceItemCode: fields.length >= 14 ? trim(fields[13]) : null,
          });
        } else {
          out.warnings.push(`7411 の未知の帳票レコード種別 "${recordKind}" (行${rowIndex})`);
        }
        break;
      }
      case "shiharai_kettei": {
        // 単一レコード (帳票レコード種別 "H1")。7511=20項目 / 7513=22項目。
        // 末尾 5 項目 (合計金額/金融機関名/支店名/作成年月日/国保連合会名) は後方から取る
        // ことで項目数差 (総合事業費・電子証明書手数料の有無) に頑健にする。
        const n = fields.length;
        if (n < 20) {
          out.warnings.push(
            `${exchangeNumber} 支払決定額通知書 (行${rowIndex}) の項目数が ${n} で仕様 (20/22) より少ないため取込内容を必ず確認してください`,
          );
        }
        const is7513Layout = n >= 22;
        out.shiharaiKettei.push({
          rowIndex,
          exchangeNumber,
          shinsaYm: ymToKey(fields[2]),
          zipcode: `${trim(fields[3])}${trim(fields[4]) ? "-" + trim(fields[4]) : ""}`,
          address: trim(fields[5]),
          officeName: trim(fields[6]),
          kaisetsusha: trim(fields[7]),
          officeNumber: trim(fields[8]),
          furikomiAmount: num(fields[9]),
          kaigoKyufuhiAmount: num(fields[10]),
          shujiiIkensho: num(fields[11]),
          shujiiIkenshoTax: num(fields[12]),
          ninteiChousa: num(fields[13]),
          ninteiChousaTax: num(fields[14]),
          sougouJigyouhi: is7513Layout ? num(fields[15]) : null,
          denshiShoumeisho: is7513Layout ? num(fields[16]) : null,
          goukeiAmount: num(fields[n - 5]),
          bankName: trim(fields[n - 4]),
          branchName: trim(fields[n - 3]),
          furikomiDate: trim(fields[n - 2]),
          kokuhoName: trim(fields[n - 1]),
        });
        break;
      }
      case "shiharai_uchiwake": {
        if (recordKind === "H1") {
          out.uchiwakeHeaders.push({
            rowIndex,
            officeNumber: trim(fields[2]),
            officeName: trim(fields[3]),
            shinsaYm: ymToKey(fields[4]),
            createdDate: trim(fields[5]),
            kokuhoName: trim(fields[7]),
          });
        } else if (recordKind === "D1") {
          out.uchiwakeRows.push({
            rowIndex,
            insurerNumber: trim(fields[2]),
            serviceYm: ymToKey(fields[3]),
            serviceKindCode: trim(fields[4]),
            serviceKindName: trim(fields[5]),
            kensu: num(fields[6]),
            nissu: num(fields[7]),
            tanisu: num(fields[8]),
            kingaku: num(fields[9]),
            kyufuhi: num(fields[10]),
            shokujiKensu: num(fields[11]),
            shokujiKaisu: num(fields[12]),
            shokujihi: num(fields[13]),
            shokujiKyufuhi: num(fields[14]),
          });
        } else if (recordKind === "T1" || recordKind === "T2" || recordKind === "T3") {
          // T1=合計 / T2=過誤調整 / T3=支払決定 (合計-過誤調整)。raw 保存のみ
          out.uchiwakeTrailers.push(raw);
        } else {
          out.warnings.push(`7521 の未知の帳票レコード種別 "${recordKind}" (行${rowIndex})`);
        }
        break;
      }
      case "zougen": {
        if (recordKind === "H1") {
          out.zougenHeaders.push({
            rowIndex,
            officeNumber: trim(fields[2]),
            officeName: trim(fields[3]),
            shinsaYm: ymToKey(fields[4]),
            createdDate: trim(fields[5]),
            kokuhoName: trim(fields[7]),
          });
        } else if (recordKind === "D1") {
          // 項5-20: [返戻/査定増減/保留分/保留復活分] × [件数(介護)/件数(食事・特定入所者)/単位数(介護)/食事提供費等]
          const grp = (base: number): ZougenGroup => ({
            kensuKaigo: num(fields[base]),
            kensuShokuji: num(fields[base + 1]),
            tanisuKaigo: num(fields[base + 2]),
            shokujihi: num(fields[base + 3]),
          });
          out.zougenRows.push({
            rowIndex,
            insurerNumber: trim(fields[2]),
            serviceYm: ymToKey(fields[3]),
            henrei: grp(4),
            satei: grp(8),
            horyu: grp(12),
            horyuFukkatsu: grp(16),
          });
        } else if (recordKind.startsWith("T")) {
          out.zougenTrailers.push(raw);
        } else {
          out.warnings.push(`7211 の未知の帳票レコード種別 "${recordKind}" (行${rowIndex})`);
        }
        break;
      }
      case "unknown": {
        unsupportedCount.set(exchangeNumber, (unsupportedCount.get(exchangeNumber) ?? 0) + 1);
        break;
      }
    }
  }

  // ── 集計・整合チェック ──
  if (!out.control) out.warnings.push("コントロールレコード (レコード種別1) がありません");
  if (!sawEnd) out.warnings.push("エンドレコード (レコード種別3) がありません");
  if (out.control?.recordCount != null && out.control.recordCount !== out.rawRecords.length) {
    out.warnings.push(
      `コントロールレコードの件数 (${out.control.recordCount}) とデータレコード数 (${out.rawRecords.length}) が一致しません`,
    );
  }

  out.unsupported = [...unsupportedCount.entries()]
    .map(([exchangeNumber, count]) => ({ exchangeNumber, count }))
    .sort((a, b) => a.exchangeNumber.localeCompare(b.exchangeNumber));

  out.shinsaYm =
    out.henreiHeaders[0]?.shinsaYm ??
    out.shiharaiKettei[0]?.shinsaYm ??
    out.uchiwakeHeaders[0]?.shinsaYm ??
    out.zougenHeaders[0]?.shinsaYm ??
    out.control?.processYm ??
    null;

  out.headerOfficeNumber =
    out.henreiHeaders[0]?.officeNumber ??
    out.shiharaiKettei[0]?.officeNumber ??
    out.uchiwakeHeaders[0]?.officeNumber ??
    out.zougenHeaders[0]?.officeNumber ??
    (out.control && out.control.officeNumber !== "0" ? out.control.officeNumber : null) ??
    null;

  return out;
}
