/**
 * FB データ (全銀協 預金口座振替) 振替結果ファイルのパーサ
 *
 * 全銀協の口座振替フォーマットは「依頼」と「結果返却」が同一レイアウトで、
 * データレコードの「振替結果コード」欄 (依頼時は 0/スペース) に、金融機関が
 * 振替結果 (0=振替済 / 1=資金不足 / 2=取引なし / 3=預金者都合 / 4=依頼書なし /
 * 8=委託者都合 / 9=その他) を書き戻して返却する。
 *
 * ここでは自前の依頼ファイル生成 `fb-zengin.ts` のレイアウト定義を正として、
 * その逆方向 (固定長 120 バイト → 構造体) にパースする。桁位置は
 * buildHeader / buildDataRecord / buildTrailer と同一 (往復整合)。
 *
 * ⚠ 実ファイル未検証: 自前生成の依頼ファイルとの往復 (机上検証) は済んでいるが、
 *   実際の金融機関が返却する結果ファイルでの検証は未実施。銀行・収納代行に
 *   よってはダミー領域の使い方や改行有無が異なる場合があるため、初回取込時は
 *   プレビュー内容を必ず目視確認すること。
 *
 * 前提: Shift_JIS のデコードは呼出側 (encoding-japanese 等) で行い、本モジュール
 * には Unicode 文字列を渡す。全銀の許容文字 (半角カナ・英数字) は Shift_JIS で
 * 1 文字 = 1 バイトなので、デコード後の文字位置 = バイト位置 として扱える。
 */

// ─── 振替結果コード (全銀協 預金口座振替 標準) ───────────────────────────────
export const FB_RESULT_CODE_LABELS: Record<string, string> = {
  "0": "振替済",
  "1": "資金不足",
  "2": "取引なし",
  "3": "預金者都合による振替停止",
  "4": "依頼書なし",
  "8": "委託者都合による振替停止",
  "9": "その他",
};

/** 結果コード → 表示ラベル (未定義コードは「不明 (コード n)」) */
export function fbResultLabel(code: string): string {
  return FB_RESULT_CODE_LABELS[code] ?? `不明 (コード ${code || "空欄"})`;
}

// ─── 型 ──────────────────────────────────────────────────────────────────────

/** ヘッダーレコード (種別 1) のパース結果 */
export interface FbResultHeader {
  /** 種別コード ("91" = 預金口座振替 のはず) */
  typeCode: string;
  /** 委託者コード (10 桁) */
  consignorCode: string;
  /** 委託者名 (半角カナ、trim 済) */
  consignorName: string;
  /** 引落日 "MMDD" */
  transferMMDD: string;
}

/** データレコード (種別 2) 1 明細のパース結果 */
export interface FbResultDetail {
  /** ファイル内の行番号 (1 始まり) */
  line: number;
  /** 引落銀行番号 (4 桁) */
  bankCode: string;
  /** 引落銀行名 (trim 済) */
  bankName: string;
  /** 引落支店番号 (3 桁) */
  branchCode: string;
  /** 引落支店名 (trim 済) */
  branchName: string;
  /** 預金種目 (1=普通 / 2=当座) */
  accountType: string;
  /** 口座番号 (7 桁) */
  accountNumber: string;
  /** 預金者名 (半角カナ、trim 済) */
  accountHolderKana: string;
  /** 引落金額 (円) */
  amount: number;
  /** 新規コード (0=既存 / 1=新規) */
  newCode: string;
  /** 顧客番号 (trim 済)。依頼側は 被保険者番号 or client_id 先頭 20 桁 を入れている */
  customerNumber: string;
  /** 振替結果コード (生値。スペースは "" に正規化) */
  resultCode: string;
  /** 結果コードの表示ラベル */
  resultLabel: string;
  /** true = 振替済 (コード 0) */
  transferred: boolean;
}

/** トレーラレコード (種別 8) のパース結果 */
export interface FbResultTrailer {
  totalCount: number;
  totalAmount: number;
  doneCount: number;
  doneAmount: number;
  failCount: number;
  failAmount: number;
}

