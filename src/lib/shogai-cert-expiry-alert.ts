import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK, mapChunksParallel } from "./chunk-parallel";
import { filterRecentlyActiveClients } from "./active-clients";

/**
 * 障害受給者証の期限アラート。
 *
 * ── なぜ要るか (2026-09-03 実測) ──────────────────────────────────────────
 *   cert-expiry-alert.ts は `client_insurance_records` (= **介護保険の認定**) しか
 *   見ておらず、**障害受給者証にはアラートが 1 つも無かった**。
 *   受給者証が切れていると障害の請求が返戻する。実測:
 *
 *     障害受給者証 575 件 / 557 名
 *       期限切れ  全体 180 名 / 直近に稼働がある人 **134 名**
 *       30日以内  全体  47 名 / 同 **42 名**
 *
 *   引き継ぎに 1 名だけ載っていた「松戸孝雄 受給者証が 2026-06-30 で切れている」は
 *   この 134 名の 1 人で、**個別事象ではなく構造的に検知していなかった**。
 *
 * ── 介護保険版との違い ────────────────────────────────────────────────────
 *   ⚠ shougai_certifications には **certification_status 列が無い**。
 *     介護保険版の「申請中の行があれば除外」は使えないので、
 *     **「より新しい受給者証があれば除外」だけ**で更新済みを判定する。
 *     (更新済みの人に警告を出すと、それこそ狼少年になる)
 *
 * ── 判定仕様 (介護保険版と同じ形) ────────────────────────────────────────
 *   - 母集団: 自事業所 (client_office_assignments) の active 利用者のうち
 *     **直近に稼働がある人だけ** (active-clients.ts 参照。end_date が全件 NULL で
 *     絞れないため)
 *   - 「現在の受給者証」= certification_start_date <= 今日 (または未入力) のうち
 *     start が最新の行
 *   - certification_end_date 未入力の行は対象外 (期限が無い)
 *   - 段階: end < 今日 → expired / 今日+30日以内 → within30 / 今日+60日以内 → within60
 *   - 除外: 現在の証より start が新しい行がある (= 更新済み)
 *
 * 重複防止キー: notifications の (office_id, type, ref_id)
 *   ref_table = 'shougai_certifications', ref_id = 受給者証行 id
 *   既読・未読を問わず既通知ならスキップするので日次で増殖しない。
 */

export type ShogaiCertStage = "expired" | "within30" | "within60";

export const SHOGAI_CERT_ALERT_REF_TABLE = "shougai_certifications";

export const SHOGAI_CERT_ALERT_TYPE_BY_STAGE: Record<ShogaiCertStage, string> = {
  expired: "shogai_cert_expired",
  within30: "shogai_cert_expiry_30",
  within60: "shogai_cert_expiry_60",
};

export const SHOGAI_CERT_ALERT_TYPES: string[] = Object.values(SHOGAI_CERT_ALERT_TYPE_BY_STAGE);

export interface ShogaiCertAlert {
  clientId: string;
  clientName: string;
  /** shougai_certifications.id (= 重複防止キーの一部) */
  certId: string;
  supportLevel: string | null;
  beneficiaryNumber: string | null;
  /** 'YYYY-MM-DD' */
  certEndDate: string;
  stage: ShogaiCertStage;
  /** 期限までの日数 (負 = 期限切れからの経過日数) */
  daysLeft: number;
}

/** 通知行が障害受給者証アラートか (notifications page のクリック分岐用) */
export function isShogaiCertAlertNotification(n: {
  type: string;
  ref_table: string | null;
  ref_id: string | null;
}): boolean {
  return (
    SHOGAI_CERT_ALERT_TYPES.includes(n.type) &&
    n.ref_table === SHOGAI_CERT_ALERT_REF_TABLE &&
    !!n.ref_id
  );
}

