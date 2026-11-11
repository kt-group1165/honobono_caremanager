import type { SupabaseClient } from "@supabase/supabase-js";
import { mapChunksParallel, ID_IN_CHUNK } from "./chunk-parallel";
import { isYoboLevel } from "./yobo-kubun";
import { resolveBenefitForMonth, type BenefitCertRow, type BenefitForMonth } from "./insurance/cert-month";
import { getPerOfficeOfficeIds, sharedScopeOrFilter } from "./insurance/office-scope";

/**
 * 認定情報 (client_insurance_records) を「対象月に有効な認定」で解決する共有リゾルバ。
 *
 * 背景 (2026-07-08 総点検): 各画面が「effective_date / certification_start_date の
 * 最新 1 件」を使っていたため、月遅れ再請求で認定更新・区分変更を跨ぐと
 * 古い提供月のレセプトに新しい要介護度・負担割合・被保険者番号が載っていた。
 *
 * 選択規則:
 *   1. certification_start_date <= 対象月末 かつ (certification_end_date IS NULL
 *      または >= 対象月初) の行のうち、certification_start_date が最新のもの
 *   2. 該当なしなら従来どおり最新 1 件 (isFallback=true) — 認定期間未入力の
 *      既存データを壊さないための安全網
 *
 * 日付は 'YYYY-MM-DD' の文字列比較 (Date パースなし = タイムゾーン安全)。
 */

export interface CertForMonth {
  insurer_number: string | null;
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  copay_rate: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  certification_status: string | null;
  service_limit_amount: number | null;
  /**
   * 限度額適用期間 (開始/終了)。区分変更等で認定有効期間と異なることがある
   * (ほのぼの「適用期間（居宅ｻｰﾋﾞｽ区分）」由来。給付管理票 8222 項13/14 はこちらが正)。
   * 列未適用 (kyotaku_limit_period.sql) の環境では null。
   */
  limit_period_start: string | null;
  limit_period_end: string | null;
  /** 当該事業所のサービス提供開始年月日 (明細書 項21)。add_service_start_date.sql 未適用なら undefined */
  service_start_date?: string | null;
  care_office_id: string | null;
  care_office_number: string | null;
  care_office_name: string | null;
  effective_date: string | null;
  /** 対象月に有効な認定が無く「最新 1 件」へフォールバックした */
  isFallback: boolean;
  /**
   * その月の負担割合の解決結果 (client_benefit_certificates。2026-11-09 FY-H)。
   * 表が未適用・読めないときは undefined (copay_rate は認定行の値のまま)。
   */
  benefit?: BenefitForMonth;
  /** 負担割合証で copay_rate を置き換えたとき、置き換える前の認定行の値 (監査用) */
  copay_rate_cert_row?: string | null;
}

interface DbRow {
  client_id: string;
  insurer_number: string | null;
  insurer_name: string | null;
  insured_number: string | null;
  care_level: string | null;
  copay_rate: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  certification_status: string | null;
  service_limit_amount: number | null;
  limit_period_start?: string | null;
  service_start_date?: string | null;
  limit_period_end?: string | null;
  care_office_id: string | null;
  care_office_number: string | null;
  care_office_name: string | null;
  effective_date: string | null;
}

const SELECT_COLS_BASE =
  "client_id, insurer_number, insurer_name, insured_number, care_level, copay_rate, " +
  "certification_start_date, certification_end_date, certification_status, service_limit_amount, " +
  "care_office_id, care_office_number, care_office_name, effective_date";
// 限度額適用期間 (kyotaku_limit_period.sql) / サービス提供開始日 (add_service_start_date.sql)。
//   列未適用の環境は 42703 → BASE で再試行するので、未適用でも動く
const SELECT_COLS =
  SELECT_COLS_BASE + ", limit_period_start, limit_period_end, service_start_date";

const PAGE = 1000;
const IN_CHUNK = ID_IN_CHUNK;

