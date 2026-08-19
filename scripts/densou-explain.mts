/**
 * 伝送ファイルを「1 行 = 1 項目」の注釈付き CSV に展開する (READ ONLY)。
 *
 * ── 何のため ──────────────────────────────────────────────────────────
 *   伝送ファイルは数字の羅列で、どの位置が何を意味するかが読み取れない。
 *   実データの各項目に **項番・項目名・意味** を付けて Excel で読める形にする。
 *
 * ── 項目名の出所 ──────────────────────────────────────────────────────
 *   ビルダー (build.ts / build-sougou.ts / shogai-densou/build.ts) の
 *   `値, // <項番> <項目名>` コメントを機械的に読む。
 *   ⚠ 原典は docs/kokuho_if/ の各インタフェース仕様書。ビルダーのコメントは
 *     そこから起こしたものなので、**疑わしいときは原典に当たること**。
 *
 * ── 使い方 ────────────────────────────────────────────────────────────
 *   npx tsx scripts/densou-explain.mts <伝送ファイル> [出力先.csv]
 *
 *   例) npx tsx scripts/densou-explain.mts \
 *         "伝送データ/四街道/訪問介護/介護/202607/ほのぼのから/KK260802.CSV"
 *       → 同じ場所に KK260802_解説.csv を書く
 *
 *   ディレクトリを渡すと配下の伝送ファイルをまとめて処理する。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import Encoding from "encoding-japanese";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── 1) ビルダーから項目名辞書を作る ────────────────────────────────────
/**
 * `dataParts.push([ ... ])` の中の `// <項番> <名前>` コメントを拾う。
 * レコード種別は直前に現れる交換情報識別番号リテラル ("7131" / KOKAN_ID_… / "J121") で決める。
 */
type Dict = Map<string, Map<number, string>>; // "7131-01" -> (項番 -> 名前)

function buildDict(): Dict {
  const dict: Dict = new Map();
  const files = [
    "src/lib/kokuho-densou/build.ts",
    "src/lib/kokuho-densou/build-sougou.ts",
    "src/lib/shogai-densou/build.ts",
  ];
  for (const f of files) {
    let src = "";
    try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
    // dataParts.push([ ... ]) / seikyuParts.push([ ... ]) 等のブロックを拾う
    const re = /(?:dataParts|seikyuParts|jissekiParts|jogenParts)\.push\(\[([\s\S]*?)\]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const body = m[1];
      // ブロック先頭の識別番号 + レコード種別を推測
      const idM =
        /"(7111|7113|7131|71R1|8222|J111|J121|J411|J421|J611)"/.exec(body) ??
        /KOKAN_ID_(SEIKYUSHO|MEISAISHO)/.exec(body);
      let kokan = idM ? idM[1] : "";
      if (kokan === "SEIKYUSHO") kokan = f.includes("sougou") ? "7113" : "7111";
      if (kokan === "MEISAISHO") kokan = f.includes("sougou") ? "71R1" : "7131";
      if (!kokan) continue;
      // レコード種別 = 識別番号の**次の要素**が "01"/"02"/"05"/"10"/"14" のリテラルなら採用。
      // ⚠ body は改行始まりなので ^ 起点の正規表現では拾えない (最初この誤りで
      //   7131 の 02/10 が 01 の項目名で解説されていた)。行単位で見る。
      const lines = body.split(/\r?\n/);
      const idLine = lines.findIndex((l) =>
        /(?:KOKAN_ID_\w+|"(?:7111|7113|7131|71R1|8222|J\d{3})")\s*,/.test(l),
      );
      let kind = "";
      if (idLine >= 0) {
        const nx = lines[idLine + 1] ?? "";
        const k = /^\s*"(\d{2})"\s*,/.exec(nx);
        if (k) kind = k[1];
      }
      const key = kind ? `${kokan}-${kind}` : kokan;
      if (!dict.has(key)) dict.set(key, new Map());
      const bucket = dict.get(key)!;
      for (const line of lines) {
        const c = /\/\/\s*(\d{1,3})\s+(.+?)\s*$/.exec(line);
        if (!c) continue;
        const no = Number(c[1]);
        // 項目名だけ残す: 「(補足)」「。以降の説明」「: 以降の説明」を落とす
        const name = c[2]
          .replace(/\s*[（(].*$/, "")
          .replace(/[。:：].*$/, "")
          .replace(/\s*←.*$/, "")
          .trim();
        if (name && !bucket.has(no)) bucket.set(no, name);
      }
    }
  }
  return dict;
}

/**
 * 明細/集計レコードの項1〜6 は基本情報と共通だが、ビルダー側では 2 レコード目以降
 * `// 1` `// 4` のように名前を省いてあり辞書に載らない。共通部分をここで補う。
 */
const COMMON_HEAD: Record<string, string[]> = {
  // 介護給付・総合事業の明細書 (7131 / 71R1)
  kaigo: ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "事業所番号", "証記載保険者番号", "被保険者番号"],
  // 障害の明細書 (J121) / 実績記録票 (J611)
  shogai: ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号", "受給者証番号"],
};

