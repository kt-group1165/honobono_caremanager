/**
 * FB データ (全銀協 預金口座振替 依頼明細ファイル) 生成
 *
 * 銀行に渡す「口座振替 (自動引落) 依頼」の固定長テキストを組み立てる。
 * 仕様 (全国銀行協会 標準フォーマット・預金口座振替):
 *   - 1 レコード = 120 バイト固定長
 *   - 文字コード: Shift_JIS / カナは半角
 *   - レコード種別:
 *       1 = ヘッダーレコード (委託者情報 + 引落日)
 *       2 = データレコード   (引落先 1 件 = 1 レコード)
 *       8 = トレーラレコード (合計件数・合計金額)
 *       9 = エンドレコード
 *   - 数字項目: 右詰め 0 埋め / カナ・英数字項目: 左詰め 半角スペース埋め
 *
 * 未保持の項目 (仕向/引落の銀行番号・支店番号・委託者コード等) は空欄
 * (数字は 0 埋め / カナは空白埋め) とし、warnings 配列で不足を報告する。
 * → 伝送前に「何が未設定か」を画面で気づけるようにするのが狙い。
 */

// ─── 半角カナ変換 ────────────────────────────────────────────────────────────
// 全銀フォーマットのカナ項目は「半角カナ」。DB のカナ (全角) を半角へ寄せる。

const ZEN_KANA_TO_HAN: Record<string, string> = {
  ガ: "ｶﾞ", ギ: "ｷﾞ", グ: "ｸﾞ", ゲ: "ｹﾞ", ゴ: "ｺﾞ",
  ザ: "ｻﾞ", ジ: "ｼﾞ", ズ: "ｽﾞ", ゼ: "ｾﾞ", ゾ: "ｿﾞ",
  ダ: "ﾀﾞ", ヂ: "ﾁﾞ", ヅ: "ﾂﾞ", デ: "ﾃﾞ", ド: "ﾄﾞ",
  バ: "ﾊﾞ", ビ: "ﾋﾞ", ブ: "ﾌﾞ", ベ: "ﾍﾞ", ボ: "ﾎﾞ",
  パ: "ﾊﾟ", ピ: "ﾋﾟ", プ: "ﾌﾟ", ペ: "ﾍﾟ", ポ: "ﾎﾟ",
  ヴ: "ｳﾞ",
  ア: "ｱ", イ: "ｲ", ウ: "ｳ", エ: "ｴ", オ: "ｵ",
  カ: "ｶ", キ: "ｷ", ク: "ｸ", ケ: "ｹ", コ: "ｺ",
  サ: "ｻ", シ: "ｼ", ス: "ｽ", セ: "ｾ", ソ: "ｿ",
  タ: "ﾀ", チ: "ﾁ", ツ: "ﾂ", テ: "ﾃ", ト: "ﾄ",
  ナ: "ﾅ", ニ: "ﾆ", ヌ: "ﾇ", ネ: "ﾈ", ノ: "ﾉ",
  ハ: "ﾊ", ヒ: "ﾋ", フ: "ﾌ", ヘ: "ﾍ", ホ: "ﾎ",
  マ: "ﾏ", ミ: "ﾐ", ム: "ﾑ", メ: "ﾒ", モ: "ﾓ",
  ヤ: "ﾔ", ユ: "ﾕ", ヨ: "ﾖ",
  ラ: "ﾗ", リ: "ﾘ", ル: "ﾙ", レ: "ﾚ", ロ: "ﾛ",
  ワ: "ﾜ", ヲ: "ｦ", ン: "ﾝ",
  ァ: "ｱ", ィ: "ｲ", ゥ: "ｳ", ェ: "ｴ", ォ: "ｵ",
  ャ: "ﾔ", ュ: "ﾕ", ョ: "ﾖ", ッ: "ﾂ",
  ー: "ｰ", "・": "･", "　": " ", "、": "､", "。": "｡",
};

