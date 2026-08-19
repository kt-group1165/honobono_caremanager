/**
 * 明細書 (様式第二 / 様式第二の三) を印刷したときの「発行済化」。
 *
 * 介護請求タブ・国保請求タブのどちらから明細書を出しても同じ記録になるように
 * kaigo_billing_status (訪問入浴は bath_billing_status) への upsert を 1 か所に集約する。
 *
 * 注意点 (移設前の kaigo-seikyu-content.tsx printMeisaiFor と同じ挙動):
 *   - 既存行の kokuho_target / 月遅れ / 返戻 / 過誤 / notes は読み取って保持する
 *     (固定値での上書き消去をしない)。再請求行は理由フラグを引き継ぐ。
 *   - payload は全行で同一のキー集合にする (upsert の PGRST102
 *     「All object keys must match」予防)。
 *   - 保険者変更 (転居) の分割セグメント行は status が利用者 × 月の 1 レコードなので
 *     重複キー (client_id, target_month) を除去する (同一行二重更新エラー予防)。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** 発行済化する 1 行 (利用者 × 提供月) */
export interface MarkIssuedRow {
  /** clients.id */
  userId: string;
  /** 提供月 'YYYY-MM' (再請求行は元提供月) */
  monthKey: string;
  /** 再請求理由 (月遅れ/返戻/過誤)。当月通常行は null */
  reasons: { tsukiokure: boolean; henrei: boolean; kago: boolean } | null;
}

/** 既存 status のうち保持したい列 */
interface ExistingStatus {
  client_id: string;
  target_month: string;
  kokuho_target: boolean | null;
  tsukiokure: boolean | null;
  henrei: boolean | null;
  kago: boolean | null;
  notes: string | null;
}

/** テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) 判定 */
const isTableMissing = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205";

export interface MarkIssuedResult {
  /** 発行済化した件数 (利用者 × 月) */
  count: number;
  /** 失敗時のメッセージ (null = 成功)。テーブル未作成は成功扱い (count=0) */
  error: string | null;
}

/**
 * 明細書の発行日 (issued_at) を now() で記録する。
 *
 * 印刷そのものは呼出側で行う。保存に失敗しても印刷は続行できるよう、
 * この関数は throw せずメッセージを返す。
 */
export async function markMeisaiIssued(
  supabase: SupabaseClient,
  opts: {
    /** 'kaigo_billing_status' | 'bath_billing_status' */
    table: string;
    officeId: string;
    tenantId: string;
    rows: MarkIssuedRow[];
  },
): Promise<MarkIssuedResult> {
  const { table, officeId, tenantId, rows } = opts;
  if (rows.length === 0) return { count: 0, error: null };

  // 利用者 × 月 で重複除去 (分割セグメント行の二重 upsert 予防)
  const uniq = new Map<string, MarkIssuedRow>();
  for (const r of rows) {
    const key = `${r.userId}:${r.monthKey}`;
    // 同一キーが複数ある場合、理由フラグを持つ行 (再請求) を優先して残す
    if (!uniq.has(key) || (r.reasons && !uniq.get(key)!.reasons)) {
      uniq.set(key, r);
    }
  }

  // ── 既存行の読取 (上書き消去の予防) ──
  const existing = new Map<string, ExistingStatus>();
  const months = Array.from(new Set([...uniq.values()].map((r) => r.monthKey)));
  const clientIds = Array.from(new Set([...uniq.values()].map((r) => r.userId)));
  const { data, error: readError } = await supabase
    .from(table)
    .select("client_id, target_month, kokuho_target, tsukiokure, henrei, kago, notes")
    .eq("office_id", officeId)
    .in("target_month", months)
    .in("client_id", clientIds);
  if (readError) {
    if (isTableMissing(readError.code)) return { count: 0, error: null };
    return { count: 0, error: `既存の請求状態の取得に失敗: ${readError.message}` };
  }
  for (const r of (data ?? []) as ExistingStatus[]) {
    existing.set(`${r.client_id}:${r.target_month}`, r);
  }

  const now = new Date().toISOString();
  const payload = [...uniq.entries()].map(([key, r]) => {
    const cur = existing.get(key);
    return {
      client_id: r.userId,
      target_month: r.monthKey,
      tenant_id: tenantId,
      office_id: officeId,
      issued_at: now,
      // 既存フラグを保持 (再請求行は理由フラグを引き継ぐ)
      kokuho_target: cur?.kokuho_target ?? false,
      tsukiokure: r.reasons?.tsukiokure ?? cur?.tsukiokure ?? false,
      henrei: r.reasons?.henrei ?? cur?.henrei ?? false,
      kago: r.reasons?.kago ?? cur?.kago ?? false,
      notes: cur?.notes ?? null,
    };
  });

  const { error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: "client_id,target_month,office_id" });
  if (error) {
    if (isTableMissing(error.code)) return { count: 0, error: null };
    return { count: 0, error: `発行状態の保存に失敗: ${error.message}` };
  }
  return { count: payload.length, error: null };
}