/**
 * 障害 (J111/J121/J411) の項目名は原典 (docs/kokuho_if/障害IF_サービス事業所編_R7.04.pdf)
 * と migrations/_if_shogai.txt から起こした確定値。
 * ⚠ ビルダーのコメントは「// 11 / 12 / …」のようにまとめ書きされている箇所があり
 *   機械抽出だと項番がずれるため、ここで上書きする (2026-08-07 に J121-05 でずれを確認)。
 * J611 (172項/113項) は項目数が多く未整備 — 空欄で出る。
 */
const SHOGAI_FIELDS: Record<string, string[]> = {
  "J111-01": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "請求金額", "件数", "単位数", "総費用額", "給付費請求額", "特定障害者特別給付費 件数", "利用者負担額",
    "自治体助成分 件数", "自治体助成額", "予備", "予備", "件数(再掲)", "単位数(再掲)", "総費用額(再掲)",
    "給付費請求額(再掲)", "予備", "利用者負担額(再掲)", "予備"],
  "J111-02": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "給付種別", "サービス種類コード", "件数", "単位数", "総費用額", "給付費請求額", "特定障害者特別給付費",
    "利用者負担額", "自治体助成額"],
  "J121-01": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "受給者証番号", "助成自治体番号", "支給決定者氏名カナ", "支給決定児童氏名カナ", "地域区分コード",
    "就労継続支援A型事業者負担減免措置実施", "利用者負担上限月額①", "就労継続支援A型減免対象者",
    "利用者負担上限額管理事業所 事業所番号", "上限額管理結果", "予備", "予備", "予備", "予備", "予備",
    "給付費請求額 合計", "総費用額 合計", "利用者負担額 合計", "予備", "予備", "予備", "予備",
    "調整後利用者負担額", "上限額管理後利用者負担額", "予備", "予備", "予備", "予備", "予備", "予備"],
  "J121-02": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "受給者証番号", "サービス種類コード", "開始年月日", "終了年月日", "利用日数", "入院日数", "外泊日数"],
  "J121-03": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "受給者証番号", "サービスコード", "単位数", "回数", "サービス単位数", "摘要"],
  "J121-04": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "受給者証番号", "サービス種類コード", "集計欄分類番号", "サービス利用日数", "給付単位数", "単位数単価",
    "給付率", "総費用額", "1割相当額", "利用者負担額②", "上限月額調整", "A型減免前利用者負担額",
    "A型減免額", "調整後利用者負担額", "上限額管理後利用者負担額", "決定利用者負担額", "請求額 給付費",
    "高額障害福祉サービス費", "特別対策費", "自治体助成分請求額", "特定障害者特別給付費 対象日数",
    "特定障害者特別給付費 費用基準額", "特定障害者特別給付費 実費算定額", "特定障害者特別給付費 請求額",
    "利用日数管理票 対象期間開始", "同 終了", "同 当月日数", "同 原則日数総和"],
  "J121-05": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "受給者証番号", "決定サービスコード", "契約支給量", "契約開始年月日", "契約終了年月日", "事業者記入欄番号"],
  "J411-01": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "作成区分", "市町村番号",
    "上限額管理事業所番号", "受給者証番号", "支給決定者氏名カナ", "支給決定児童氏名カナ",
    "利用者負担上限月額", "上限額管理結果", "合計 総費用額", "合計 利用者負担額", "合計 管理結果後利用者負担額"],
  "J411-02": ["交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号",
    "上限額管理事業所番号", "受給者証番号", "項番", "事業所番号", "総費用額", "利用者負担額",
    "管理結果後利用者負担額"],
  // ── 実績記録票 (居宅介護 = 様式種別番号 0101) ──────────────────────
  //   基本情報 172項 / 明細情報 113項 のうち、居宅介護で使うのは一部だけ。
  //   他様式 (施設系・就労系) 専用の項は「(他様式用)」として空欄で出る。
  //   ⚠ 原典 PDF の表は列座標がばらつき機械抽出できなかったため
  //     migrations/_if_shogai.txt の抜粋 (原典から起こしたもの) を採用。
  "J611-01": [
    "交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "受給者証番号", "様式種別番号",
    ...Array.from({ length: 8 }, () => "補足給付関係 (施設系のみ)"), // 8-15
    "合計1 身体介護 内訳100%", "合計1 身体介護 内訳70%", "合計1 身体介護 内訳重訪", "合計1 身体介護 算定時間数計", // 16-19
    "合計2 通院介助(伴う) 内訳100%", "合計2 通院介助(伴う) 内訳70%", "合計2 通院介助(伴う) 内訳重訪", "合計2 通院介助(伴う) 算定時間数計", // 20-23
    "合計3 家事援助 内訳100%", "合計3 家事援助 内訳90%", "合計3 家事援助 算定時間数計", // 24-26
    "合計4 通院介助(伴わず) 内訳100%", "合計4 通院介助(伴わず) 内訳90%", "合計4 通院介助(伴わず) 算定時間数計", // 27-29
    "合計5 通院等乗降介助 内訳100%", "合計5 通院等乗降介助 内訳90%", "合計5 通院等乗降介助 算定回数計", // 30-32
    ...Array.from({ length: 79 }, () => "(他様式用)"), // 33-111
    "緊急時対応加算 (回)", "初回加算 (回)", "福祉専門職員等連携加算 (回)", // 112-114
    ...Array.from({ length: 58 }, () => "(他様式用)"), // 115-172
  ],
  "J611-02": [
    "交換情報識別番号", "レコード種別コード", "サービス提供年月", "市町村番号", "事業所番号",
    "受給者証番号", "様式種別番号", "提供通番", "日付", "サービス提供回数",
    "サービス内容 (決定コード)", "ヘルパー資格", "運転フラグ", "開始時間", "終了時間",
    "算定時間数", "通院等乗降介助 (回数)", "移動 (重度訪問介護)", "派遣人数", "前月からの継続サービス", // 11-20
    ...Array.from({ length: 14 }, () => "(他様式用)"), // 21-34
    "備考", "サービス提供の状況", // 35-36
    ...Array.from({ length: 32 }, () => "(他様式用)"), // 37-68
    "緊急時対応加算", "初回加算", "福祉専門職員等連携加算", // 69-71
    ...Array.from({ length: 42 }, () => "(他様式用)"), // 72-113
  ],
};

