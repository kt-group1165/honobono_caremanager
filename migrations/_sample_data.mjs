/**
 * サンプルデータ投入の共通基盤 (2026-09-03)
 *
 * ルート直下 `SAMPLE_DATA_PROTOCOL.md` の取り決めを実装したもの。
 * 6 セッションが同じ本番 DB に書くため、**利用者・認定・公費・割当の作り方を 1 か所に寄せる**。
 *
 * 使う側:
 *   import { sb, TAGS, sampleClient, insertClient, deleteByTag, MONTH } from "./_sample_data.mjs";
 *
 * ⚠ 守ること
 *   - 対象月は MONTH (2026-12) 固定。2026-06 / 2026-07 には 1 行も入れない
 *   - 全行にマーカーを付ける (user_number = Z<tag><連番> / name 末尾 [sample-<tag>])
 *   - offices は 1 バイトも変更しない
 *   - --delete を先に確認してから --execute
 *   - error は必ず check する (silent failure を作らない)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const env = loadEnv();
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  // 1-2: 分母 0 で合格判定を出さないため、鍵が無ければ黙って続けず落とす
  throw new Error("SUPABASE_SERVICE_ROLE_KEY が .env.local にありません。中止します。");
}
export const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** 全業務で共通の対象月。★ 変更しないこと (SAMPLE_DATA_PROTOCOL 1章) */
export const MONTH = "2026-12";
export const MONTH_START = "2026-12-01";
export const MONTH_END = "2026-12-31";
export const TENANT = "kt-group";

/** 担当セッションの記号 */
export const TAGS = { j: "j", k: "k", l: "l", g: "g", c: "c", x: "x", h: "h", m: "m" };

export const marker = (tag) => `[sample-${tag}]`;
export const noteMarker = (tag) => `[sample-${tag}-20260903]`;
/** user_number は実データが数値なので Z 始まりは衝突しない */
export const userNumber = (tag, seq) => `Z${tag.toUpperCase()}${String(seq).padStart(3, "0")}`;
/**
 * 被保険者番号。★ clients と client_insurance_records の ★ 両方に同じ値を入れること。
 * 集計は認定側から読むので、片方だけだと伝送から除外される (2026-09-03)。
 */
export const sampleInsuredNumber = (tag, seq) =>
  `Z${tag}${String(seq).padStart(8, "0")}`.slice(0, 10);