// ─── 日付 helper (ローカル演算のみ = TZ 安全) ──────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDaysIso(base: Date, days: number): string {
  return dateToIso(new Date(base.getFullYear(), base.getMonth(), base.getDate() + days));
}
function isoToLocalDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function isoToMd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[2])}/${Number(m[3])}` : iso;
}

const PAGE = 1000;

interface ShogaiCertRow {
  id: string;
  client_id: string;
  certification_start_date: string | null;
  certification_end_date: string | null;
  support_level: string | null;
  beneficiary_number: string | null;
}

/**
 * officeId に紐づく実稼働利用者の受給者証期限アラートを返す
 * (certEndDate 昇順 = 期限切れ→期限が近い順)。DB への書込はしない。
 */
export async function scanShogaiCertExpiry(
  supabase: SupabaseClient,
  officeId: string,
  today: Date = new Date(),
): Promise<ShogaiCertAlert[]> {
  const todayIso = dateToIso(today);
  const plus30 = addDaysIso(today, 30);
  const plus60 = addDaysIso(today, 60);
  const todayMid = isoToLocalDate(todayIso)!.getTime();

  // 1) 自事業所の client_id (junction、page-loop)
  const assigned: string[] = [];
  let fromA = 0;
  while (true) {
    const { data, error } = await supabase
      .from("client_office_assignments")
      .select("client_id")
      .eq("office_id", officeId)
      .order("id") // page-loop の安定順序
      .range(fromA, fromA + PAGE - 1);
    if (error) throw new Error(`自事業所利用者の取得に失敗: ${error.message}`);
    const rows = (data ?? []) as { client_id: string }[];
    assigned.push(...rows.map((r) => r.client_id));
    if (rows.length < PAGE) break;
    fromA += PAGE;
  }
  const uniqueIds = Array.from(new Set(assigned));
  if (uniqueIds.length === 0) return [];

  // 2) active な利用者の名前 map
  const nameById = new Map<string, string>();
  const nameChunks = await mapChunksParallel(uniqueIds, ID_IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .in("id", chunk)
      .eq("status", "active")
      .eq("is_facility", false);
    if (error) throw new Error(`利用者の取得に失敗: ${error.message}`);
    return (data ?? []) as { id: string; name: string }[];
  });
  for (const rows of nameChunks) for (const r of rows) nameById.set(r.id, r.name);
  if (nameById.size === 0) return [];

  // 3) ⚠ 実稼働で絞る (end_date が全件 NULL で母数が 3 倍に膨らむため)
  const activeIds = Array.from(
    await filterRecentlyActiveClients(supabase, Array.from(nameById.keys()), today),
  );
  if (activeIds.length === 0) return [];

  // 4) 受給者証を client ごとに収集
  const certsByClient = new Map<string, ShogaiCertRow[]>();
  const certChunks = await mapChunksParallel(activeIds, ID_IN_CHUNK, async (chunk) => {
    const out: ShogaiCertRow[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from(SHOGAI_CERT_ALERT_REF_TABLE)
        .select(
          "id, client_id, certification_start_date, certification_end_date, support_level, beneficiary_number",
        )
        .in("client_id", chunk)
        .order("client_id", { ascending: true })
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`受給者証の取得に失敗: ${error.message}`);
      const rows = (data ?? []) as unknown as ShogaiCertRow[];
      out.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return out;
  });
  for (const rows of certChunks) {
    for (const r of rows) {
      if (!certsByClient.has(r.client_id)) certsByClient.set(r.client_id, []);
      certsByClient.get(r.client_id)!.push(r);
    }
  }

  // 5) 「現在の受給者証」を選んで段階判定 + 更新済み除外
  const alerts: ShogaiCertAlert[] = [];
  for (const [clientId, rows] of certsByClient) {
    const resolved = resolveClientShogaiCertAlert(rows, { todayIso, plus30, plus60, todayMid });
    if (!resolved) continue;
    alerts.push({
      clientId,
      clientName: nameById.get(clientId) ?? "(名前未取得)",
      ...resolved,
    });
  }

  alerts.sort((a, b) => a.certEndDate.localeCompare(b.certEndDate));
  return alerts;
}

/**
 * ★ 2026-09-05 切り出し: scanShogaiCertExpiry のループ本体
 *   (段階判定 + 更新済み除外)。cert-expiry-alert.ts の
 *   resolveClientCertAlert と同型。挙動は 1 ミリも変えていない。
 *
 * @returns アラート対象でなければ null
 */
export function resolveClientShogaiCertAlert(
  rows: ShogaiCertRow[],
  ctx: { todayIso: string; plus30: string; plus60: string; todayMid: number },
): Omit<ShogaiCertAlert, "clientId" | "clientName"> | null {
  const { todayIso, plus30, plus60, todayMid } = ctx;
  const sorted = [...rows].sort((a, b) =>
    (b.certification_start_date ?? "").localeCompare(a.certification_start_date ?? ""),
  );
  const current = sorted.find(
    (r) => r.certification_start_date === null || r.certification_start_date <= todayIso,
  );
  if (!current || !current.certification_end_date) return null;

  const end = current.certification_end_date;
  let stage: ShogaiCertStage | null = null;
  if (end < todayIso) stage = "expired";
  else if (end <= plus30) stage = "within30";
  else if (end <= plus60) stage = "within60";
  if (!stage) return null;

  // ⚠ 更新済み除外。status 列が無いので「より新しい証があるか」だけで判定する。
  const curStart = current.certification_start_date;
  const renewed = sorted.some(
    (r) =>
      r.id !== current.id &&
      r.certification_start_date !== null &&
      (curStart === null || r.certification_start_date > curStart),
  );
  if (renewed) return null;

  const endMid = isoToLocalDate(end)?.getTime();
  const daysLeft = endMid == null ? 0 : Math.round((endMid - todayMid) / 86_400_000);

  return {
    certId: current.id,
    supportLevel: current.support_level,
    beneficiaryNumber: current.beneficiary_number,
    certEndDate: end,
    stage,
    daysLeft,
  };
}

// ─── 通知メッセージ ───────────────────────────────────────────────────

export function buildShogaiCertAlertMessage(alert: ShogaiCertAlert): {
  title: string;
  body: string;
} {
  const md = isoToMd(alert.certEndDate);
  const suffix = "受給者証の更新を確認してください (切れたまま請求すると返戻になります)";
  if (alert.stage === "expired") {
    return {
      title: `受給者証 期限切れ: ${alert.clientName}さん (${md} 満了)`,
      body: `${alert.clientName}さんの障害受給者証が ${md} で満了しました (期限切れ)。${suffix}`,
    };
  }
  return {
    title: `受給者証 更新: ${alert.clientName}さん (残${alert.daysLeft}日)`,
    body: `${alert.clientName}さんの障害受給者証が ${md} で満了します (残${alert.daysLeft}日)。${suffix}`,
  };
}

// ─── sync: 未通知分だけ INSERT ────────────────────────────────────────

export async function syncShogaiCertNotifications(
  supabase: SupabaseClient,
  opts: { officeId: string; tenantId: string; alerts: ShogaiCertAlert[] },
): Promise<number> {
  const { officeId, tenantId, alerts } = opts;
  if (alerts.length === 0) return 0;

  const notified = new Set<string>();
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("notifications")
      .select("type, ref_id")
      .eq("office_id", officeId)
      .eq("ref_table", SHOGAI_CERT_ALERT_REF_TABLE)
      .in("type", SHOGAI_CERT_ALERT_TYPES)
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`既存通知の取得に失敗: ${error.message}`);
    const rows = (data ?? []) as { type: string; ref_id: string | null }[];
    for (const r of rows) if (r.ref_id) notified.add(`${r.type}:${r.ref_id}`);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  const toInsert = alerts
    .filter((a) => !notified.has(`${SHOGAI_CERT_ALERT_TYPE_BY_STAGE[a.stage]}:${a.certId}`))
    .map((a) => {
      const { title, body } = buildShogaiCertAlertMessage(a);
      return {
        tenant_id: tenantId,
        office_id: officeId,
        user_id: null,
        type: SHOGAI_CERT_ALERT_TYPE_BY_STAGE[a.stage],
        ref_table: SHOGAI_CERT_ALERT_REF_TABLE,
        ref_id: a.certId,
        title,
        body,
      };
    });
  if (toInsert.length === 0) return 0;

  const { error: insErr } = await supabase.from("notifications").insert(toInsert);
  if (insErr) throw new Error(`通知の作成に失敗: ${insErr.message}`);
  return toInsert.length;
}

/** 判定 → 未通知分の INSERT。ダッシュボード読込時に呼ぶ。 */
export async function runShogaiCertExpiryScan(
  supabase: SupabaseClient,
  opts: { officeId: string; tenantId: string },
): Promise<ShogaiCertAlert[]> {
  const alerts = await scanShogaiCertExpiry(supabase, opts.officeId);
  await syncShogaiCertNotifications(supabase, {
    officeId: opts.officeId,
    tenantId: opts.tenantId,
    alerts,
  });
  return alerts;
}

/** 受給者証行 id から client_id を解決 (通知クリック時の遷移先) */
export async function resolveShogaiCertClientId(
  supabase: SupabaseClient,
  certId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from(SHOGAI_CERT_ALERT_REF_TABLE)
    .select("client_id")
    .eq("id", certId)
    .maybeSingle();
  if (error) {
    console.error("受給者証の参照に失敗:", error.message);
    return null;
  }
  return (data as { client_id: string } | null)?.client_id ?? null;
}