function applyShogaiFields(dict: Dict) {
  for (const [key, names] of Object.entries(SHOGAI_FIELDS)) {
    const bucket = new Map<number, string>();
    names.forEach((n, i) => bucket.set(i + 1, n));
    dict.set(key, bucket); // 機械抽出より原典由来を優先 (上書き)
  }
}

function fillCommonHead(dict: Dict) {
  for (const [key, bucket] of dict) {
    const head = key.startsWith("J") ? COMMON_HEAD.shogai : COMMON_HEAD.kaigo;
    head.forEach((name, i) => {
      if (!bucket.get(i + 1)) bucket.set(i + 1, name);
    });
  }
}

// ─── 2) コード値の読み替え ──────────────────────────────────────────────
const CODE: Record<string, Record<string, string>> = {
  レコード種別コード: { "01": "基本情報", "02": "明細情報", "03": "明細情報", "04": "集計情報", "05": "契約情報", "10": "集計情報", "14": "明細情報(住所地特例)" },
  交換情報識別番号: {
    "7111": "介護給付費請求書", "7131": "介護給付費明細書(様式第二)",
    "7113": "総合事業費請求書", "71R1": "総合事業費明細書(様式第二の三)",
    "8222": "給付管理票", "J111": "障害 請求書", "J121": "障害 明細書",
    "J411": "障害 上限管理結果票", "J611": "障害 実績記録票",
  },
  "保険・公費等区分コード": { "1": "保険請求分", "2": "公費請求分" },
  性別: { "1": "男", "2": "女" },
  要介護状態区分コード: { "06": "事業対象者", "12": "要支援1", "13": "要支援2", "21": "要介護1", "22": "要介護2", "23": "要介護3", "24": "要介護4", "25": "要介護5" },
  居宅サービス計画作成区分コード: { "1": "居宅介護支援事業所作成", "2": "被保険者(自己)作成", "3": "介護予防支援事業所・地域包括支援センター作成" },
  法別番号: { "0": "(保険請求)", "12": "生活保護", "21": "精神通院", "54": "難病", "81": "原爆" },
  媒体区分: { "1": "伝送", "7": "伝送(インターネット)" },
  請求情報区分コード: { "01": "居宅サービス", "02": "施設/その他", "05": "総合事業", "0": "(法別81)" },
  上限額管理結果: { "1": "1 管理事業所で対応(他は0円)", "2": "2 上限額に達していない(調整不要)", "3": "3 上限額を超過(按分調整あり)" },
  作成区分: { "1": "新規", "2": "修正", "3": "取消" },
  給付種別: { "1": "介護給付費等" },
  様式種別番号: { "0101": "居宅介護", "0301": "重度訪問介護", "0501": "同行援護", "0701": "行動援護" },
  ヘルパー資格: { "11": "初任者研修等", "12": "基礎研修等", "13": "重度訪問介護従業者" },
  派遣人数: { "1": "1人", "2": "2人" },
  補足給付適用の有無: { "1": "無し", "2": "有り" },
};