/** 実データで使われている値 (2026-09-03 実測)。推測しないこと */
export const CARE_LEVELS = ["要支援1", "要支援2", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5"];

/**
 * 🔴 copay_rate は **テーブルで規約が違う** (2026-09-03 実測。J が発見)
 *
 *   clients.copay_rate                 "10" / "20" / "30"   (実データ 83/3/7 件)
 *   client_insurance_records.copay_rate "1" / "2" / "3"      (実データ 255/3/3 件)  ★ 割単位
 *
 * そして **集計が読むのは認定 (cert) 側**:
 *   aggregate.ts:1308  copayRaw >= 1 ? Math.min(copayRaw / 10, 1) : copayRaw
 *
 * → cert に "10" を入れると 負担率 1.0 = **10割自己負担** に潰れ、保険請求が 0 円になる。
 *   copayRaw は有限かつ >0 なので **未設定の警告も出ない**。段1 で期待値と突合しないと気づけない。
 *
 * そのため client 側と cert 側で値を分ける。**混ぜないこと。**
 */
export const COPAY = [
  { client: "10", cert: "1", benefit_rate: "90" }, // 1割
  { client: "20", cert: "2", benefit_rate: "80" }, // 2割
  { client: "30", cert: "3", benefit_rate: "70" }, // 3割
];
/** 区分支給限度基準額 (告示値)。lib/kubun-gendo.ts と同じ値であることを検証済 (2026-09-03) */
export const LIMIT_UNITS = {
  要支援1: 5032, 要支援2: 10531,
  要介護1: 16765, 要介護2: 19705, 要介護3: 27048, 要介護4: 30938, 要介護5: 36217,
};

/**
 * サンプル利用者 1 名分の payload を組み立てる (INSERT はしない)。
 * 呼び出し側でバリエーションを上書きできる。
 */
export function sampleClient({ tag, seq, careLevel = "要介護2", copayIdx = 0, insurerNumber = "121012", extra = {} }) {
  const un = userNumber(tag, seq);
  const { client: copay_rate, benefit_rate } = COPAY[copayIdx]; // ★ clients は "10"/"20"/"30"
  return {
    tenant_id: TENANT,
    user_number: un,
    name: `サンプル${seq} ${marker(tag)}`,
    furigana: "サンプル",
    care_level: careLevel,
    copay_rate,
    benefit_rate,
    insurer_number: insurerNumber,
    insured_number: sampleInsuredNumber(tag, seq), // ★ 認定側にも同じ値を入れること
    birth_date: "1940-01-01",
    status: "active",
    certification_start_date: "2026-04-01",
    certification_end_date: "2027-03-31",
    ...extra,
  };
}

/**
 * 認定 1 世代分。care_level から限度額を告示値で埋める。
 *
 * 🔴 `insuredNumber` を必ず渡すこと (2026-09-03 実測。K が発見)
 *   集計は 被保険者番号を ★ 認定側から読む (aggregate.ts:1978 `cert?.insured_number`)。
 *   clients 側にだけ入れても、認定側が空だと buildKokuhoDensou が
 *   「被保険者番号が未登録」として ★ 伝送から丸ごと除外する。
 *   → 段2 (伝送様式) が 0 行になり、何も検証できないまま「通った」ように見える。
 *   ⚠ clients だけ見ると入っているように見えるので気づきにくい。
 *     copay_rate と同じ「同じ名前の列が2つの表にあって片方だけ」の型。
 *   ★ 省略時は sampleClient と同じ規則 (tag+seq) で自動生成する。
 */
export function sampleInsurance(clientId, { careLevel = "要介護2", copayIdx = 0, insurerNumber = "121012", tag = null, seq = null, insuredNumber = null, extra = {} } = {}) {
  const { cert: copay_rate, benefit_rate } = COPAY[copayIdx]; // ★ 認定は "1"/"2"/"3" (割単位)
  const insured_number =
    insuredNumber ?? (tag != null && seq != null ? sampleInsuredNumber(tag, seq) : null);
  if (!insured_number) {
    throw new Error(
      "sampleInsurance: insuredNumber (または tag+seq) が必要です。" +
        "認定側の被保険者番号が空だと伝送から除外され、段2 が 0 行になります",
    );
  }
  return {
    tenant_id: TENANT,
    client_id: clientId,
    insured_number,
    effective_date: "2026-04-01",
    care_level: careLevel,
    certification_start_date: "2026-04-01",
    certification_end_date: "2027-03-31",
    insurer_number: insurerNumber,
    copay_rate,
    benefit_rate,
    certification_status: "認定済み",
    record_status: "認定済み",
    service_limit_amount: LIMIT_UNITS[careLevel] ?? null,
    service_limit_period_start: "2026-04-01",
    service_limit_period_end: "2027-03-31",
    ...extra,
  };
}

export function sampleAssignment(clientId, officeId, extra = {}) {
  return { tenant_id: TENANT, client_id: clientId, office_id: officeId, start_date: "2026-04-01", ...extra };
}

/**
 * 公費 1 件。**書き込み先は `client_kohi_records`**。
 *
 * 🔴 公費の表は ★ 2 つある (2026-09-03 実測)
 *   client_kohi_records     356行 … ★ kaigo-app の集計・伝送はこちらを読む (lib/kohi.ts)
 *   client_public_expenses    1行 … order-app の BillingTab / ClientsTab が読む (福祉用具)
 *   ⚠ 両方に公費がある利用者は 0 名。**利用者の重なりが無いので今は食い違いようがない**
 *
 * ⚠ 以前この関数は `client_public_expenses` の列名で payload を組んでいた。
 *   それを kaigo-app の伝送検証に使うと **黙って効かない** (集計が読まない表なので)。
 *   ★ 「入れたのに公費が出ない」を「実装のバグ」と誤読しかねなかった。
 */
export const KOHI_TABLE = "client_kohi_records";

export function sampleKohi(clientId, { hohei = "12", futansha = "12123519", jukyusha = "0000001", priority = 1, honninFutan = 0, extra = {} } = {}) {
  return {
    tenant_id: TENANT, client_id: clientId,
    kohi_hobetsu: hohei, futansha_number: futansha, jukyusha_number: jukyusha,
    start_date: "2026-04-01", end_date: "2027-03-31",
    priority, honnin_futan: honninFutan,
    notes: `[sample] ${MONTH}`,
    ...extra,
  };
}

/** @deprecated ★ order-app 側の表 (client_public_expenses) に書く。kaigo-app の伝送には効かない */
export function samplePublicExpense(clientId, { hohei = "12", futansha = "12123519", jukyusha = "0000001", extra = {} } = {}) {
  return {
    tenant_id: TENANT, client_id: clientId,
    hohei_code: hohei, futan_sha_number: futansha, jukyu_sha_number: jukyusha,
    valid_start: "2026-04-01", valid_end: "2027-03-31", ...extra,
  };
}

/** INSERT して id を返す。error は握りつぶさない */
export async function insertRows(table, rows, { dryRun = true } = {}) {
  if (!rows.length) return [];
  if (dryRun) {
    console.log(`  [DRY] ${table} に ${rows.length} 行`);
    return rows.map((_, i) => `dry-${i}`);
  }
  // 🔴 ★ 行ごとにキー集合が違うと PostgREST が壊れる (2026-09-04 実測。I が発見)
  //   `.insert([複数行])` は **全行の和集合**で列を組み立て、
  //   ★ 持っていない行には NULL を明示送信する。
  //   → DB の DEFAULT が効かず ★ NOT NULL 違反で落ちる (jusho_tokurei で実際に踏んだ)
  //   → 落ちずに通ってしまう列もあり、その場合は ★ 黙って NULL が入る (もっと悪い)
  //
  //   なのでキー集合ごとにグループ分けして別々に INSERT する。
  //   ★ 返す id は 呼び出し側が渡した順に並べ直す (index で対応させる前提のため)。
  const sig = (r) => Object.keys(r).sort().join("|");
  const groups = new Map();
  rows.forEach((r, i) => {
    const k = sig(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ i, r });
  });
  if (groups.size > 1) {
    console.log(`  ⚠ ${table}: 行ごとにキー集合が ${groups.size} 種類 → ★ 分けて INSERT します`);
  }
  const ids = new Array(rows.length);
  for (const [, items] of groups) {
    const { data, error } = await sb.from(table).insert(items.map((x) => x.r)).select("id");
    if (error) throw new Error(`${table} INSERT 失敗: ${error.message}`);
    if (!data || data.length !== items.length) {
      throw new Error(`${table}: ${items.length} 行送って ${data?.length ?? 0} 行しか返らない`);
    }
    data.forEach((d, j) => { ids[items[j].i] = d.id; });
  }
  if (ids.some((v) => v === undefined)) throw new Error(`${table}: id が取れていない行があります`);
  return ids;
}

