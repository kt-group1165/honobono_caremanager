/**
 * 公費 (生活保護等) の共有リゾルバ
 *
 * 公費は client_kohi_records (独立テーブル、複数公費・期間履歴対応) で管理する。
 * 利用者詳細の「公費」タブで入力し、請求系 (訪問介護集計 / 居宅帳票 / 居宅請求 /
 * 給付管理伝送) はすべて本リゾルバ経由で「対象月に有効な公費」を引く。
 *
 * 採用ルール:
 *   resolveKohiForMonth (従来 API・互換維持): 対象月に有効
 *   (start_date <= 月末 AND (end_date IS NULL OR end_date >= 月初)、
 *   start_date NULL は開始制限なし扱い) な行のうち
 *   priority 最小 → start_date 最新 の 1 件を採用する。
 *
 *   resolveKohisForMonth (複数公費の併用対応。2026-07): 対象月に有効な全件を
 *   「priority 最小 → 制度優先順位表 (KOHI_HOBETSU_RANK) → start_date 最新」の
 *   適用優先順に並べて返す。訪問介護請求 (visit-seikyu/aggregate.ts) は
 *   上位 2 件までカスケード (保険 → 公費1 → 公費2 → 本人) で計算する。
 *
 * フォールバック (移行期間の安全網):
 *   client_kohi_records 未作成 (42P01 / PGRST205) の場合は旧方式
 *   (client_insurance_records の kohi_* 列を effective_date 降順の最新認定から)
 *   に自動フォールバックする。結果の fallback フラグで判別可能
 *   (UI 側は「migrations/client_kohi_records.sql 未適用」バナー案内に使える)。
 *
 * 公費単独 (被保険者番号 'H' 始まり = みなし2号) の判定は従来どおり
 * insured_number ベースで行い、本リゾルバの管轄外。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** 対象月に有効な公費 (優先 1 件) */
export interface ResolvedKohi {
  /** 法別番号 (12=生活保護, 25=中国残留邦人, 10=感染症, 21=精神通院, 54=難病, 19=被爆者 等) */
  hobetsu: string;
  /** 公費負担者番号 (8桁) */
  futansha: string | null;
  /** 公費受給者番号 (7桁) */
  jukyusha: string | null;
  /**
   * 本人負担上限月額 (介護券・受給者証記載の本人支払額。0=なし)。
   * 訪問介護請求 (visit-seikyu/aggregate.ts) は
   * 本人負担 = min(保険給付後負担, この上限) / 公費請求 = 残り で計算に反映する。
   */
  honninFutan: number;
  /** 公費適用期間 開始 (YYYY-MM-DD)。null = 開始制限なし */
  start: string | null;
  /** 公費適用期間 終了 (YYYY-MM-DD)。null = 終了制限なし */
  end: string | null;
}

export interface ResolveKohiResult {
  /** client_id → 対象月に有効な公費 (無ければ null) */
  byClient: Map<string, ResolvedKohi | null>;
  /** true = client_kohi_records 未作成で旧 kohi_* 列 (最新認定) にフォールバック中 */
  fallback: boolean;
}

export interface ResolveKohisResult {
  /**
   * client_id → 対象月に有効な公費すべて (適用優先順)。
   * 公費のない client は entry 自体なし (get() ?? [] で扱う)。
   */
  byClient: Map<string, ResolvedKohi[]>;
  /** true = client_kohi_records 未作成で旧 kohi_* 列 (最新認定 1 件) にフォールバック中 */
  fallback: boolean;
}

const IN_CHUNK = 50;
const PAGE = 1000;

/**
 * 公費 (保険優先公費) の制度別 適用優先順位 (値が小さいほど先に適用)。
 *
 * 根拠: 国保連合会「保険優先公費一覧 (適用優先度順)」(介護給付費請求向け。
 * 例: 宮城県国保連 sin5re.pdf。国保中央会 IF 仕様書の公費1〜3 の並びも同順) —
 * 項番順に 法別 10 (感染症/結核 95%) → 21 (障害 精神通院) → 15 (障害 更生医療)
 * → 19 (原爆 一般疾病) → 54 (難病) → 86 (被爆体験者) → 51 (特定疾患/先天性血液凝固)
 * → 88 (水俣病等) → 87 (茨城県神栖 有機ヒ素) → 66 (石綿) → 58 (障害者施策 全額免除)
 * → 81 (原爆助成) → 25 (中国残留邦人) → 12 (生活保護)。
 * 生活保護 (12) は他法優先の原則 (生活保護法第4条) により常に最劣後、
 * 中国残留邦人等 (25) はその直前 — この 2 つが末尾なのが実務上の要点。
 * ※ 法別番号の小さい順「ではない」ことに注意 (例: 10 → 21 → 15 → 19 → 54)。
 */
