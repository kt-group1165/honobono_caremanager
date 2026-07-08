/**
 * 公費 (生活保護等) の共有リゾルバ
 *
 * 公費は client_kohi_records (独立テーブル、複数公費・期間履歴対応) で管理する。
 * 利用者詳細の「公費」タブで入力し、請求系 (訪問介護集計 / 居宅帳票 / 居宅請求 /
 * 給付管理伝送) はすべて本リゾルバ経由で「対象月に有効な公費」を引く。
 *
 * 採用ルール (1 利用者 1 件):
 *   対象月に有効 (start_date <= 月末 AND (end_date IS NULL OR end_date >= 月初)、
 *   start_date NULL は開始制限なし扱い) な行のうち
 *   priority 最小 → start_date 最新 の 1 件を採用する。
 *   ※ 複数公費の併用按分 (第2・第3公費) は当面非対応 (優先 1 件のみ)。
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
  /** 本人支払額/月 (介護券記載。0=なし)。※ 金額計算への反映は未対応 (TODO) */
  honninFutan: number;
}

export interface ResolveKohiResult {
  /** client_id → 対象月に有効な公費 (無ければ null) */
  byClient: Map<string, ResolvedKohi | null>;
  /** true = client_kohi_records 未作成で旧 kohi_* 列 (最新認定) にフォールバック中 */
  fallback: boolean;
}

const IN_CHUNK = 50;

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

  const rowsByClient = new Map<string, KohiRow[]>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase
      .from("client_kohi_records")
      .select(
        "client_id, kohi_hobetsu, futansha_number, jukyusha_number, start_date, end_date, priority, honnin_futan",
      )
      .in("client_id", chunk);
    if (error) {
      // テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) は
      // 旧方式 (client_insurance_records.kohi_*) にフォールバック。
      // それ以外のエラーは握りつぶさない。
      if (error.code === "42P01" || error.code === "PGRST205") {
        console.warn(
          "[kohi] client_kohi_records 未作成 — 旧 client_insurance_records.kohi_* にフォールバックします (migrations/client_kohi_records.sql を適用してください)",
        );
        const legacy = await resolveKohiLegacy(supabase, ids);
        return { byClient: legacy, fallback: true };
      }
      throw new Error(`公費情報の取得に失敗: ${error.message}`);
    }
    for (const r of (data ?? []) as KohiRow[]) {
      const list = rowsByClient.get(r.client_id) ?? [];
      list.push(r);
      rowsByClient.set(r.client_id, list);
    }
  }

  for (const [clientId, rows] of rowsByClient) {
    // 対象月に有効: (start_date IS NULL OR start_date <= 月末) AND (end_date IS NULL OR end_date >= 月初)
    const valid = rows.filter(
      (r) =>
        (r.kohi_hobetsu?.trim() ?? "") !== "" &&
        (r.start_date == null || r.start_date <= monthEnd) &&
        (r.end_date == null || r.end_date >= monthStart),
    );
    if (valid.length === 0) {
      byClient.set(clientId, null);
      continue;
    }
    // priority 最小 → start_date 最新 (NULL は最古扱い) の 1 件を採用
    valid.sort((a, b) => {
      const pa = a.priority ?? 1;
      const pb = b.priority ?? 1;
      if (pa !== pb) return pa - pb;
      return (b.start_date ?? "").localeCompare(a.start_date ?? "");
    });
    const top = valid[0];
    byClient.set(clientId, {
      hobetsu: top.kohi_hobetsu!.trim(),
      futansha: top.futansha_number?.trim() || null,
      jukyusha: top.jukyusha_number?.trim() || null,
      honninFutan: top.honnin_futan ?? 0,
    });
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
    const { data, error } = await supabase
      .from("client_insurance_records")
      .select(
        "client_id, kohi_hobetsu, kohi_futansha_number, kohi_jukyusha_number, effective_date",
      )
      .in("client_id", chunk)
      .order("effective_date", { ascending: false });
    if (error) throw new Error(`公費情報 (旧方式) の取得に失敗: ${error.message}`);
    for (const r of (data ?? []) as {
      client_id: string;
      kohi_hobetsu: string | null;
      kohi_futansha_number: string | null;
      kohi_jukyusha_number: string | null;
    }[]) {
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
            }
          : null,
      );
    }
  }
  return byClient;
}