/**
 * ★ 撤去。--execute より先にこれが動くことを確認すること。
 * clients を消す前に子テーブルから消す (FK)。
 */
/**
 * @param extraTables 各業務が自分の表を足す。**利用者を指す列名がテーブルで違う**ので
 *   文字列 = `client_id` で消す / `{ table, key }` = その列で消す
 *   ⚠ 実例: `kaigo_visit_schedule` は ★ `user_id` (`client_id` ではない)。
 *      文字列で渡すと 42703 で落ちる (G が実際に踏んだ)
 *   例: extraTables: [{ table: "kaigo_visit_schedule", key: "user_id" }, "kaigo_visit_addon_lines"]
 */
export async function deleteByTag(tag, { dryRun = true, extraTables = [] } = {}) {
  const { data: cs, error } = await sb
    .from("clients").select("id,user_number,name")
    .like("user_number", `Z${tag.toUpperCase()}%`);
  if (error) throw new Error(`clients 取得失敗: ${error.message}`);

  // 🔴 ★ 接頭辞だけで消してはいけない (2026-09-05。I が衝突を発見)
  //   user_number の接頭辞 `Z<TAG>` は ★ セッション間で衝突する。
  //   実例: 移動支援 (tag=l) の seed が ★ ZM% を使っていて、
  //         総合事業 (tag=m) の ZM% と ★ 同じ空間に入っていた。
  //   接頭辞だけで消すと ★ 他セッションのサンプルを巻き込む。
  //   → 氏名の `[sample-<tag>]` マーカーも ★ 両方一致した行だけ消す。
  const mk = marker(tag);
  const mine = (cs ?? []).filter((c) => String(c.name ?? "").includes(mk));
  const others = (cs ?? []).filter((c) => !String(c.name ?? "").includes(mk));
  if (others.length) {
    // ★ 黙って飛ばさない。誰のものかを出す
    console.log(`⚠ ★ 接頭辞 Z${tag.toUpperCase()} に一致するが マーカー ${mk} を持たない行が ${others.length} 件`);
    for (const c of others.slice(0, 5)) console.log(`     ${c.user_number}  ${c.name}  ← ★ 他セッションのものとして 消しません`);
    if (others.length > 5) console.log(`     … 他 ${others.length - 5} 件`);
  }
  const ids = mine.map((c) => c.id);
  console.log(`撤去対象: clients ${ids.length} 名 (user_number LIKE 'Z${tag.toUpperCase()}%' ★ かつ 氏名に ${mk})`);
  if (!ids.length) return 0;

  // 子から順に。extraTables は各業務が自分の表を足す
  const tables = [
    ...extraTables,
    "client_kohi_records",      // ★ kaigo-app の集計・伝送が読むほう
    "client_public_expenses",   // order-app 側
    "client_office_assignments",
    "client_insurance_records",
  ];
  for (const spec of tables) {
    const t = typeof spec === "string" ? spec : spec.table;
    const key = typeof spec === "string" ? "client_id" : (spec.key ?? "client_id");
    if (dryRun) { console.log(`  [DRY] ${t} から ${key} in (${ids.length}件) を削除`); continue; }
    const { error: e } = await sb.from(t).delete().in(key, ids);
    if (e) throw new Error(`${t} (${key}) DELETE 失敗: ${e.message}`);
    // ★ 消えたことを確認する。消し漏れを黙って通さない
    const { data: rest, error: e4 } = await sb.from(t).select("id").in(key, ids).limit(1);
    if (e4) throw new Error(`${t} 確認失敗: ${e4.message}`);
    if ((rest ?? []).length) throw new Error(`${t} (${key}) を削除したのに行が残っている`);
    console.log(`  ${t} (${key}) 削除完了・残0を確認`);
  }
  if (dryRun) { console.log(`  [DRY] clients から ${ids.length} 行を削除`); return ids.length; }
  const { error: e2 } = await sb.from("clients").delete().in("id", ids);
  if (e2) throw new Error(`clients DELETE 失敗: ${e2.message}`);

  // ★ 撤去後に 0 件を確認する (SAMPLE_DATA_PROTOCOL 7章)
  const { data: left, error: e3 } = await sb
    .from("clients").select("id,name").like("user_number", `Z${tag.toUpperCase()}%`);
  if (e3) throw new Error(`確認クエリ失敗: ${e3.message}`);
  // ★ 自分のマーカーを持つ行だけが 0 であればよい (他セッションのぶんは残っていて正しい)
  const leftMine = (left ?? []).filter((c) => String(c.name ?? "").includes(mk));
  if (leftMine.length !== 0) throw new Error(`撤去したのに ${leftMine.length} 行残っている`);
  console.log(`✅ 撤去完了。残 0 件を確認`);
  return ids.length;
}