/**
 * 文字列を半角カナ (英大文字・数字・記号は許容) へ正規化する。
 * - ひらがな → カタカナ → 半角カナ
 * - 全角英数字 → 半角
 * - 全銀で許可されない文字は半角スペースへ落とす
 */
export function toHankakuKana(input: string | null | undefined): string {
  if (!input) return "";
  let out = "";
  for (const ch of input) {
    // ひらがな → カタカナ (U+3041〜U+3096)
    const code = ch.codePointAt(0)!;
    let c = ch;
    if (code >= 0x3041 && code <= 0x3096) {
      c = String.fromCodePoint(code + 0x60);
    }
    if (ZEN_KANA_TO_HAN[c] !== undefined) {
      out += ZEN_KANA_TO_HAN[c];
      continue;
    }
    // 全角英数字 → 半角
    if (code >= 0xff10 && code <= 0xff5a) {
      out += String.fromCharCode(code - 0xfee0);
      continue;
    }
    // 既に半角英数字・半角カナ・許可記号はそのまま
    if (
      (code >= 0x20 && code <= 0x7e) || // ASCII
      (code >= 0xff61 && code <= 0xff9f) // 半角カナ
    ) {
      out += ch === " " ? " " : ch;
      continue;
    }
    // それ以外 (漢字等) は半角スペースに落とす (全銀はカナのみ許容)
    out += " ";
  }
  return out.toUpperCase();
}

// ─── パディング ──────────────────────────────────────────────────────────────
// 半角カナは Shift_JIS では 1 バイト/文字のため、ここでは「文字数 = バイト数」
// として桁揃えする (全角文字は toHankakuKana で除去済みの前提)。