export interface FbResultParse {
  header: FbResultHeader | null;
  details: FbResultDetail[];
  trailer: FbResultTrailer | null;
  /** 構造としておかしい点 (取込を止めるべきレベル) */
  errors: string[];
  /** 続行可能だが注意すべき点 (件数不一致・結果コード空欄 等) */
  warnings: string[];
}

// ─── 桁位置ヘルパ ────────────────────────────────────────────────────────────
// fb-zengin.ts の buildXxx と同じ並び順で slice する (0 始まり [start, start+len))

const cut = (line: string, start: number, len: number) =>
  line.slice(start, start + len);

const cutTrim = (line: string, start: number, len: number) =>
  cut(line, start, len).trim();

/** 数字項目 (右詰め 0 埋め) → number。数字以外が混ざれば null */
const cutNum = (line: string, start: number, len: number): number | null => {
  const raw = cut(line, start, len);
  if (!/^[0-9 ]*$/.test(raw)) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  return digits === "" ? 0 : parseInt(digits, 10);
};

// ─── レコード別パース ────────────────────────────────────────────────────────

function parseHeader(line: string): FbResultHeader {
  return {
    typeCode: cut(line, 1, 2), // 種別コード (91)
    consignorCode: cutTrim(line, 4, 10), // 委託者コード (10)
    consignorName: cutTrim(line, 14, 40), // 委託者名 (40)
    transferMMDD: cut(line, 54, 4), // 引落日 MMDD (4)
  };
}

function parseDetail(line: string, lineNo: number, warnings: string[]): FbResultDetail {
  // buildDataRecord の並び:
  // [0]=区分2 [1,5)=銀行番号 [5,20)=銀行名 [20,23)=支店番号 [23,38)=支店名
  // [38,42)=手形交換所番号 [42]=預金種目 [43,50)=口座番号 [50,80)=預金者名
  // [80,90)=引落金額 [90]=新規コード [91,111)=顧客番号 [111]=振替結果コード
  const amount = cutNum(line, 80, 10);
  if (amount === null) {
    warnings.push(`${lineNo} 行目: 引落金額欄に数字以外の文字があります (0 円として扱います)`);
  }
  const resultCode = cut(line, 111, 1).trim(); // スペース → ""
  return {
    line: lineNo,
    bankCode: cutTrim(line, 1, 4),
    bankName: cutTrim(line, 5, 15),
    branchCode: cutTrim(line, 20, 3),
    branchName: cutTrim(line, 23, 15),
    accountType: cut(line, 42, 1),
    accountNumber: cutTrim(line, 43, 7),
    accountHolderKana: cutTrim(line, 50, 30),
    amount: amount ?? 0,
    newCode: cut(line, 90, 1),
    customerNumber: cutTrim(line, 91, 20),
    resultCode,
    resultLabel: fbResultLabel(resultCode),
    transferred: resultCode === "0",
  };
}

function parseTrailer(line: string): FbResultTrailer {
  // buildTrailer の並び:
  // [0]=区分8 [1,7)=合計件数 [7,19)=合計金額 [19,25)=振替済件数 [25,37)=振替済金額
  // [37,43)=振替不能件数 [43,55)=振替不能金額
  return {
    totalCount: cutNum(line, 1, 6) ?? 0,
    totalAmount: cutNum(line, 7, 12) ?? 0,
    doneCount: cutNum(line, 19, 6) ?? 0,
    doneAmount: cutNum(line, 25, 12) ?? 0,
    failCount: cutNum(line, 37, 6) ?? 0,
    failAmount: cutNum(line, 43, 12) ?? 0,
  };
}

// ─── メイン ──────────────────────────────────────────────────────────────────

/**
 * 振替結果ファイル (Shift_JIS デコード済み文字列) をパースする。
 * ヘッダ (1) → データ (2)× n → トレーラ (8) → エンド (9) の順序と
 * トレーラの件数・金額整合を検証する。
 */