/** 対象月が 2026-06/07 でないことを守る門番 */
export function assertSafeMonth(ym) {
  if (ym === "2026-06" || ym === "2026-07" || ym === "202606" || ym === "202607") {
    throw new Error(`対象月 ${ym} は実データの突合に使う月です。サンプルを入れてはいけません`);
  }
}

/**
 * サービス名 → **対象月に有効な世代**のサービスコードを引く。
 *
 * ⚠ **マスタの固定値をサンプル script にコピペしないため**のヘルパー。
 *   サービスコードは世代管理されているので、月が変われば単位数も変わりうる。
 *
 * 🔴 **ただし「マスタから引けば正しい期待値になる」は常には成り立たない。**
 *   身体９系のように **所要時間で単位数が変わる可変コード**があり、その場合
 *   マスタの `units` は **基準値にすぎない** (2026-09-03 K の発見)。
 *   そこで `formula` も一緒に返し、可変コードの `units` をそのまま期待値に
 *   使おうとしたら **警告する** (`expectUnits()`)。
 *
 * @param serviceName kaigo_service_codes.service_name と完全一致する名前
 * @param opts.system "介護" | "障害" | "総合事業"
 * @param opts.month  "YYYY-MM" (既定は MONTH = 2026-12)
 * @param opts.codePrefix 総合事業の自治体 prefix 等 ("MB_")。前方一致で絞る
 * @param opts.calculationType 既定 "基本"
 * @returns { service_code, service_name, units, unit_type, formula, isVariable }
 */