/** 5 桁の契約支給量 (整数3+小数2) を人が読める形に */
const explainShikyuryo = (v: string) => {
  if (!/^\d{3,5}$/.test(v)) return "";
  const n = Number(v);
  const h = Math.floor(n / 100), m = n % 100;
  return `${h}.${String(m).padStart(2, "0")} (=${h}時間${Math.round((m / 100) * 60)}分 相当)`;
};

/** サービスコード → 名称 (kaigo_service_codes より。起動時に 1 回だけ読む) */
/**
 * ⚠ 同じ 6 桁コードが介護と障害の両方に存在する (116184 = 介護「訪問介護処遇改善加算Ⅱ２」/
 *   障害「家事日９．５・２人」)。**制度で分けて持たないと違う名前が出る。**
 */
let SERVICE_NAME: Map<string, Map<string, string>> = new Map();
/** いま処理しているファイルの制度 ("介護" or "障害")。交換情報識別番号で決まる */
let CUR_SYSTEM = "介護";
const serviceNameOf = (code: string): string | undefined =>
  SERVICE_NAME.get(CUR_SYSTEM)?.get(code);

function explain(name: string, value: string): string {
  if (!value) return "";
  // サービスコードは名称を出す (6桁 or 種類2桁+項目4桁の連結)
  if (/(サービスコード|決定サービスコード)/.test(name)) {
    const hit = serviceNameOf(value);
    if (hit) return hit;
  }
  for (const [key, table] of Object.entries(CODE)) {
    if (name.includes(key) && table[value]) return table[value];
  }
  if (name.includes("契約支給量")) return explainShikyuryo(value);
  // 実績記録票 (J611) 固有の読み替え
  if (/(開始時間|終了時間)/.test(name) && /^\d{4}$/.test(value))
    return `${Number(value.slice(0, 2))}時${value.slice(2)}分`;
  if (/算定時間数/.test(name) && /^\d{4,5}$/.test(value)) {
    // 基本情報は 整数3+小数2 / 明細は 整数2+小数2。どちらも下2桁が小数
    const h = Number(value.slice(0, -2)), f = Number(value.slice(-2));
    return `${h}.${String(f).padStart(2, "0")} 時間 (=${h}時間${Math.round((f / 100) * 60)}分)`;
  }
  if (/^日付$/.test(name) && /^\d{1,2}$/.test(value)) return `${Number(value)}日`;
  // 日付・年月は桁で判定する (項目名が「認定有効期間 開始」等でも拾う)
  if (/^\d{8}$/.test(value) && /(年月日|開始|終了|日$)/.test(name))
    return `${value.slice(0, 4)}年${Number(value.slice(4, 6))}月${Number(value.slice(6))}日`;
  if (/^\d{6}$/.test(value) && /年月/.test(name))
    return `${value.slice(0, 4)}年${Number(value.slice(4))}月`;
  if (name.includes("単位数単価") && /^\d{4}$/.test(value))
    return `${(Number(value) / 100).toFixed(2)} 円/単位`;
  // ⚠ 「含む」で判定すると取りこぼす。**末尾の語**で判定すること。
  //   含む判定だと「合計 管理結果後利用者負担額」が『結果』に引っかかって円が付かず、
  //   「サービス費用 件数」が『費用』に引っかかって円になる (2026-08-07 に両方踏んだ)。
  if (!/^\d+$/.test(value)) return "";
  if (/額$/.test(name)) return `${Number(value).toLocaleString()} 円`;
  if (/単位数(合計|計)?$/.test(name)) return `${Number(value).toLocaleString()} 単位`;
  if (/(件数|日数|回数|人数|番号|コード|区分|結果|通番|項番|率)$/.test(name)) return "";
  if (/(金額|請求額|費用)/.test(name)) return `${Number(value).toLocaleString()} 円`;
  return "";
}