const KOHI_HOBETSU_RANK: Record<string, number> = {
  "10": 10, // 感染症法 (結核患者の適正医療)
  "21": 20, // 障害者総合支援法 (精神通院医療)
  "15": 30, // 障害者総合支援法 (更生医療)
  "19": 40, // 原爆援護法 (一般疾病医療費)
  "54": 50, // 難病法 (特定医療)
  "86": 60, // 被爆体験者精神影響等調査研究事業
  "51": 70, // 特定疾患治療研究事業 / 先天性血液凝固因子障害等
  "88": 80, // 水俣病総合対策 / メチル水銀調査研究事業
  "87": 90, // 茨城県神栖町 有機ヒ素化合物 緊急措置事業
  "66": 100, // 石綿健康被害救済法
  "58": 110, // 障害者施策 (特別対策・全額免除)
  "81": 120, // 原爆被爆者 助成事業 (訪問介護等利用者負担)
  "25": 130, // 中国残留邦人等支援法
  "12": 140, // 生活保護法 (介護扶助) — 常に最劣後
};
/** 優先順位表に無い法別番号は 25/12 (末尾 2 制度) より前・既知制度より後に置く */
const kohiHobetsuRank = (hobetsu: string): number =>
  KOHI_HOBETSU_RANK[hobetsu] ?? 125;

/** 表示用: 法別番号 → 「法別12 (生活保護)」等のラベル */
export function kohiHobetsuLabel(hobetsu: string): string {
  const names: Record<string, string> = {
    "12": "生活保護",
    "25": "中国残留邦人等",
    "10": "感染症 (結核)",
    "21": "精神通院医療",
    "54": "難病",
    "19": "被爆者",
  };
  const name = names[hobetsu];
  return name ? `法別${hobetsu} (${name})` : `法別${hobetsu}`;
}

interface KohiRow {
  client_id: string;
  kohi_hobetsu: string | null;
  futansha_number: string | null;
  jukyusha_number: string | null;
  start_date: string | null;
  end_date: string | null;
  priority: number | null;
  honnin_futan: number | null;
}

/**
 * client_kohi_records を client_id 単位で全件取得する (order 付き page-loop)。
 * テーブル未作成 (42P01 / PGRST205) は "table-missing" を返す (呼出側で旧方式へフォールバック)。
 */
