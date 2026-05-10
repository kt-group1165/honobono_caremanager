# scripts/

厚労省刊行の介護保険サービスコード表 PDF からマスタ CSV を生成するツール。

## なぜ Node + PDF.js？

厚労省 PDF は CID-keyed CJK fonts (Adobe-Japan1 / UniJIS-UCS2-H) を使うが、Adobe CMap データを **PDF 内に埋め込んでない**。そのため:

| ライブラリ | 結果 |
|---|---|
| pypdf | mojibake (各文字 → U+FFFD) |
| PyMuPDF (fitz) | mojibake |
| pdfplumber | mojibake |
| poppler (pdftotext) | エラー: `Couldn't find 'UniJIS-UCS2-H' CMap file` |
| **PDF.js (Mozilla)** | ✅ **CMap 内蔵で正常 decode** |

PDF.js は CMap を `node_modules/pdfjs-dist/cmaps/` に bundle してるので、Node 経由なら追加データ不要で日本語が抽出できる。

## 使い方

### 1. 依存セットアップ (初回のみ)

```bash
cd scripts
npm install
```

`pdfjs-dist` (legacy build) のみ。

### 2. PDF からマスタ CSV を生成

```bash
# 全ページ抽出 (在宅 + 施設サービス + 介護予防 + 高額合算)
node extract_service_codes.mjs "../docs/介護ソフト関連/介護保険サービスコード表.pdf" service_codes_all.csv

# 在宅系のみ (施設 51-59 を除外)
node extract_service_codes.mjs "../docs/介護ソフト関連/介護保険サービスコード表.pdf" service_codes_zaitaku.csv 1 406 --zaitaku-only

# 特定ページ範囲
node extract_service_codes.mjs <pdf> output.csv 1 50
```

### 3. アプリに取り込む

kaigo-app の `/master/service-codes` で **「CSV取込」** ボタンを押し、生成した CSV を選択 → プレビュー確認 → **「N 件 取込確定」**。

`service_code` を主キーに UPSERT するので、改正時は新しい PDF から再生成して取り込めば差分更新される。

## 在宅系カテゴリ一覧 (令和6年度報酬改定基準)

| code | name | 概数 |
|---|---|---|
| 11 | 訪問介護 | 5,567 |
| 12 | 訪問入浴介護 | 32 |
| 13 | 訪問看護 | 1,174 |
| 14 | 訪問リハビリテーション | 25 |
| 15 | 通所介護 | 671 |
| 16 | 通所リハビリテーション | 1,624 |
| 17 | 福祉用具貸与 | 65 |
| 21 | 短期入所生活介護 | 1,001 |
| 22 | 短期入所療養介護(老健) | 1,257 |
| 23 | 短期入所療養介護(病院療養型) | 2,434 |
| 27 | 短期特定施設入居者生活介護 | 40 |
| 31 | 居宅療養管理指導 | 52 |
| 33 | 夜間対応型訪問介護 | 677 |
| 43 | 居宅介護支援 | 657 |

合計 15,276 件 (令和6年度改定 PDF より)

## CSV 形式

`kaigo_service_codes` テーブルにそのまま UPSERT 可能な列構成:

```csv
service_category,service_category_name,service_code,service_name,units,unit_type,calculation_type,valid_from,valid_until,notes
11,訪問介護,114845,身体介護０１,163,1回につき,基本,,,PDF p.3
11,訪問介護,114846,身体介護０１・夜,204,1回につき,加算,,,PDF p.3
```

| 列 | 必須 | 内容 |
|---|---|---|
| service_category | ✓ | 2桁の数字 (11, 13, etc.) |
| service_category_name | | サービス種類名 (`CATEGORY_NAME_BY_CODE` map で自動補完) |
| service_code | ✓ | 6桁の英数字 (大文字, I/O/Q 不可) |
| service_name | ✓ | サービス名称略 |
| units | | 単位数 (整数) |
| unit_type | | "1回につき" / "1日につき" / "1月につき" |
| calculation_type | | "基本" / "加算" / "減算" |
| valid_from / valid_until | | 適用期間 (任意) |
| notes | | 備考 (PDF 抽出時はページ番号が入る) |

## 既知の制約

1. **calculation_type の判定** — 行内に「加算」「減算」のリテラルがあるかで決定。完全に正確ではないが大半は正しい。手動で直すなら CSV を編集して再 import か、UI で 1 件ずつ編集。
2. **units=0 の行** — `× 200%` のような派生コードは PDF 上で単位数が省略されてる行があり、抽出時 0 になる。元の基本単位を別途参照する必要あり。
3. **介護予防 (61-79) と一部地域密着型** — 当バージョンの PDF にこのコード prefix が含まれてない場合、それらは出力されない。実コードを確認して `CATEGORY_NAME_BY_CODE` を更新する。
4. **改正対応** — 厚労省が新版 PDF を出したら同じスクリプトで再抽出。`service_code` 主キーで UPSERT されるので追加 / 単位数更新が反映される。**廃止コード** は手動で `valid_until` を設定するか削除する必要あり。

## ファイル構成

```
scripts/
├── extract_service_codes.mjs     # メイン抽出スクリプト
├── extract_pdf_text.mjs          # 汎用 PDF テキスト + 座標抽出 (debug 用)
├── inspect_csv.py                # 生成 CSV の中身確認 (Python, UTF-8 stdout)
├── service_codes_zaitaku.csv     # 在宅系のみ抽出結果 (令和6年度改定)
└── README.md                     # この文書
```
