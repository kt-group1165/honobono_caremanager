# 設計: グループ内部ID (通し番号) + ソフトデリート + 複数法人対応

2026-07-15 user 確定方針に基づく設計。**適用はデータクリーニング時** (今は設計のみ)。

> 要件 (user の言葉):
> - 5法人ある。複数法人に対応したい
> - 利用者も従業員も、法人に関係ない「通し番号」的な内部IDを持たせたい (後からどうとでもなるように)
> - 登録後に削除することがあるが、データとしては残す (非表示に近い)
> - 番号は重複のないように振っていく

---

## 0. 原則

1. **人はグループレベルの実体**。利用者 (clients)・従業員 (members) は法人・事業所に属さない。
   法人・事業所への紐付けは junction (client_office_assignments / member_offices) → offices.company_id で導出する属性であり、人の ID には一切含めない。
2. **内部IDは無意味連番**。法人コード・年度・事業所などの意味を番号に埋め込まない。
   意味を埋め込むと法人異動・転籍・組織再編のたびに番号が嘘になる。無意味なら永久に不変。
3. **永久欠番**。一度振った番号は削除後も再利用しない (SEQUENCE は戻さない)。
4. **削除 = 非表示**。物理 DELETE はしない。過去の実績・請求・給与からの参照は生き続ける。

## 1. 内部ID (通し番号)

### 1.1 スキーマ

```sql
-- 利用者と従業員で独立した番号空間 (別 SEQUENCE)
CREATE SEQUENCE client_internal_number_seq START 10001;
CREATE SEQUENCE member_internal_number_seq START 10001;

ALTER TABLE clients ADD COLUMN internal_number BIGINT;   -- backfill 後に NOT NULL + UNIQUE + DEFAULT
ALTER TABLE members ADD COLUMN internal_number BIGINT;
```

- 型は **BIGINT** (整数)。prefix や zero-pad は DB に持たない。
- **DEFAULT nextval(...)** で INSERT 時に自動採番 = アプリ側の採番コード不要・競合/重複が DB 保証で起きない。
- UUID の `id` (技術キー) はそのまま。internal_number は**人間可読の業務キー** (帳票・問い合わせ・突合用)。

### 1.2 表示規約 (UI 層のみ)

| 対象 | 表示 | 例 |
|---|---|---|
| 利用者 | `C-` + 6桁 zero-pad | C-010001 |
| 従業員 | `S-` + 6桁 zero-pad | S-010001 |

DB は整数のみ。表示 prefix は共通ヘルパー (`formatInternalNumber(kind, n)`) で一元化。

### 1.3 既存番号との役割分離 (温存)

| 列 | 役割 | 扱い |
|---|---|---|
| `clients.user_number` | ほのぼの由来の対外番号。CSV 同期・レガシー突合キー | 温存 (役割はレガシー連携のみに縮小) |
| `clients.insured_number` 等 | 制度上の番号 (被保険者番号など) | 温存 (制度属性) |
| `payroll_employees.employee_number` | 給与の事業所内番号 | 温存 (給与実務用) |
| **`internal_number`** | **グループ横断の恒久 ID** | 新設。全画面の「番号」表示はこれに寄せていく |

### 1.4 backfill 手順 (適用時)

```sql
-- 1. 採番 (created_at 順、同時刻は id 順で安定)
WITH ordered AS (
  SELECT id, 10000 + row_number() OVER (ORDER BY created_at, id) AS rn
  FROM clients
)
UPDATE clients c SET internal_number = o.rn FROM ordered o WHERE c.id = o.id;

-- 2. sequence を最大値+1 に合わせる
SELECT setval('client_internal_number_seq', (SELECT max(internal_number) FROM clients));

-- 3. 制約 + 既定値
ALTER TABLE clients
  ALTER COLUMN internal_number SET NOT NULL,
  ALTER COLUMN internal_number SET DEFAULT nextval('client_internal_number_seq');
ALTER TABLE clients ADD CONSTRAINT uq_clients_internal_number UNIQUE (internal_number);
```

members も同型。**データクリーニング (重複・テストデータ整理) を先に行ってから backfill** するのが正順
(きれいにする前に振ると、消す予定の行が番号を食う。永久欠番方針なので歯抜けは問題ないが、初期採番はきれいな状態から始めるのが気持ちよい)。

## 2. ソフトデリート