// ─── 3) 伝送ファイルを展開 ──────────────────────────────────────────────
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** 1 レコード分の解析結果 (縦持ち・横持ち どちらの出力にも使う) */
interface Parsed {
  lineNo: number;
  label: string; // "コントロール" / "7131" / "J121" …
  kind: string; // レコード種別 ("01" 等)。請求書・制御は ""
  fields: { no: number; name: string; value: string; mean: string }[];
}

function parseRecords(path: string, dict: Dict): Parsed[] {
  const buf = readFileSync(path);
  const text = Encoding.codeToString(
    Encoding.convert(new Uint8Array(buf), { to: "UNICODE", from: "SJIS" }),
  );
  const out: Parsed[] = [];
  let lineNo = 0;
  for (const line of text.split(/\r\n|\n/)) {
    if (!line.length) continue;
    lineNo++;
    const c = splitCsvLine(line);
    if (c[0] === "1") {
      const isShogai = /^J\d\d$/.test(c[4] ?? "");
      const names = isShogai
        ? ["レコード種別", "レコード番号", "ボリューム通番", "データ件数", "データ種別",
           "予備", "事業所番号", "予備", "媒体区分", "処理対象年月", "予備"]
        : ["レコード種別", "レコード番号", "ボリューム通番", "データ件数", "データ種別",
           "福祉事務所番号", "保険者番号", "事業所番号", "都道府県番号", "媒体区分", "処理対象年月", "管理番号"];
      out.push({
        lineNo, label: "コントロール", kind: "",
        fields: c.map((v, i) => ({ no: i + 1, name: names[i] ?? "", value: v, mean: explain(names[i] ?? "", v) })),
      });
      continue;
    }
    if (c[0] === "3") {
      out.push({
        lineNo, label: "エンドレコード", kind: "",
        fields: [
          { no: 1, name: "レコード種別", value: c[0], mean: "" },
          { no: 2, name: "レコード番号", value: c[1] ?? "", mean: "" },
        ],
      });
      continue;
    }
    if (c[0] !== "2") continue;
    const parts = c.slice(2);
    const kokan = parts[0] ?? "";
    CUR_SYSTEM = kokan.startsWith("J") ? "障害" : "介護";
    const isSeikyusho = kokan === "7111" || kokan === "7113" || kokan === "J111";
    const kind = isSeikyusho ? "" : (parts[1] ?? "");
    const key = kind ? `${kokan}-${kind}` : kokan;
    const names = dict.get(key) ?? dict.get(kokan) ?? new Map<number, string>();
    out.push({
      lineNo, label: kokan, kind,
      fields: parts.map((v, i) => {
        const name = names.get(i + 1) ?? "";
        let mean = explain(name, v);
        // 介護/総合の明細は「サービス種類コード(2桁)」+「サービス項目コード(4桁)」に分かれる
        if (!mean && /サービス種類コード/.test(name) && parts[i + 1]) {
          const joined = `${v}${parts[i + 1]}`;
          const hit = serviceNameOf(joined);
          if (hit) mean = `${joined} ${hit}`;
        }
        return { no: i + 1, name, value: v, mean };
      }),
    });
  }
  return out;
}