/** 対象月の月初/月末 ('YYYY-MM-DD')。ローカル演算のみで TZ 安全 */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate(); // ローカル。toISOString は使わない
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * client ごとの全認定行を集める (chunk + order 付き page-loop)。
 * per-client の並びは certification_start_date DESC, effective_date DESC
 * (resolveCertForMonth 従来の取得順そのまま)。
 */
async function fetchCertRowsByClient(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, DbRow[]>> {
  // limit_period_* 列未適用の環境は 42703 → 列なしで再試行 (モジュール内で1度だけ落とす)
  let selectCols = SELECT_COLS;
  // ★ 2026-11-11 事業所別保険 規則 3: per_office (切替済み) の事業所の行は kaigo (shared) の候補から外す。0 なら絞らない
  const scopeOr = sharedScopeOrFilter(await getPerOfficeOfficeIds(supabase));
  // chunk は並列 (直列だと 1000 名規模で chunk 数 × 往復時間 = 数十秒待ちになる)
  const perChunk = await mapChunksParallel(ids, IN_CHUNK, async (chunk) => {
    const acc: DbRow[] = [];
    let offset = 0;
    while (true) {
      let q = supabase
        .from("client_insurance_records")
        .select(selectCols)
        .in("client_id", chunk);
      if (scopeOr) q = q.or(scopeOr);
      const { data, error } = await q
        .order("client_id", { ascending: true })
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .order("effective_date", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);
      if (error) {
        if (selectCols !== SELECT_COLS_BASE && (error.code === "42703" || /does not exist/i.test(error.message ?? ""))) {
          selectCols = SELECT_COLS_BASE;
          continue;
        }
        throw new Error(`認定情報の取得に失敗: ${error.message}`);
      }
      const rows = (data ?? []) as unknown as DbRow[];
      acc.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return acc;
  });
  // chunk 順・chunk 内の DB order のまま連結 (per-client の並びは start_date DESC を保つ)
  const byClient = new Map<string, DbRow[]>();
  for (const rows of perChunk) {
    for (const r of rows) {
      if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
      byClient.get(r.client_id)!.push(r);
    }
  }
  return byClient;
}

function toCertForMonth(r: DbRow, isFallback: boolean): CertForMonth {
  return {
    insurer_number: r.insurer_number,
    insurer_name: r.insurer_name,
    insured_number: r.insured_number,
    care_level: r.care_level,
    copay_rate: r.copay_rate,
    certification_start_date: r.certification_start_date,
    certification_end_date: r.certification_end_date,
    certification_status: r.certification_status,
    service_limit_amount: r.service_limit_amount,
    limit_period_start: r.limit_period_start ?? null,
    limit_period_end: r.limit_period_end ?? null,
    service_start_date: r.service_start_date ?? null,
    care_office_id: r.care_office_id,
    care_office_number: r.care_office_number,
    care_office_name: r.care_office_name,
    effective_date: r.effective_date,
    isFallback,
  };
}

/** 対象月の選択に使う最小の列 (DbRow 以外の行型 = 帳票の印刷・検査からも同じ規則で選ぶため) */
export interface CertRowForMonthLike {
  certification_start_date: string | null;
  certification_end_date: string | null;
  effective_date?: string | null;
  copay_rate?: string | null;
  care_level?: string | null;
  service_limit_amount?: number | null;
}

/** 対象月に有効な認定か (start <= 月末 AND (end IS NULL OR end >= 月初)) */
const isValidInMonth = (r: CertRowForMonthLike, monthStart: string, monthEnd: string): boolean => {
  if (!r.certification_start_date) return false;
  if (r.certification_start_date > monthEnd) return false;
  if (r.certification_end_date && r.certification_end_date < monthStart) return false;
  return true;
};

/**
 * clientIds ごとに対象月 (year, month) に有効な認定を解決する。
 * 戻り値の Map に無い client は認定レコード自体が 0 件。
 */
export async function resolveCertForMonth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
): Promise<Map<string, CertForMonth>> {
  const out = new Map<string, CertForMonth>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return out;
  const { from: monthStart, to: monthEnd } = monthRange(year, month);

  const [byClient, benefitByClient] = await Promise.all([
    fetchCertRowsByClient(supabase, ids),
    fetchBenefitCertsByClient(supabase, ids),
  ]);
  const picked = pickCertForMonth(byClient, monthStart, monthEnd);
  applyBenefitCerts(picked, byClient, benefitByClient, monthStart, monthEnd);
  return picked;
}

// ─── 負担割合証 (client_benefit_certificates) で copay_rate を「その月の負担割合」にする ───
//
//   2026-11-09 FY-H (user 合意)。負担割合証は 8/1 に切り替わり、認定期間と揃わないため、
//   認定行の copay_rate (1 つだけ) では認定期間の途中で割合が変わる人が誤る (48 名 52 行)。
//   規則は共通の純関数 ./insurance/cert-month.ts (order-app と同じ中身) の resolveBenefitForMonth。
//
//   ★ 置き換えるのは「その月に負担割合証がある」(source='certificate') ときだけ。
//     負担割合証が無い月は copay_rate を認定行の値のまま (= 従来と 1 円も変わらない) にし、
//     benefit.source='cert_row' と警告を持たせるだけ。
//     (純関数の cert_row は benefit_rate を優先するが、kaigo は従来 copay_rate だけで請求して
//      いたので、ここで置き換えると負担割合証の無い人の金額が動いてしまう)
//   ★ 置き換えるのは 1〜3 割 (給付率 90/80/70) のときだけ。給付率 100 (0 割) や 91 のような
//     値は kaigo の請求 (copay <= 0 → 既定 1 割) と噛み合わないので置き換えず警告を足す。
//   ★ 表が未適用・読めないときは従来どおり (console.error を出す)。

/** テスト用: 表の代わりにメモリ上の負担割合証を与える (null で解除)。本番コードからは呼ばない */
let benefitCertsOverride: Map<string, BenefitCertRow[]> | null = null;
export function __setBenefitCertsOverrideForTest(m: Map<string, BenefitCertRow[]> | null): void {
  benefitCertsOverride = m;
}

let benefitTableMissingLogged = false;
const isTableMissing = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "PGRST205" || e.code === "42P01" || /Could not find the table|does not exist/i.test(e.message ?? ""));