/** 英数字・カナ項目: 左詰め 半角スペース埋め (超過は末尾切り詰め) */
function padAlnum(value: string | null | undefined, len: number): string {
  const s = (value ?? "").toString();
  if (s.length > len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
}

/** 数字項目: 右詰め 0 埋め (数字以外は除去、超過は下位桁を残す) */
function padNum(value: string | number | null | undefined, len: number): string {
  if (value === null || value === undefined || value === "") {
    return "0".repeat(len);
  }
  const s = String(value).replace(/[^0-9]/g, "");
  if (s.length > len) return s.slice(-len);
  return s.padStart(len, "0");
}

// ─── 型 ──────────────────────────────────────────────────────────────────────

/** 引落先 1 件 (= データレコード 1 行) */
export interface FbTransferTarget {
  /** 顧客識別 (利用者番号や client_id 等)。顧客番号欄に入る */
  customerNumber: string | null;
  /** 預金者名 (カナ)。全角なら内部で半角カナへ変換 */
  accountHolderKana: string | null;
  /** 引落先 銀行番号 (4桁)。未保持なら null → 0 埋め + warning */
  bankCode: string | null;
  /** 引落先 支店番号 (3桁)。未保持なら null → 0 埋め + warning */
  branchCode: string | null;
  /** 銀行名 (カナ・任意) */
  bankName: string | null;
  /** 支店名 (カナ・任意) */
  branchName: string | null;
  /** 預金種目 (普通/当座 の文字 or 1/2)。既定 1(普通) */
  accountType: string | null;
  /** 口座番号 (7桁) */
  accountNumber: string | null;
  /** 引落金額 (円) */
  amount: number;
}

/** 委託者 (自事業所) 情報 = ヘッダーレコード */
export interface FbConsignor {
  /** 委託者コード (10桁)。銀行から付与。未設定なら null → 0 埋め + warning */
  consignorCode: string | null;
  /** 委託者名 (カナ・40桁) */
  consignorNameKana: string | null;
  /** 引落日 (1-31)。MMDD の DD に入る (MM は対象月) */
  transferDay: number;
  /** 対象年 (西暦) */
  year: number;
  /** 対象月 (1-12) */
  month: number;
  /** 仕向 (委託者側) 銀行番号 (4桁・任意) */
  consignorBankCode?: string | null;
  /** 仕向 銀行名 (カナ・任意) */
  consignorBankName?: string | null;
  /** 仕向 支店番号 (3桁・任意) */
  consignorBranchCode?: string | null;
  /** 仕向 支店名 (カナ・任意) */
  consignorBranchName?: string | null;
  /** 仕向 預金種目 (1普通/2当座・任意) */
  consignorAccountType?: string | null;
  /** 仕向 口座番号 (7桁・任意) */
  consignorAccountNumber?: string | null;
}

export interface FbBuildResult {
  /** レコードを CRLF で結合したテキスト (Shift_JIS 変換前の Unicode 文字列) */
  content: string;
  /** 出力ファイル名 */
  fileName: string;
  /** データレコード件数 */
  count: number;
  /** 合計金額 (円) */
  totalAmount: number;
  /** 未設定・不足項目の警告 (伝送前チェック用) */
  warnings: string[];
}

// ─── 預金種目コード ──────────────────────────────────────────────────────────
function accountTypeCode(v: string | null | undefined): string {
  const s = (v ?? "").toString().trim();
  if (s === "2" || s.includes("当座")) return "2";
  // 既定は普通 (1)。"1"/"普通"/未設定 すべて 1
  return "1";
}

// ─── レコード生成 ────────────────────────────────────────────────────────────

/** ヘッダーレコード (種別 1) — 全 120 バイト */
function buildHeader(c: FbConsignor): string {
  const mmdd =
    String(c.month).padStart(2, "0") + String(Math.max(1, c.transferDay)).padStart(2, "0");
  // 1(データ区分) 91(種別:引落) 0(コード区分JIS) ...
  let rec = "";
  rec += "1"; // データ区分 (1=ヘッダー)
  rec += "91"; // 種別コード (91=預金口座振替/引落)
  rec += "0"; // コード区分 (0=JIS)
  rec += padNum(c.consignorCode, 10); // 委託者コード (10)
  rec += padAlnum(toHankakuKana(c.consignorNameKana), 40); // 委託者名 (40)
  rec += mmdd; // 引落日 MMDD (4)
  rec += padNum(c.consignorBankCode, 4); // 仕向銀行番号 (4)
  rec += padAlnum(toHankakuKana(c.consignorBankName), 15); // 仕向銀行名 (15)
  rec += padNum(c.consignorBranchCode, 3); // 仕向支店番号 (3)
  rec += padAlnum(toHankakuKana(c.consignorBranchName), 15); // 仕向支店名 (15)
  rec += accountTypeCode(c.consignorAccountType); // 預金種目 (1)
  rec += padNum(c.consignorAccountNumber, 7); // 口座番号 (7)
  // ここまで 1+2+1+10+40+4+4+15+3+15+1+7 = 103 バイト → ダミー 17 で 120
  rec += padAlnum("", 120 - rec.length); // ダミー
  return rec.slice(0, 120);
}

/** データレコード (種別 2) — 全 120 バイト */
function buildDataRecord(t: FbTransferTarget): string {
  let rec = "";
  rec += "2"; // データ区分 (2=データ)
  rec += padNum(t.bankCode, 4); // 引落銀行番号 (4)
  rec += padAlnum(toHankakuKana(t.bankName), 15); // 引落銀行名 (15)
  rec += padNum(t.branchCode, 3); // 引落支店番号 (3)
  rec += padAlnum(toHankakuKana(t.branchName), 15); // 引落支店名 (15)
  rec += padAlnum("", 4); // 手形交換所番号 (4・未使用)
  rec += accountTypeCode(t.accountType); // 預金種目 (1)
  rec += padNum(t.accountNumber, 7); // 口座番号 (7)
  rec += padAlnum(toHankakuKana(t.accountHolderKana), 30); // 預金者名 (30)
  rec += padNum(Math.max(0, Math.round(t.amount)), 10); // 引落金額 (10)
  rec += "0"; // 新規コード (0=既存/1=新規, 既定 0)
  rec += padAlnum(t.customerNumber ?? "", 20); // 顧客番号 (20)
  rec += "0"; // 振替結果コード (0=未処理)
  // 1+4+15+3+15+4+1+7+30+10+1+20+1 = 112 → ダミー 8 で 120
  rec += padAlnum("", 120 - rec.length); // ダミー
  return rec.slice(0, 120);
}

/** トレーラレコード (種別 8) — 全 120 バイト */
function buildTrailer(count: number, totalAmount: number): string {
  let rec = "";
  rec += "8"; // データ区分 (8=トレーラ)
  rec += padNum(count, 6); // 合計件数 (6)
  rec += padNum(totalAmount, 12); // 合計金額 (12)
  rec += padNum(0, 6); // 振替済件数 (6・0)
  rec += padNum(0, 12); // 振替済金額 (12・0)
  rec += padNum(0, 6); // 振替不能件数 (6・0)
  rec += padNum(0, 12); // 振替不能金額 (12・0)
  rec += padAlnum("", 120 - rec.length); // ダミー
  return rec.slice(0, 120);
}

/** エンドレコード (種別 9) — 全 120 バイト */
function buildEnd(): string {
  let rec = "9"; // データ区分 (9=エンド)
  rec += padAlnum("", 120 - rec.length); // ダミー
  return rec.slice(0, 120);
}

// ─── メイン ──────────────────────────────────────────────────────────────────

/**
 * 全銀協 口座振替 (引落) の FB データを生成する。
 * @param targets 引落先一覧 (金額 0 以下は自動除外)
 * @param consignor 委託者 (自事業所) 情報 + 引落日
 */
export function buildFbZengin(
  targets: FbTransferTarget[],
  consignor: FbConsignor,
): FbBuildResult {
  const warnings: string[] = [];

  // 委託者側の未設定チェック
  if (!consignor.consignorCode?.trim()) {
    warnings.push("委託者コード (10桁) が未設定です");
  }
  if (!toHankakuKana(consignor.consignorNameKana).trim()) {
    warnings.push("委託者名 (カナ) が未設定です");
  }

  // 金額 0 以下は引落対象外
  const valid = targets.filter((t) => Math.round(t.amount) > 0);
  const skippedZero = targets.length - valid.length;
  if (skippedZero > 0) {
    warnings.push(`引落金額 0 円の ${skippedZero} 件を除外しました`);
  }

  // 引落先ごとの必須項目チェック (未保持は空欄で出力するが警告する)
  let missingBank = 0;
  let missingBranch = 0;
  let missingAccount = 0;
  let missingKana = 0;
  for (const t of valid) {
    if (!t.bankCode?.trim()) missingBank++;
    if (!t.branchCode?.trim()) missingBranch++;
    if (!t.accountNumber?.trim()) missingAccount++;
    if (!toHankakuKana(t.accountHolderKana).trim()) missingKana++;
  }
  if (missingBank > 0) warnings.push(`銀行番号 未保持: ${missingBank} 件 (空欄で出力)`);
  if (missingBranch > 0) warnings.push(`支店番号 未保持: ${missingBranch} 件 (空欄で出力)`);
  if (missingAccount > 0) warnings.push(`口座番号 未設定: ${missingAccount} 件 (空欄で出力)`);
  if (missingKana > 0) warnings.push(`預金者名(カナ) 未設定: ${missingKana} 件 (空欄で出力)`);

  const records: string[] = [];
  records.push(buildHeader(consignor));
  let totalAmount = 0;
  for (const t of valid) {
    records.push(buildDataRecord(t));
    totalAmount += Math.max(0, Math.round(t.amount));
  }
  records.push(buildTrailer(valid.length, totalAmount));
  records.push(buildEnd());

  const ym = `${consignor.year}${String(consignor.month).padStart(2, "0")}`;
  const fileName = `FB_koza_furikae_${ym}.txt`;

  return {
    content: records.join("\r\n") + "\r\n",
    fileName,
    count: valid.length,
    totalAmount,
    warnings,
  };
}