### 2.1 スキーマ

```sql
-- clients は deleted_at が既にある (現状スキーマで確認済み) → 補助列だけ追加
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_by UUID;      -- 操作者 (auth.users)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS delete_reason TEXT;

-- members には無い → 一式追加
ALTER TABLE members ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS deleted_by UUID;
ALTER TABLE members ADD COLUMN IF NOT EXISTS delete_reason TEXT;
```

- **退職と削除は別概念**: `members.status='退職'` = 雇用状態 (履歴として一覧に出る)。
  `deleted_at` = 登録抹消 (誤登録・二重登録など。原則見えなくなる)。混ぜない。
- 復元 = `deleted_at = NULL` に戻すだけ (番号・履歴は不変)。

### 2.2 フィルタ原則 (どこで隠すか)

| 経路 | deleted フィルタ |
|---|---|
| 一覧・検索・選択 UI (利用者一覧、担当者セレクタ、新規予定の対象者など) | **かける** (`deleted_at IS NULL`) |
| ID 参照 (請求・実績・給与履歴・帳票の名前解決、`byId` lookup) | **かけない** (過去が壊れない) |
| 請求集計 (aggregate) | かけない (実績起点なので、削除者の過去月請求・再請求も正しく出る) |
| 管理画面 | 「削除済みを表示」トグル (admin のみ) + 復元ボタン |

実装は VIEW を作らず**一覧系クエリに `.is("deleted_at", null)` を足す**方式
(参照系に誤ってフィルタが効いて過去帳票の名前が消える事故を防ぐため、既定で隠れる仕掛けにはしない)。

### 2.3 UNIQUE 制約との共存

- `internal_number` の UNIQUE は削除後も維持 (= 永久欠番)。
- 「生きている行の中でだけ一意にしたい」制約 (例: members.email、利用者の被保険者番号での二重登録ガードを将来足す場合) は
  **partial UNIQUE** にする: `CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL`。
  こうしないと、削除済みの行が再登録をブロックする。
  ※ partial UNIQUE は PostgREST の `on_conflict` upsert と併用不可 (42P10。partner_companies で確認済みの罠) — upsert が要る列には使わない。

## 3. 複数法人 (5法人) 対応

**結論: 人のマスタ構造は変更不要**。既に person-centric + junction で法人非依存になっている。

```
groups ─ companies (5法人) ─ offices          ← 組織
clients ─ client_office_assignments ─ offices ← 利用者の所属 (複数可)
members ─ member_offices ─ offices            ← 従業員の所属 (兼務可)
```

- 人 → 法人の導出は junction → `offices.company_id`。**1人が複数法人にまたがれる** (居宅と訪問介護が別法人、兼務スタッフ等) — 現行の請求書法人合算 (riyou-seikyu) もこの導出で動いている。
- 内部IDがこの設計を完成させる: 「どの法人の人か」に依存しない恒久キーができるので、法人再編・転籍・事業所統廃合をしても人のデータは一切動かさなくてよい。
- 将来課題 (この設計のスコープ外、必要になったら):
  - **主たる法人/事業所** flag: 雇用契約・源泉徴収など「1つに決める」帳票用に `member_offices.is_primary` を追加
  - **payroll_employees → members の FK**: 現状は auth_user_id 頼み。`payroll_employees.member_id UUID REFERENCES members(id)` を追加して人単位の給与合算 (兼務) を正式化

## 4. 適用順序 (データクリーニング時のチェックリスト)

1. テストデータ・重複の整理 (user 実施)
2. `members` に deleted_at 系列追加 / `clients` に deleted_by 等追加
3. SEQUENCE 作成 → backfill (§1.4) → NOT NULL/UNIQUE/DEFAULT
4. UI: 一覧系に deleted フィルタ + 「削除済みを表示」+ 復元 / 削除ボタンを soft 化 (物理 DELETE の廃止)
5. 一覧・詳細ヘッダーに内部ID表示 (C-xxxxxx / S-xxxxxx)
6. 新規登録フォームは番号入力なし (自動採番の表示のみ)

## 5. やらないこと

- `user_number` / `employee_number` の廃止 (レガシー連携・給与実務で現役)
- UUID 主キーの変更
- **`internal_number` に**法人コード等の意味を含めること (原則 2。※ §6 の業務番号は別で、意図的に意味を持たせる)
- 今あるデータの即時クリーニング (user が後日実施 → その時に §4)