type BenefitDbRow = BenefitCertRow & { client_id: string };

/** client ごとの負担割合証等。表が無い・読めないときは null (呼び出し側は従来どおり) */
async function fetchBenefitCertsByClient(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, BenefitCertRow[]> | null> {
  if (benefitCertsOverride) return benefitCertsOverride;
  try {
    const scopeOr = sharedScopeOrFilter(await getPerOfficeOfficeIds(supabase));
    const perChunk = await mapChunksParallel(ids, IN_CHUNK, async (chunk) => {
      const acc: BenefitDbRow[] = [];
      let offset = 0;
      while (true) {
        let q = supabase
          .from("client_benefit_certificates")
          .select("id, client_id, kind, benefit_rate, valid_from, valid_to, office_id, restriction")
          .in("client_id", chunk);
        if (scopeOr) q = q.or(scopeOr);
        const { data, error } = await q
          .order("client_id", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as unknown as BenefitDbRow[];
        acc.push(...rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
      return acc;
    });
    const m = new Map<string, BenefitCertRow[]>();
    for (const rows of perChunk) {
      for (const r of rows) {
        if (!m.has(r.client_id)) m.set(r.client_id, []);
        m.get(r.client_id)!.push(r);
      }
    }
    return m;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (isTableMissing(err)) {
      if (!benefitTableMissingLogged) {
        benefitTableMissingLogged = true;
        console.error("負担割合証の表 client_benefit_certificates が未作成のため、負担割合は認定行の値のまま計算します (migrations/client_benefit_certificates.sql)");
      }
    } else {
      console.error(`負担割合証 (client_benefit_certificates) を読めなかったため、負担割合は認定行の値のまま計算します: ${err?.message ?? String(e)}`);
    }
    return null;
  }
}

/** 置き換えてよい負担割合 (割) か */
const isReplaceableWari = (w: number | null): w is number => w === 1 || w === 2 || w === 3;

/**
 * 解決済みの CertForMonth に「その月の負担割合」を反映する (in place)。fetch なし = テストから呼べる。
 */
export function applyBenefitCertsToCert(
  cert: CertForMonth,
  certRows: Array<{
    certification_start_date: string | null; certification_end_date: string | null; effective_date: string | null;
    copay_rate: string | null; care_level: string | null; service_limit_amount: number | null;
  }>,
  benefitCerts: BenefitCertRow[],
  monthStart: string,
  monthEnd: string,
): void {
  const b = resolveBenefitForMonth(certRows, benefitCerts, monthStart, monthEnd);
  cert.benefit = b;
  if (b.source !== "certificate") return;
  if (!isReplaceableWari(b.copayWari)) {
    b.warnings.push(`負担割合証の給付率 ${b.benefitRate ?? "?"}% は 1〜3 割に当たらないため、認定行の負担割合 (${cert.copay_rate ?? "未設定"}) のまま計算しました`);
    return;
  }
  const next = String(b.copayWari);
  if (cert.copay_rate !== next) {
    cert.copay_rate_cert_row = cert.copay_rate;
    cert.copay_rate = next;
  }
}

/** benefitByClient が null (表なし・読めない) なら何もしない */
function applyBenefitCerts(
  out: Map<string, CertForMonth>,
  byClient: Map<string, DbRow[]>,
  benefitByClient: Map<string, BenefitCertRow[]> | null,
  monthStart: string,
  monthEnd: string,
): void {
  if (!benefitByClient) return;
  for (const [clientId, cert] of out) {
    applyBenefitCertsToCert(cert, byClient.get(clientId) ?? [], benefitByClient.get(clientId) ?? [], monthStart, monthEnd);
  }
}

function applyBenefitCertsMany(
  out: Map<string, CertForMonth[]>,
  byClient: Map<string, DbRow[]>,
  benefitByClient: Map<string, BenefitCertRow[]> | null,
  monthStart: string,
  monthEnd: string,
): void {
  if (!benefitByClient) return;
  for (const [clientId, certs] of out) {
    // 月内の全認定に同じ「その月の負担割合」を当てる (保険者変更の分割セグメントも同じ割合で出る)
    for (const c of certs) {
      applyBenefitCertsToCert(c, byClient.get(clientId) ?? [], benefitByClient.get(clientId) ?? [], monthStart, monthEnd);
    }
  }
}

/**
 * 同着 (certification_start_date と effective_date が同じ) の中から 1 件を決める。
 *
 *   ⚠ 2026-09-03 追加。**これが無いと採用行が実行ごとに変わりうる。**
 *     DB の order は (start DESC, effective DESC) の 2 キーだけなので、
 *     両方が同値の重複行の並びは **Postgres の物理順まかせ = 未定義**。
 *     同じ月を 2 回請求すると別の行が採られ、金額が変わりうる。
 *
 *   採用規則: **入力済みの値を持つ行を優先する**。
 *     取込の経路上、copay_rate が null なのは「負担割合 CSV が当たらなかった行」で、
 *     値が入っている行のほうが後から是正されたもの。null を採ると
 *     aggregate.ts:1310 が **既定 1 割**に倒すため、2割/3割の人が
 *     **保険請求 10〜20% 過大**になる (後 貞雄で実測 11,078 vs 正 9,847 = 1,231円)。
 *
 *   ⚠ **効くのは負担割合だけではない。** service_limit_amount (区分支給限度額) が
 *     null の行を採ると 限度額超過の判定が変わり、**超過自費**が動く。
 *     金額の出方は負担割合と同じ (保険↓ / 利用者↑ / 総額不変) なので
 *     **smoke の差分を「負担割合の是正」だけで説明しようとすると残差が出る**。
 *     2026-06 の実測: 採用行が変わる 12 名のうち copay が動くのは 7 名
 *     (金額が動くのは 古川且昇 1 名のみ)、限度額が動くのが 5 名。
 *
 *   ⚠ 旧挙動は未定義なので **再現できない**。「是正前は誰がどうだったか」は
 *     旧値から逆算できない。影響を測るときは是正前後の**金額**を突き合わせること。
 */
const certCompleteness = (r: CertRowForMonthLike): number =>
  (r.copay_rate == null || r.copay_rate === "" ? 0 : 4) + // copay_rate は string 列。空文字も未入力
  (r.care_level == null || r.care_level === "" ? 0 : 2) +
  (r.service_limit_amount == null ? 0 : 1);

/** 同着行のうち最も情報が揃っている 1 件 (同点なら元の並びの先頭 = 安定) */
export function pickAmongTies(inMonth: DbRow[]): DbRow | undefined {
  return pickAmongTiesOf(inMonth);
}

function pickAmongTiesOf<T extends CertRowForMonthLike>(inMonth: T[]): T | undefined {
  const head = inMonth[0];
  if (!head) return undefined;
  let best = head;
  let bestScore = certCompleteness(head);
  for (const r of inMonth) {
    if (r.certification_start_date !== head.certification_start_date) break; // start DESC 順
    if (r.effective_date !== head.effective_date) break;
    const s = certCompleteness(r);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return best;
}

/** DB の order (certification_start_date DESC NULLS LAST, effective_date DESC NULLS LAST) と同じ並べ替え (安定) */
const descNullsLast = (a: string | null | undefined, b: string | null | undefined): number => {
  if (a == null || a === "") return b == null || b === "" ? 0 : 1;
  if (b == null || b === "") return -1;
  return a > b ? -1 : a < b ? 1 : 0;
};

/**
 * 認定行の配列 (並び順は問わない) から「対象月 (year, month) に有効な 1 件」を選ぶ純関数。
 * resolveCertForMonth と同じ規則 (有効期間の判定 + 開始日が最新 + 同着は pickAmongTies)。
 * ★ フォールバックしない: 対象月に有効な認定が無ければ null (どこへ倒すかは呼出側が決める)。
 *   帳票の印刷 (reports-content.tsx の fetchMasterForDoc) と
 *   scripts/report-master-drift-check.mts が同じこの関数で選ぶ (2026-11-09 FY-R)。
 */
export function pickCertRowForMonth<T extends CertRowForMonthLike>(rows: T[], year: number, month: number): T | null {
  const { from: monthStart, to: monthEnd } = monthRange(year, month);
  const sorted = [...rows].sort((a, b) =>
    descNullsLast(a.certification_start_date, b.certification_start_date) ||
    descNullsLast(a.effective_date, b.effective_date));
  return pickAmongTiesOf(sorted.filter((r) => isValidInMonth(r, monthStart, monthEnd))) ?? null;
}

/** 'YYYY-MM' (または 'YYYY-MM-DD') の帳票対象月 → { year, month }。読めなければ null */
export function parseYearMonth(ym: string | null | undefined): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{1,2})/.exec(String(ym ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** 取得済みの認定行から「対象月の 1 件」を選ぶ (fetch なし) */
function pickCertForMonth(
  byClient: Map<string, DbRow[]>,
  monthStart: string,
  monthEnd: string,
): Map<string, CertForMonth> {
  const out = new Map<string, CertForMonth>();
  for (const [clientId, rows] of byClient) {
    // 1) 対象月に有効な認定 (start <= 月末 AND (end IS NULL OR end >= 月初))
    const inMonth = rows.filter((r) => isValidInMonth(r, monthStart, monthEnd));
    // rows は start_date DESC 順なので先頭が「対象月に有効な最新の認定」
    //   ⚠ ただし同着は並びが未定義なので pickAmongTies で決定的に選ぶ
    const picked = pickAmongTies(inMonth) ?? rows[0];
    if (!picked) continue;
    out.set(clientId, toCertForMonth(picked, inMonth.length === 0));
  }
  return out;
}

/**
 * clientIds ごとに「対象月に有効な全認定行」を certification_start_date 昇順で返す
 * (月途中の資格変更 = 区分変更/保険者変更 の検出用。Phase 1)。
 *
 * resolveCertForMonth と違いフォールバックしない — 対象月に有効な認定が 1 件も無い
 * client は Map に入らない。同一 certification_start_date の重複行 (編集履歴・二重登録)
 * は effective_date が最新の 1 件に dedupe する (誤検出防止)。
 */
export async function resolveCertsInMonth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
): Promise<Map<string, CertForMonth[]>> {
  const out = new Map<string, CertForMonth[]>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return out;
  const { from: monthStart, to: monthEnd } = monthRange(year, month);

  const [byClient, benefitByClient] = await Promise.all([
    fetchCertRowsByClient(supabase, ids),
    fetchBenefitCertsByClient(supabase, ids),
  ]);
  const picked = pickCertsInMonth(byClient, monthStart, monthEnd);
  applyBenefitCertsMany(picked, byClient, benefitByClient, monthStart, monthEnd);
  return picked;
}

/** 取得済みの認定行から「対象月に有効な全件 (start 昇順)」を選ぶ (fetch なし) */
function pickCertsInMonth(
  byClient: Map<string, DbRow[]>,
  monthStart: string,
  monthEnd: string,
): Map<string, CertForMonth[]> {
  const out = new Map<string, CertForMonth[]>();
  for (const [clientId, rows] of byClient) {
    // rows は start DESC, effective DESC — 同一 start は先頭 (= 最新 effective) を採用
    //   ⚠ 同一 start かつ同一 effective の重複は **DB の並びが未定義**なので、
    //     先頭ではなく pickAmongTies (= 情報が揃っている行) で決定的に選ぶ
    const byStart = new Map<string, DbRow[]>();
    for (const r of rows) {
      if (!isValidInMonth(r, monthStart, monthEnd)) continue;
      const start = r.certification_start_date!;
      if (!byStart.has(start)) byStart.set(start, []);
      byStart.get(start)!.push(r);
    }
    const inMonth: DbRow[] = [];
    for (const group of byStart.values()) {
      const picked = pickAmongTies(group); // group も start DESC, effective DESC 順のまま
      if (picked) inMonth.push(picked);
    }
    if (inMonth.length === 0) continue;
    inMonth.reverse(); // start DESC → ASC (時系列順)
    out.set(
      clientId,
      inMonth.map((r) => toCertForMonth(r, false)),
    );
  }
  return out;
}

/**
 * resolveCertForMonth と resolveCertsInMonth を **1 回の fetch** で両方返す。
 *
 * 請求画面はこの 2 つ (採用 1 件 + 月内全件 = 保険者変更の検出) を必ず対で使うが、
 * 個別に呼ぶと同じ client_insurance_records を 2 度引くことになる。往復を半分にする。
 */
export async function resolveCertsForMonthBoth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
): Promise<{
  forMonth: Map<string, CertForMonth>;
  inMonth: Map<string, CertForMonth[]>;
}> {
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return { forMonth: new Map(), inMonth: new Map() };
  const { from: monthStart, to: monthEnd } = monthRange(year, month);
  const [byClient, benefitByClient] = await Promise.all([
    fetchCertRowsByClient(supabase, ids),
    fetchBenefitCertsByClient(supabase, ids),
  ]);
  const forMonth = pickCertForMonth(byClient, monthStart, monthEnd);
  const inMonth = pickCertsInMonth(byClient, monthStart, monthEnd);
  applyBenefitCerts(forMonth, byClient, benefitByClient, monthStart, monthEnd);
  applyBenefitCertsMany(inMonth, byClient, benefitByClient, monthStart, monthEnd);
  return { forMonth, inMonth };
}

// ─── 月途中の資格変更 検出 (Phase 1: 検出のみ。レセプト行の分割は Phase 2) ──────

export interface MidMonthCertChange {
  /**
   * ケース2: 保険者番号 / 被保険者番号 の月内変更 (転居等)。
   * boundaryDate = 変更後認定の certification_start_date。
   */
  insurerChange: {
    fromInsurer: string | null;
    toInsurer: string | null;
    fromInsured: string | null;
    toInsured: string | null;
    boundaryDate: string | null;
  } | null;
  /**
   * ケース3: care_level の月内変更 (区分変更)。
   * crossesSystem = 要支援 (事業対象者含む) ↔ 要介護 の制度跨ぎ。
   */
  careLevelChange: {
    from: string;
    to: string;
    boundaryDate: string | null;
    crossesSystem: boolean;
  } | null;
}

// 予防区分判定は @/lib/yobo-kubun に集約 (帳票様式の分岐と同じ基準を使う)
const isYoboKubun = isYoboLevel;
const trimOrEmpty = (v: string | null | undefined) => (v ?? "").trim();

// ─── 保険者変更 (転居) のセグメント分割 (Phase 2: レセプト行の複製・分割) ─────

/** 月内の 1 セグメント (from/to は両端含む 'YYYY-MM-DD') */
export interface CertSegment {
  from: string;
  to: string;
  /** このセグメント期間に適用する認定 (期間内で複数あれば最新 start の行) */
  cert: CertForMonth;
  /**
   * セグメント期間に有効期間が重なる「全」認定の service_limit_amount の最大値。
   * 同一保険者内の区分変更 (降格含む) がセグメント内にある場合も「最も介護の必要の
   * 程度が高い区分」の限度額 (施行規則68条1項) を適用するため、cert (最新 start の
   * 1 行) の値ではなくこちらを区分支給限度基準に使う。正の値が 1 件も無ければ null。
   */
  limitAmount: number | null;
}

export interface CertSegmentsResult {
  /** start 昇順のセグメント。分割なし (変化点なし・判定不能) は 1 件 */
  segments: CertSegment[];
  /** 保険者/被保険者番号の変化点はあるが境界日が判定できず分割しなかった */
  undetermined: boolean;
}

/** 'YYYY-MM-DD' の前日 (ローカル演算のみで TZ 安全) */
const prevDay = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * 期間 [from, to] に認定有効期間が重なる certs の service_limit_amount の最大値
 * (= 施行規則68条1項「重い方」)。正の値が 1 件も無ければ null。
 */
const maxLimitInRange = (
  certs: CertForMonth[],
  from: string,
  to: string,
): number | null => {
  let max: number | null = null;
  for (const c of certs) {
    if (!c.certification_start_date || c.certification_start_date > to) continue;
    if (c.certification_end_date && c.certification_end_date < from) continue;
    const v = c.service_limit_amount != null ? Number(c.service_limit_amount) : NaN;
    if (Number.isFinite(v) && v > 0 && (max == null || v > max)) max = v;
  }
  return max;
};

/**
 * resolveCertsInMonth の結果 (start 昇順) を、保険者番号 (または被保険者番号) の
 * 変化点で区切ったセグメント列にする (Phase 2: 転居月のレセプト分割用)。
 *
 * - 変化点なし (更新・区分変更のみ) は 1 セグメント。セグメントの cert は
 *   期間内で最新 start の行 (= resolveCertForMonth の採用行と同じ向き)。
 * - 境界日 = 変化後認定の certification_start_date (resolveCertsInMonth の行は
 *   start 必須なので原則これ。無ければ effective_date フォールバック)。
 *   ※ qualification_date (資格取得日) は client_insurance_records に UI 項目は
 *     あるが共有リゾルバの取得列に含めていないため未使用 (要検討 Phase 3)。
 * - 境界日が null または月初以前・月末より後なら判定不能 → 分割せず
 *   undetermined=true (呼出側で warning)。
 */
export function resolveCertSegmentsForMonth(
  certs: CertForMonth[],
  year: number,
  month: number,
): CertSegmentsResult {
  const { from: monthStart, to: monthEnd } = monthRange(year, month);
  if (certs.length === 0) return { segments: [], undetermined: false };
  let undetermined = false;
  const segments: CertSegment[] = [
    { from: monthStart, to: monthEnd, cert: certs[0], limitAmount: null },
  ];
  for (let i = 1; i < certs.length; i++) {
    const prev = certs[i - 1];
    const cur = certs[i];
    // detectMidMonthChange と同じ規則: 片方未入力の項目は変更とみなさない
    const pIns = trimOrEmpty(prev.insurer_number);
    const cIns = trimOrEmpty(cur.insurer_number);
    const pNo = trimOrEmpty(prev.insured_number);
    const cNo = trimOrEmpty(cur.insured_number);
    const changed =
      (pIns !== "" && cIns !== "" && pIns !== cIns) ||
      (pNo !== "" && cNo !== "" && pNo !== cNo);
    if (!changed) {
      // 変化なし (認定更新・区分変更のみ) → 同一セグメント内で最新の認定を採用
      segments[segments.length - 1].cert = cur;
      continue;
    }
    const boundary = cur.certification_start_date ?? cur.effective_date;
    if (!boundary || boundary <= monthStart || boundary > monthEnd) {
      // 境界日が判定できない (月初以前 = 月内変更ではない、月末より後 = 期間矛盾)
      undetermined = true;
      segments[segments.length - 1].cert = cur;
      continue;
    }
    const last = segments[segments.length - 1];
    last.to = prevDay(boundary);
    segments.push({ from: boundary, to: monthEnd, cert: cur, limitAmount: null });
  }
  if (undetermined) {
    // 判定不能の変化点が 1 つでもあれば分割しない (月末時点の認定 1 セグメント)
    return {
      segments: [
        {
          from: monthStart,
          to: monthEnd,
          cert: segments[segments.length - 1].cert,
          limitAmount: maxLimitInRange(certs, monthStart, monthEnd),
        },
      ],
      undetermined: true,
    };
  }
  // 各セグメントの限度額 = 期間に重なる全認定の max (セグメント内の区分変更も「重い方」)
  for (const s of segments) s.limitAmount = maxLimitInRange(certs, s.from, s.to);
  return { segments, undetermined: false };
}

/**
 * resolveCertsInMonth の結果 (start 昇順) から月内の資格変更を検出する。
 * 片方が未入力 (null/空) の項目は変更とみなさない (データ入力途中の誤検出防止)。
 * 変更なし (または認定が 1 件以下) は null。
 */
export function detectMidMonthChange(certs: CertForMonth[]): MidMonthCertChange | null {
  if (certs.length < 2) return null;
  let insurerChange: MidMonthCertChange["insurerChange"] = null;
  let careLevelChange: MidMonthCertChange["careLevelChange"] = null;
  for (let i = 1; i < certs.length; i++) {
    const prev = certs[i - 1];
    const cur = certs[i];
    const boundary = cur.certification_start_date;
    if (!insurerChange) {
      const pIns = trimOrEmpty(prev.insurer_number);
      const cIns = trimOrEmpty(cur.insurer_number);
      const pNo = trimOrEmpty(prev.insured_number);
      const cNo = trimOrEmpty(cur.insured_number);
      const insurerDiff = pIns !== "" && cIns !== "" && pIns !== cIns;
      const insuredDiff = pNo !== "" && cNo !== "" && pNo !== cNo;
      if (insurerDiff || insuredDiff) {
        insurerChange = {
          fromInsurer: prev.insurer_number,
          toInsurer: cur.insurer_number,
          fromInsured: prev.insured_number,
          toInsured: cur.insured_number,
          boundaryDate: boundary,
        };
      }
    }
    if (!careLevelChange) {
      const pLv = trimOrEmpty(prev.care_level);
      const cLv = trimOrEmpty(cur.care_level);
      if (pLv !== "" && cLv !== "" && pLv !== cLv) {
        careLevelChange = {
          from: pLv,
          to: cLv,
          boundaryDate: boundary,
          crossesSystem: isYoboKubun(pLv) !== isYoboKubun(cLv),
        };
      }
    }
    if (insurerChange && careLevelChange) break;
  }
  if (!insurerChange && !careLevelChange) return null;
  return { insurerChange, careLevelChange };
}
