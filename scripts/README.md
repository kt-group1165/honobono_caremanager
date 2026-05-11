# scripts/

厚労省刊行の介護保険サービスコード表 PDF からマスタ CSV を生成するツール。

> 総合事業 (介護予防・日常生活支援総合事業) の PDF を入れる場所は `docs/介護ソフト関連/総合事業/`。

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

# 在宅系のみ (施設 51-59 を除外) — 令和6年度報酬改定 (default valid-from=2024-06-01)
node extract_service_codes.mjs "../../../docs/介護ソフト関連/介護保険サービスコード表.pdf" \
  service_codes_zaitaku.csv 1 406 \
  --zaitaku-only --notes=令和6年度報酬改定

# 改定対応: valid-from を切替えて投入 (例: 令和9年度改定が出たら)
node extract_service_codes.mjs "新しい改定の.pdf" \
  service_codes_r9.csv 1 406 \
  --zaitaku-only --valid-from=2027-04-01 --notes=令和9年度報酬改定

# 特定ページ範囲
node extract_service_codes.mjs <pdf> output.csv 1 50
```

オプション:

| flag | default | 内容 |
|---|---|---|
| `--zaitaku-only` | off | 在宅系のみ (施設 51-59 を除外) |
| `--valid-from=YYYY-MM-DD` | `2024-06-01` | 適用開始日 (令和6年改定基準が default) |
| `--notes=<text>` | `""` | notes 列に書き込む追加文字列 (PDF ページ番号は常に併記) |

### 3. アプリに取り込む

kaigo-app の `/master/service-codes` で **「CSV取込」** ボタンを押し、生成した CSV を選択 → プレビュー確認 → **「N 件 取込確定」**。

`(service_code, valid_from)` の複合 UNIQUE で UPSERT するので、**改定時は同 service_code でも valid_from が違えば新しい行として追加** される。同一 valid_from で既存があれば上書き (誤字修正等)。

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

## 改正 (報酬改定) 対応フロー

スキーマ的に `(service_code, valid_from)` で複合 UNIQUE になっており、同じコードでも valid_from が違えば別行として **履歴保持** される。請求計算側は対象月に有効な行 (valid_from <= 月末日 AND (valid_until IS NULL OR valid_until >= 月初日)) を引けば過去月でも正しい単位で計算できる。

**改定が来たときの手順:**

1. 厚労省が新しい「介護保険サービスコード表.pdf」を公開
2. 抽出: `--valid-from=<新施行日>` で生成
   ```bash
   node extract_service_codes.mjs new.pdf out.csv 1 406 \
     --zaitaku-only --valid-from=2027-04-01 --notes=令和9年度改定
   ```
3. **(任意) 旧版の valid_until を埋める** — 例えば 2027-04-01 から新版が施行されるなら、現行行に `valid_until = 2027-03-31` を SQL で一括 UPDATE:
   ```sql
   UPDATE kaigo_service_codes
     SET valid_until = '2027-03-31'
     WHERE valid_from = '2024-06-01' AND valid_until IS NULL;
   ```
4. `/master/service-codes` で 新 CSV を「CSV取込」→ 「上書き UPSERT」確定
5. アプリ側のクエリは「請求対象月で有効な行」を取得するので、自動的に新単位で計算される

**「適用日フィルタ」**: 一覧画面で日付を入れると、その日に有効な行だけに絞り込まれる。「本日」ボタンで今日有効なものに即時絞込。

## 既知の制約

1. **calculation_type の判定** — 行内に「加算」「減算」のリテラルがあるかで決定。完全に正確ではないが大半は正しい。手動で直すなら CSV を編集して再 import か、UI で 1 件ずつ編集。
2. **units=0 の行** — `× 200%` のような派生コードは PDF 上で単位数が省略されてる行があり、抽出時 0 になる (在宅系の約 3.4%)。元の基本単位を別途参照する必要あり。
3. **介護予防 (61-79) と一部地域密着型** — 当バージョンの PDF にこのコード prefix が含まれてない場合、それらは出力されない。実コードを確認して `CATEGORY_NAME_BY_CODE` を更新する。
4. **廃止コード** — 改定で消えたコードは新 CSV に含まれないため自動で valid_until が埋まらない。SQL で `WHERE service_code NOT IN (新CSV のコード集合) AND valid_until IS NULL → valid_until=施行日前日` UPDATE が必要。

## ファイル構成

```
scripts/
├── extract_service_codes.mjs     # メイン抽出スクリプト
├── extract_pdf_text.mjs          # 汎用 PDF テキスト + 座標抽出 (debug 用)
├── inspect_csv.py                # 生成 CSV の中身確認 (Python, UTF-8 stdout)
├── service_codes_zaitaku.csv     # 在宅系のみ抽出結果 (令和6年度改定)
└── README.md                     # この文書
```