async function fetchKohiRowsByClient(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, KohiRow[]> | "table-missing"> {
  const rowsByClient = new Map<string, KohiRow[]>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    // chunk 内でも PostgREST の 1000 行上限に掛かり得るため order 付き page-loop
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_kohi_records")
        .select(
          "client_id, kohi_hobetsu, futansha_number, jukyusha_number, start_date, end_date, priority, honnin_futan",
        )
        .in("client_id", chunk)
        .order("client_id", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        // テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) は
        // 旧方式 (client_insurance_records.kohi_*) にフォールバック。
        // それ以外のエラーは握りつぶさない。
        if (error.code === "42P01" || error.code === "PGRST205") {
          console.warn(
            "[kohi] client_kohi_records 未作成 — 旧 client_insurance_records.kohi_* にフォールバックします (migrations/client_kohi_records.sql を適用してください)",
          );
          return "table-missing";
        }
        throw new Error(`公費情報の取得に失敗: ${error.message}`);
      }
      const rows = (data ?? []) as KohiRow[];
      for (const r of rows) {
        const list = rowsByClient.get(r.client_id) ?? [];
        list.push(r);
        rowsByClient.set(r.client_id, list);
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
  }
  return rowsByClient;
}

/** 対象月に有効 (期間交差 + 法別番号あり) な行のみ残す */
const filterValidInMonth = (rows: KohiRow[], monthStart: string, monthEnd: string) =>
  // 対象月に有効: (start_date IS NULL OR start_date <= 月末) AND (end_date IS NULL OR end_date >= 月初)
  rows.filter(
    (r) =>
      (r.kohi_hobetsu?.trim() ?? "") !== "" &&
      (r.start_date == null || r.start_date <= monthEnd) &&
      (r.end_date == null || r.end_date >= monthStart),
  );

const toResolvedKohi = (r: KohiRow): ResolvedKohi => ({
  hobetsu: r.kohi_hobetsu!.trim(),
  futansha: r.futansha_number?.trim() || null,
  jukyusha: r.jukyusha_number?.trim() || null,
  honninFutan: r.honnin_futan ?? 0,
  start: r.start_date,
  end: r.end_date,
});

/**
 * 対象月 (year/month) に有効な公費を client ごとに解決する。
 * 戻り値の byClient は、公費のある client のみ ResolvedKohi、
 * 無い client は null (未登録 client は entry 自体なし。get() ?? null で扱う)。
 */
export async function resolveKohiForMonth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number, // 1-12
): Promise<ResolveKohiResult> {
  const byClient = new Map<string, ResolvedKohi | null>();
  if (clientIds.length === 0) return { byClient, fallback: false };

  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const monthStart = `${monthStr}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  const ids = Array.from(new Set(clientIds));

  const fetched = await fetchKohiRowsByClient(supabase, ids);
  if (fetched === "table-missing") {
    const legacy = await resolveKohiLegacy(supabase, ids);
    return { byClient: legacy, fallback: true };
  }

  for (const [clientId, rows] of fetched) {
    const valid = filterValidInMonth(rows, monthStart, monthEnd);
    if (valid.length === 0) {
      byClient.set(clientId, null);
      continue;
    }
    // priority 最小 → start_date 最新 (NULL は最古扱い) の 1 件を採用 (従来互換)
    valid.sort((a, b) => {
      const pa = a.priority ?? 1;
      const pb = b.priority ?? 1;
      if (pa !== pb) return pa - pb;
      return (b.start_date ?? "").localeCompare(a.start_date ?? "");
    });
    byClient.set(clientId, toResolvedKohi(valid[0]));
  }
  return { byClient, fallback: false };
}

/**
 * 対象月 (year/month) に有効な公費を client ごとに「全件・適用優先順」で解決する
 * (複数公費の併用対応。2026-07)。
 *
 * 並び順 (先頭 = 第1公費として先に適用):
 *   1. client_kohi_records.priority 最小 (NULL は 1 扱い = 手動優先の明示があれば最優先)
 *   2. 制度優先順位表 KOHI_HOBETSU_RANK (国保連「保険優先公費一覧 (適用優先度順)」。
 *      生活保護 12 は他法優先の原則により常に最劣後)
 *   3. start_date 最新 (NULL は最古扱い)
 *
 * テーブル未作成時は旧方式 (最新認定の kohi_* = 1 件) にフォールバックし、
 * 要素 0〜1 個の配列として返す (fallback フラグで判別可能)。
 */
export async function resolveKohisForMonth(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number, // 1-12
): Promise<ResolveKohisResult> {
  const byClient = new Map<string, ResolvedKohi[]>();
  if (clientIds.length === 0) return { byClient, fallback: false };

  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const monthStart = `${monthStr}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

  const ids = Array.from(new Set(clientIds));

  const fetched = await fetchKohiRowsByClient(supabase, ids);
  if (fetched === "table-missing") {
    const legacy = await resolveKohiLegacy(supabase, ids);
    for (const [clientId, k] of legacy) {
      byClient.set(clientId, k ? [k] : []);
    }
    return { byClient, fallback: true };
  }

  for (const [clientId, rows] of fetched) {
    const valid = filterValidInMonth(rows, monthStart, monthEnd);
    if (valid.length === 0) {
      byClient.set(clientId, []);
      continue;
    }
    valid.sort((a, b) => {
      const pa = a.priority ?? 1;
      const pb = b.priority ?? 1;
      if (pa !== pb) return pa - pb;
      const ra = kohiHobetsuRank(a.kohi_hobetsu!.trim());
      const rb = kohiHobetsuRank(b.kohi_hobetsu!.trim());
      if (ra !== rb) return ra - rb;
      return (b.start_date ?? "").localeCompare(a.start_date ?? "");
    });
    byClient.set(clientId, valid.map(toResolvedKohi));
  }
  return { byClient, fallback: false };
}

/**
 * 旧方式フォールバック: client_insurance_records の kohi_* 列を
 * effective_date 降順の最新認定 1 件/利用者から読む (期間判定なし = 従来挙動)。
 */
async function resolveKohiLegacy(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, ResolvedKohi | null>> {
  const byClient = new Map<string, ResolvedKohi | null>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    // client_id 順に固定して page-loop (per-client の先頭 = 最新 effective_date を保証)
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_insurance_records")
        .select(
          "client_id, kohi_hobetsu, kohi_futansha_number, kohi_jukyusha_number, effective_date",
        )
        .in("client_id", chunk)
        .order("client_id", { ascending: true })
        .order("effective_date", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`公費情報 (旧方式) の取得に失敗: ${error.message}`);
      const rows = (data ?? []) as {
        client_id: string;
        kohi_hobetsu: string | null;
        kohi_futansha_number: string | null;
        kohi_jukyusha_number: string | null;
      }[];
      for (const r of rows) {
        if (byClient.has(r.client_id)) continue; // 最新 (effective_date DESC) のみ
        const hobetsu = r.kohi_hobetsu?.trim() || null;
        byClient.set(
          r.client_id,
          hobetsu
            ? {
                hobetsu,
                futansha: r.kohi_futansha_number?.trim() || null,
                jukyusha: r.kohi_jukyusha_number?.trim() || null,
                honninFutan: 0,
                start: null,
                end: null,
              }
            : null,
        );
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
  }
  return byClient;
}