export async function lookupUnits(serviceName, opts = {}) {
  const { system = "介護", month = MONTH, codePrefix = null, calculationType = "基本" } = opts;
  let q = sb
    .from("kaigo_service_codes")
    .select("service_code, service_name, units, unit_type, formula, valid_from, valid_until")
    .eq("system", system)
    .eq("service_name", serviceName);
  if (calculationType) q = q.eq("calculation_type", calculationType);
  if (codePrefix) q = q.like("service_code", `${codePrefix}%`);
  const { data, error } = await q;
  if (error) throw new Error(`サービスコード取得失敗 (${serviceName}): ${error.message}`);
  const first = `${month}-01`;
  const hits = (data ?? []).filter(
    (r) => (!r.valid_from || r.valid_from <= first) && (!r.valid_until || r.valid_until >= first),
  );
  if (hits.length === 0) {
    throw new Error(
      `${month} に有効な「${serviceName}」(system=${system}${codePrefix ? ` / ${codePrefix}` : ""}) がマスタにありません`,
    );
  }
  if (hits.length > 1) {
    console.warn(
      `  ⚠ 「${serviceName}」が ${month} に ${hits.length} 件該当します ` +
        `(${hits.map((h) => h.service_code).join(", ")})。先頭を使います — 絞り込み条件を足すこと`,
    );
  }
  const h = hits[0];
  // 🔴 「可変」の判定は formula だけでは足りない。
  //   身体９系 (112397 身体９・Ⅰ 等) は **formula=null かつ units=0** で、
  //   所要時間から単位を出す可変コード (2026-09-03 実測)。
  //   → 基本コードなのに units=0 のものも「可変(または未登録)」として扱う。
  //     どちらにせよ units をそのまま期待値にしてはいけない。
  const isVariable = h.formula != null || (calculationType === "基本" && Number(h.units) === 0);
  return { ...h, isVariable };
}

/**
 * `lookupUnits()` の結果から**期待値として使ってよい単位数**を取り出す。
 *
 * ⚠ 可変コード (formula あり) の `units` は基準値なので、そのまま期待値にすると
 *   間違える。**気づかず使うのを防ぐため警告する。**
 *   可変コードの期待値は所要時間や回数から**呼び出し側が導出**すること。
 */
export function expectUnits(master, { silent = false } = {}) {
  if (master.isVariable && !silent) {
    console.warn(
      `  🔴 ${master.service_code} (${master.service_name}) は ` +
        `${master.formula != null ? "formula を持つ" : "基本コードなのに units=0 の"} **可変コード**です。` +
        `\n     マスタの units=${master.units} は **基準値**にすぎません。` +
        `\n     所要時間・回数から期待値を導出してください (そのまま使うと誤った期待値になります)。`,
    );
  }
  return master.units;
}