---

## 6. 本番業務番号 (従業員番号 / 利用者番号) — 2026-07-16 user 確定

`internal_number` (§1, 無意味・人単位・恒久) とは**別の**、意味を持たせた対外/業務番号。
**採番の実行は「本番環境データの投入時」**。サンプルデータ期の現在は**設計のみ確定・据え置き**
(internal_number の暫定付番 §1.4 は今やる、は変わらず)。

### 6.0 共通ルール (従業員・利用者とも同じ)

- 番号は **(人 × 法人) 単位**。**法人内は 1 番号**、**法人をまたいだら新採番** (旧法人側は退職/契約終了として残す・退番)。
- 同一法人内の**事業所異動は番号を変えない** (入社/登録時の事業所3桁が歴史スタンプとして残る)。
- **1人が複数の業務番号を持ちうる** (在籍法人ごと)。人単位の突刺しは `internal_number` が担う ← 2番号モデルの根拠。
- 番号に刻む**事業所3桁は採番時の1事業所を焼き付ける** (`initial_office_id`)。恒久 `is_primary` フラグは**作らない**。
  採番時に単一所属なら自動、兼務入社なら**その1回だけ**主たる事業所を選ぶ。

### 6.1 従業員番号 (11桁)

```
[法人2] [事業所3] [個人6 = 入社月YYMM(4) + 月内順(2)]
例) KT・Hanaヘルパー花見川・2026-07 入社1人目 = 03 414 2607 01 = 03414260701
```

- 月内順 (下2桁) は **その法人・その月での登録順** (事業所をまたいで法人×月で通し、1 始まり)。
- 入社月の出所 = **`members.hire_date`** (存在確認済 2026-07-16)。`payroll_employees.hire_date` も有り。

### 6.2 利用者番号 (9桁)

```
[事業所3] [個人6 = 事業所内の通し連番]
例) 事業所713 = 713000001, 713000002 … (表の 713000000 は事業所プレフィクスの見出し)
```

- 従業員と違い**法人プレフィクスは無い**が、初期事業所3桁が実質的に法人を分けるので per-法人 ルールは成立。
- 6桁連番の単位は**初期事業所ごとの通し** (要実データ確認: 既存 `user_number` の採番実態に合わせる)。

### 6.3 保存場所 (新設テーブル案)

人本体 (members/clients) に詰めず、**(人 × 法人) の在籍/契約レコード**に持たせる (兼務・複数法人で破綻しないため)。

```sql
-- 従業員
member_company_employment (
  member_id UUID, company_id UUID,
  employee_number TEXT UNIQUE,       -- 11桁
  hire_date DATE,                    -- 入社月の元
  initial_office_id UUID,            -- 3桁の焼付元
  status TEXT                        -- 在籍 / 退職
)
-- 利用者 (同型)
client_company_registration (
  client_id UUID, company_id UUID,
  user_number_v2 TEXT UNIQUE,        -- 9桁 (既存 user_number と混同回避のため別列)
  registered_date DATE,
  initial_office_id UUID,
  status TEXT
)
```

### 6.4 マスタ列 新設 (本番採番の前提)

- `companies.company_code TEXT` — 法人番号2桁: **01 儀八 / 02 至誠堂 / 03 KT(ケイ・ティ・サービス) / 04 サービスワン / 05 ムツミ(商事)**
- `offices.office_code TEXT` — 事業所3桁 (表の「左3桁」。既存 `user_number` 上3桁とも一致)。
  ※ 既存 `offices.business_number` は10桁の介護保険事業所番号で**別物**。`office_code` は KT 内部コード。

### 6.5 本番採番の実装 TODO (投入時)

1. マスタ列 (§6.4) を埋める (法人5件、事業所は表 or 既存 user_number 先頭3桁から)。
2. `member_company_employment` / `client_company_registration` を作成。
3. 採番関数: 法人×月で seq を採る従業員番号 generator / 事業所で seq を採る利用者番号 generator (DB 関数 or 投入 script)。
4. `hire_date` 未入力者の月をどう埋めるかを投入前に確認 (members.hire_date の NULL 率を見る)。
5. UI: 従業員/利用者の登録時に自動採番・番号表示。兼務入社時のみ主たる事業所ピッカー。