export function parseFbZenginResult(content: string): FbResultParse {
  const errors: string[] = [];
  const warnings: string[] = [];
  let header: FbResultHeader | null = null;
  let trailer: FbResultTrailer | null = null;
  const details: FbResultDetail[] = [];
  let endSeen = false;

  // CRLF / LF どちらも許容。末尾の空行は無視
  const lines = content.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { header: null, details: [], trailer: null, errors: ["ファイルが空です"], warnings };
  }

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.length !== 120) {
      warnings.push(
        `${lineNo} 行目: レコード長が 120 バイトではありません (${line.length} バイト)。` +
          `固定長フォーマットと桁位置がずれている可能性があります`,
      );
    }
    const kind = line[0];
    if (kind === "1") {
      if (header) errors.push(`${lineNo} 行目: ヘッダーレコードが複数あります`);
      else {
        header = parseHeader(line);
        if (header.typeCode !== "91") {
          warnings.push(
            `ヘッダーの種別コードが "91" (預金口座振替) ではありません (実際: "${header.typeCode}")`,
          );
        }
      }
    } else if (kind === "2") {
      if (endSeen || trailer) {
        errors.push(`${lineNo} 行目: トレーラ/エンドの後にデータレコードがあります`);
      }
      details.push(parseDetail(line, lineNo, warnings));
    } else if (kind === "8") {
      if (trailer) errors.push(`${lineNo} 行目: トレーラレコードが複数あります`);
      else trailer = parseTrailer(line);
    } else if (kind === "9") {
      endSeen = true;
    } else {
      errors.push(`${lineNo} 行目: 不明なデータ区分 "${kind ?? ""}" です`);
    }
  });

  if (!header) errors.push("ヘッダーレコード (データ区分 1) がありません");
  if (!trailer) warnings.push("トレーラレコード (データ区分 8) がありません (件数照合をスキップ)");
  if (!endSeen) warnings.push("エンドレコード (データ区分 9) がありません");
  if (details.length === 0) errors.push("データレコード (データ区分 2) が 1 件もありません");

  // ── トレーラ照合 ──
  const t = trailer as FbResultTrailer | null;
  if (t) {
    const sumAmount = details.reduce((s, d) => s + d.amount, 0);
    if (t.totalCount !== details.length) {
      warnings.push(
        `トレーラの合計件数 (${t.totalCount}) とデータレコード数 (${details.length}) が一致しません`,
      );
    }
    if (t.totalAmount !== sumAmount) {
      warnings.push(
        `トレーラの合計金額 (¥${t.totalAmount.toLocaleString()}) と明細合計 (¥${sumAmount.toLocaleString()}) が一致しません`,
      );
    }
    const doneCount = details.filter((d) => d.transferred).length;
    const failCount = details.filter((d) => !d.transferred).length;
    // 依頼ファイルは 振替済/不能 件数が 0 のまま (fb-zengin.ts も 0 で出力する)。
    // 結果ファイルなら通常ここに件数が入るので、全て 0 なら依頼ファイル疑い。
    if (t.doneCount === 0 && t.failCount === 0 && details.length > 0) {
      warnings.push(
        "トレーラの振替済/振替不能件数がどちらも 0 です。結果が書き戻される前の" +
          "「依頼ファイル」を取り込もうとしている可能性があります (明細の結果コードを確認してください)",
      );
    } else {
      if (t.doneCount !== doneCount) {
        warnings.push(
          `トレーラの振替済件数 (${t.doneCount}) と明細の振替済 (コード0) 件数 (${doneCount}) が一致しません`,
        );
      }
      if (t.failCount !== failCount) {
        warnings.push(
          `トレーラの振替不能件数 (${t.failCount}) と明細の振替不能件数 (${failCount}) が一致しません`,
        );
      }
    }
  }

  // 結果コードが空欄の明細 (依頼ファイル or 未処理) の注意
  const blankCodes = details.filter((d) => d.resultCode === "").length;
  if (blankCodes > 0) {
    warnings.push(
      `振替結果コードが空欄の明細が ${blankCodes} 件あります (未処理扱い = 振替不能側に分類します)`,
    );
  }

  return { header, details, trailer, errors, warnings };
}