/** レコードの正体を日本語で言う (7131-01 → 「介護給付費 明細書 / 基本情報」) */
const RECORD_LABEL: Record<string, string> = {
  "コントロール": "ファイルの見出し (コントロールレコード)",
  "エンドレコード": "ファイルの終わり (エンドレコード)",
  "7111": "介護給付費 請求書",
  "7131-01": "介護給付費 明細書 / 基本情報 (利用者ごと)",
  "7131-02": "介護給付費 明細書 / 明細情報 (サービス1つごと)",
  "7131-10": "介護給付費 明細書 / 集計情報 (利用者ごとの合計)",
  "7131-14": "介護給付費 明細書 / 明細情報 (住所地特例)",
  "7113": "総合事業費 請求書",
  "71R1-01": "総合事業費 明細書 / 基本情報 (利用者ごと)",
  "71R1-02": "総合事業費 明細書 / 明細情報 (サービス1つごと)",
  "71R1-10": "総合事業費 明細書 / 集計情報 (利用者ごとの合計)",
  "8222": "給付管理票",
  "J111-01": "障害 請求書 / 基本情報 (市町村ごとの合計)",
  "J111-02": "障害 請求書 / 明細情報 (サービス種類ごと)",
  "J121-01": "障害 明細書 / 基本情報 (利用者ごと)",
  "J121-02": "障害 明細書 / 日数情報 (サービス種類ごとの利用日数)",
  "J121-03": "障害 明細書 / 明細情報 (サービス1つごと)",
  "J121-04": "障害 明細書 / 集計情報 (利用者ごとの合計)",
  "J121-05": "障害 明細書 / 契約情報 (契約支給量)",
  "J411-01": "障害 上限管理結果票 / 基本情報 (利用者ごと)",
  "J411-02": "障害 上限管理結果票 / 明細情報 (関係事業所ごと)",
  "J611-01": "障害 実績記録票 / 基本情報 (利用者ごと)",
  "J611-02": "障害 実績記録票 / 明細情報 (1行 = 1訪問)",
};
const recordLabel = (r: Parsed) =>
  RECORD_LABEL[r.kind ? `${r.label}-${r.kind}` : r.label] ?? r.label;

/**
 * 解説形式: **1 行 = 1 項目**の縦持ち。レコードの切れ目に見出し行を挟む。
 *
 * ── 読み方 ────────────────────────────────────────────────────────────
 *   「ファイルの値」列 = 伝送ファイルに**実際に書かれている文字**そのまま
 *   「説明」列         = こちらで付けた注記 (元ファイルには存在しない)
 *   この 2 つを列で分けているので、どこまでが実データかが一目で分かる。
 */
function toKaisetsu(recs: Parsed[]): string {
  const rows: string[] = [
    ["行", "項番", "項目名", "ファイルの値", "説明"].map(csvCell).join(","),
  ];
  for (const r of recs) {
    rows.push("");
    rows.push([`■ ${r.lineNo} 行目`, "", recordLabel(r), "", ""].map(csvCell).join(","));
    for (const f of r.fields) {
      // 値は = 付き文字列にして Excel の数値変換 (指数表記・先頭0落ち) を防ぐ
      rows.push(
        [
          csvCell(String(r.lineNo)),
          csvCell(String(f.no)),
          csvCell(f.name),
          f.value === "" ? "" : `="${f.value}"`,
          csvCell(f.mean),
        ].join(","),
      );
    }
  }
  return rows.join("\r\n") + "\r\n";
}

/**
 * 対訳形式: **元のファイルと同じ横並び**のまま、上に項番・項目名、下に意味を付ける。
 * 1 レコードが 4 行 (項番 / 項目名 / 値 / 意味) + 空行のブロックになる。
 * 元ファイルを Excel で開くと桁が化ける (事業所番号が 1.21E+09) が、
 * こちらは値を文字列として出すので化けない。
 */
function toTaiyaku(recs: Parsed[]): string {
  const rows: string[] = [];
  for (const r of recs) {
    const head = `${r.lineNo} 行目  ${r.label}${r.kind ? ` ${r.kind}` : ""}`;
    rows.push([head, ...r.fields.map((f) => `項${f.no}`)].map(csvCell).join(","));
    rows.push(["項目名", ...r.fields.map((f) => f.name)].map(csvCell).join(","));
    // 値は = 付き文字列にして Excel の数値変換 (指数表記・先頭0落ち) を防ぐ
    rows.push(["値", ...r.fields.map((f) => (f.value === "" ? "" : `="${f.value}"`))].join(","));
    rows.push(["意味", ...r.fields.map((f) => f.mean)].map(csvCell).join(","));
    rows.push("");
  }
  return rows.join("\r\n") + "\r\n";
}

function processFile(path: string, dict: Dict): string {
  const buf = readFileSync(path);
  const text = Encoding.codeToString(
    Encoding.convert(new Uint8Array(buf), { to: "UNICODE", from: "SJIS" }),
  );
  const rows: string[] = [
    ["行", "レコード", "種別", "項番", "項目名", "値", "意味"].join(","),
  ];
  let lineNo = 0;
  for (const line of text.split(/\r\n|\n/)) {
    if (!line.length) continue;
    lineNo++;
    const c = splitCsvLine(line);
    if (c[0] === "1") {
      // コントロールレコード。⚠ **介護 (12項) と障害 (11項) で構成が違う**。
      //   介護: … 福祉事務所番号 / 保険者番号 / 事業所番号 / 都道府県番号 / 媒体区分 / 処理対象年月 / 管理番号
      //   障害: … 予備 / 事業所番号 / 予備 / 媒体区分 / 処理対象年月 / 予備
      //   同じ並びで解説すると 1 項ずれる (2026-08-07 に JJ で判明)。データ種別で切り分ける。
      const isShogai = /^J\d\d$/.test(c[4] ?? "");
      const names = isShogai
        ? ["レコード種別", "レコード番号", "ボリューム通番", "データ件数", "データ種別",
           "予備", "事業所番号", "予備", "媒体区分", "処理対象年月", "予備"]
        : ["レコード種別", "レコード番号", "ボリューム通番", "データ件数", "データ種別",
           "福祉事務所番号", "保険者番号", "事業所番号", "都道府県番号", "媒体区分", "処理対象年月", "管理番号"];
      c.forEach((v, i) =>
        rows.push([String(lineNo), "コントロール", "", String(i + 1), names[i] ?? "", v, explain(names[i] ?? "", v)].map(csvCell).join(",")),
      );
      continue;
    }
    if (c[0] === "3") {
      rows.push([String(lineNo), "エンドレコード", "", "1", "レコード種別", c[0], ""].map(csvCell).join(","));
      rows.push([String(lineNo), "エンドレコード", "", "2", "レコード番号", c[1] ?? "", ""].map(csvCell).join(","));
      continue;
    }
    if (c[0] !== "2") continue;
    // データレコード: 先頭 2 列 (レコード種別 / 連番) を除いた残りが「項」
    const parts = c.slice(2);
    const kokan = parts[0] ?? "";
    // サービスコードの名称は制度で引き分ける (同じ 6 桁が介護と障害の両方にある)
    CUR_SYSTEM = kokan.startsWith("J") ? "障害" : "介護";
    const isSeikyusho = kokan === "7111" || kokan === "7113" || kokan === "J111";
    const kind = isSeikyusho ? "" : (parts[1] ?? "");
    const key = kind ? `${kokan}-${kind}` : kokan;
    const names = dict.get(key) ?? dict.get(kokan) ?? new Map<number, string>();
    parts.forEach((v, i) => {
      const no = i + 1;
      const name = names.get(no) ?? "";
      let mean = explain(name, v);
      // 介護/総合の明細は「サービス種類コード(2桁)」+「サービス項目コード(4桁)」に分かれる。
      // 種類の行で 2 つを連結した 6 桁の名称を出す (人が読むときはこれが一番効く)。
      if (!mean && /サービス種類コード/.test(name) && parts[i + 1]) {
        const joined = `${v}${parts[i + 1]}`;
        const hit = serviceNameOf(joined);
        if (hit) mean = `${joined} ${hit}`;
      }
      rows.push(
        [String(lineNo), kokan, kind, String(no), name, v, mean].map(csvCell).join(","),
      );
    });
  }
  return rows.join("\r\n") + "\r\n";
}

function collect(target: string): string[] {
  const st = statSync(target);
  if (!st.isDirectory()) return [target];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^(KK|KJ|TJ|JJ|J\d|SG|K|S)\w*\.CSV$/i.test(e.name)) out.push(p);
    }
  };
  walk(target);
  return out;
}

async function loadServiceNames(): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  try {
    const raw = readFileSync(join(ROOT, ".env.local"), "utf8");
    const v: Record<string, string> = {};
    for (const l of raw.split(String.fromCharCode(10))) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) v[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    const sb = createClient(v.NEXT_PUBLIC_SUPABASE_URL, v.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("kaigo_service_codes")
        .select("service_code, service_name, system")
        .range(from, from + 999);
      if (error) break;
      for (const r of (data ?? []) as { service_code: string; service_name: string; system: string }[]) {
        // 自治体prefix (MB_ 等) は伝送には出ないので外して登録。総合事業は介護側に寄せる
        const bare = r.service_code.replace(/^[A-Z]+_/, "");
        const sys = r.system === "障害" ? "障害" : "介護";
        if (!out.has(sys)) out.set(sys, new Map());
        const b = out.get(sys)!;
        if (!b.has(bare)) b.set(bare, r.service_name);
      }
      if ((data ?? []).length < 1000) break;
    }
  } catch {
    // DB に繋がらなくても項目名の解説は出せるので続行する
  }
  return out;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("使い方: npx tsx scripts/densou-explain.mts <伝送ファイル|フォルダ> [出力先.csv]");
    process.exit(1);
  }
  SERVICE_NAME = await loadServiceNames();
  console.log(`サービスコード名: ${[...SERVICE_NAME].map(([k,v])=>k+" "+v.size).join(" / ")}`);
  const dict = buildDict();
  applyShogaiFields(dict); // 障害は原典由来の定義で上書き
  fillCommonHead(dict);
  console.log(`項目名辞書: ${dict.size} レコード種別 / ${[...dict.values()].reduce((s, m) => s + m.size, 0)} 項目`);

  const files = collect(target);
  for (const f of files) {
    const stem = basename(f, extname(f));
    // ⚠ 出力先を Excel で開いたままだと EBUSY で落ちる。1 本の失敗で全体を止めない。
    const write = (name: string, body: string) => {
      const p = join(dirname(f), name);
      const sjis = Encoding.convert(Encoding.stringToCode(body), { to: "SJIS", from: "UNICODE" });
      try {
        writeFileSync(p, Buffer.from(sjis));
        return basename(p);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `✗ ${basename(p)} (${/EBUSY/.test(msg) ? "Excel で開かれています" : msg})`;
      }
    };
    // 出力は 1 本だけにする。2 形式あると「どっちを見ればいいか」で迷うため
    // (2026-08-07: 横並びの対訳は値と説明が混ざって読みづらいと指摘を受け縦持ちに一本化)。
    const csv = toKaisetsu(parseRecords(f, dict));
    const name = files.length === 1 && process.argv[3] ? basename(process.argv[3]) : `${stem}_解説.csv`;
    console.log(`  ${basename(f)} → ${write(name, csv)}`);
  }
}

main();
