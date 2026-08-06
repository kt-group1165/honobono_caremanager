import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK, mapChunksParallel } from "./chunk-parallel";

/**
 * 認定更新の能動アラート (cert expiry alert)。
 *
 * 認定有効期間 (client_insurance_records.certification_end_date) の期限接近を
 * 3 段階 (60日以内 / 30日以内 / 期限切れ) で判定し、未通知分だけ notifications へ
 * INSERT する。cron が無い構成のため、ダッシュボード読込時に scan → sync を実行する。
 *
 * 判定仕様:
 *   - 対象: 自事業所 (client_office_assignments.end_date IS NULL) の
 *     active な利用者 (clients.status='active', is_facility=false)
 *   - 「現在の認定」= certification_status='認定済み' かつ
 *     certification_start_date <= 今日 (または start 未入力) のうち start が最新の行
 *   - certification_end_date 未入力の行はアラート対象外 (期限が無い)
 *   - 段階: end < 今日 → expired / 今日+30日以内 → within30 / 今日+60日以内 → within60
 *   - 除外 (更新申請済み・更新済み):
 *       同一利用者に「申請中」の新しい行 (start が現認定より後、または start 未入力の
 *       申請中行) がある、または現認定より start が新しい「認定済み」行 (更新決定済の
 *       未来認定) がある場合はアラートしない
 *
 * 重複防止キー: notifications の (office_id, type, ref_id)。
 *   type = cert_expired / cert_expiry_30 / cert_expiry_60 (= 段階),
 *   ref_table = 'client_insurance_records', ref_id = 認定行 id (= client も一意に定まる)。
 *   既読・未読を問わず既通知ならスキップするので日次で増殖しない。
 *   段階が進んだ場合 (60日→30日→期限切れ) は type が変わるので新規に 1 件だけ積まれる。
 */

// ─── 型・定数 ─────────────────────────────────────────────────────────

export type CertExpiryStage = "expired" | "within30" | "within60";

export const CERT_ALERT_REF_TABLE = "client_insurance_records";

export const CERT_ALERT_TYPE_BY_STAGE: Record<CertExpiryStage, string> = {
  expired: "cert_expired",
  within30: "cert_expiry_30",
  within60: "cert_expiry_60",
};

export const CERT_ALERT_TYPES: string[] = Object.values(CERT_ALERT_TYPE_BY_STAGE);

export interface CertExpiryAlert {
  clientId: string;
  clientName: string;
  /** client_insurance_records.id (= 重複防止キーの一部) */
  certId: string;
  careLevel: string | null;
  /** 'YYYY-MM-DD' */
  certEndDate: string;
  stage: CertExpiryStage;
  /** 期限までの日数 (負 = 期限切れからの経過日数) */
  daysLeft: number;
}

/** 通知行が認定更新アラートか (notifications page のクリック分岐用) */
export function isCertAlertNotification(n: {
  type: string;
  ref_table: string | null;
  ref_id: string | null;
}): boolean {
  return (
    CERT_ALERT_TYPES.includes(n.type) &&
    n.ref_table === CERT_ALERT_REF_TABLE &&
    !!n.ref_id
  );
}

// ─── 日付 helper (ローカル演算のみ = TZ 安全、比較は 'YYYY-MM-DD' 文字列) ─────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDaysIso(base: Date, days: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
  return dateToIso(d);
}

function isoToLocalDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 'M/d' 表示 (通知メッセージ用) */
function isoToMd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[2])}/${Number(m[3])}`;
}

// ─── scan: 自事業所の期限接近認定を判定 ────────────────────────────────

const PAGE = 1000;
const IN_CHUNK = ID_IN_CHUNK;

interface CertRow {
  id: string;
  client_id: string;
  certification_status: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  care_level: string | null;
}

/**
 * officeId に紐づく active 利用者の認定期限接近アラートを判定して返す
 * (certEndDate 昇順 = 期限切れ→期限が近い順)。DB への書込はしない。
 */
export async function scanCertExpiry(
  supabase: SupabaseClient,
  officeId: string,
  today: Date = new Date(),
): Promise<CertExpiryAlert[]> {
  const todayIso = dateToIso(today);
  const plus30 = addDaysIso(today, 30);
  const plus60 = addDaysIso(today, 60);
  const todayMid = isoToLocalDate(todayIso)!.getTime();

  // 1) 自事業所の client_id 集合 (junction、page-loop)
  const clientIdsAll: string[] = [];
  let fromA = 0;
  while (true) {
    const { data, error } = await supabase
      .from("client_office_assignments")
      .select("client_id")
      .eq("office_id", officeId)
      .is("end_date", null)
      .order("id") // page-loop の安定順序 (1000 行超で行落ち/重複しないように)
      .range(fromA, fromA + PAGE - 1);
    if (error) throw new Error(`自事業所利用者の取得に失敗: ${error.message}`);
    const rows = (data ?? []) as { client_id: string }[];
    clientIdsAll.push(...rows.map((r) => r.client_id));
    if (rows.length < PAGE) break;
    fromA += PAGE;
  }
  const uniqueClientIds = Array.from(new Set(clientIdsAll));
  if (uniqueClientIds.length === 0) return [];

  // 2) active な利用者 (法人/事業所エントリ除外) の名前 map
  //    chunk を直列 await していると chunk 数 × 往復時間ぶん待たされるので並列で回す
  const nameById = new Map<string, string>();
  const nameChunks = await mapChunksParallel(uniqueClientIds, IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .in("id", chunk)
      .eq("status", "active")
      .eq("is_facility", false);
    if (error) throw new Error(`利用者の取得に失敗: ${error.message}`);
    return (data ?? []) as { id: string; name: string }[];
  });
  for (const rows of nameChunks) {
    for (const r of rows) nameById.set(r.id, r.name);
  }
  const activeIds = Array.from(nameById.keys());
  if (activeIds.length === 0) return [];

  // 3) 認定行を client ごとに収集 (chunk 並列 + chunk 内は page-loop)
  const certsByClient = new Map<string, CertRow[]>();
  const certChunks = await mapChunksParallel(activeIds, IN_CHUNK, async (chunk) => {
    const out: CertRow[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("client_insurance_records")
        .select(
          "id, client_id, certification_status, certification_start_date, certification_end_date, care_level",
        )
        .in("client_id", chunk)
        .order("client_id", { ascending: true })
        .order("certification_start_date", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`認定情報の取得に失敗: ${error.message}`);
      const rows = (data ?? []) as unknown as CertRow[];
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

  // 4) client ごとに「現在の認定」を選び、段階判定 + 更新申請済み除外
  const alerts: CertExpiryAlert[] = [];
  for (const [clientId, rows] of certsByClient) {
    // start DESC (null 最後) に並べ直す (page 跨ぎで順序保証が崩れる可能性への防御)
    const sorted = [...rows].sort((a, b) =>
      (b.certification_start_date ?? "").localeCompare(a.certification_start_date ?? ""),
    );
    const current = sorted.find(
      (r) =>
        r.certification_status === "認定済み" &&
        (r.certification_start_date === null || r.certification_start_date <= todayIso),
    );
    if (!current || !current.certification_end_date) continue;

    const end = current.certification_end_date;
    let stage: CertExpiryStage | null = null;
    if (end < todayIso) stage = "expired";
    else if (end <= plus30) stage = "within30";
    else if (end <= plus60) stage = "within60";
    if (!stage) continue;

    // 除外: 更新申請済み (「申請中」の新しい行) / 更新決定済み (start が新しい認定済み行)
    const curStart = current.certification_start_date;
    const renewalInProgress = sorted.some((r) => {
      if (r.id === current.id) return false;
      if (r.certification_status === "申請中") {
        // start 未入力の申請中行は「結果待ちの更新申請」とみなす
        return (
          r.certification_start_date === null ||
          curStart === null ||
          r.certification_start_date > curStart
        );
      }
      if (r.certification_status === "認定済み") {
        return (
          r.certification_start_date !== null &&
          curStart !== null &&
          r.certification_start_date > curStart
        );
      }
      return false;
    });
    if (renewalInProgress) continue;

    const endMid = isoToLocalDate(end)?.getTime();
    const daysLeft =
      endMid === undefined || endMid === null
        ? 0
        : Math.round((endMid - todayMid) / 86_400_000);

    alerts.push({
      clientId,
      clientName: nameById.get(clientId) ?? "(名前未取得)",
      certId: current.id,
      careLevel: current.care_level,
      certEndDate: end,
      stage,
      daysLeft,
    });
  }

  alerts.sort((a, b) => a.certEndDate.localeCompare(b.certEndDate));
  return alerts;
}

// ─── 通知メッセージ ───────────────────────────────────────────────────

/**
 * 通知 title/body を組み立てる。
 * isCareManagement (居宅介護支援) はケアプラン見直しの文言を含める (business type 出し分け)。
 */
export function buildCertAlertMessage(
  alert: CertExpiryAlert,
  isCareManagement: boolean,
): { title: string; body: string } {
  const md = isoToMd(alert.certEndDate);
  const suffix = isCareManagement
    ? "更新申請とケアプラン見直しを確認してください"
    : "更新申請の状況を確認してください";
  if (alert.stage === "expired") {
    return {
      title: `認定期限切れ: ${alert.clientName}さん (${md} 満了)`,
      body: `${alert.clientName}さんの認定有効期間が ${md} で満了しました (期限切れ)。${suffix}`,
    };
  }
  return {
    title: `認定更新: ${alert.clientName}さん (残${alert.daysLeft}日)`,
    body: `${alert.clientName}さんの認定有効期間が ${md} で満了します (残${alert.daysLeft}日)。${suffix}`,
  };
}

// ─── sync: 未通知分だけ notifications へ INSERT ────────────────────────

/**
 * 既通知 (office_id + type + ref_id が一致、既読/未読問わず) をスキップして
 * 未通知分だけ notifications へ INSERT する。戻り値は INSERT 件数。
 */
export async function syncCertExpiryNotifications(
  supabase: SupabaseClient,
  opts: {
    officeId: string;
    tenantId: string;
    alerts: CertExpiryAlert[];
    isCareManagement: boolean;
  },
): Promise<number> {
  const { officeId, tenantId, alerts, isCareManagement } = opts;
  if (alerts.length === 0) return 0;

  // 既通知キー集合 (`type:certId`) を収集 (page-loop)
  const notified = new Set<string>();
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("notifications")
      .select("type, ref_id")
      .eq("office_id", officeId)
      .eq("ref_table", CERT_ALERT_REF_TABLE)
      .in("type", CERT_ALERT_TYPES)
      .order("id") // page-loop の安定順序 (1000 行超で行落ち/重複しないように)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`既存通知の取得に失敗: ${error.message}`);
    const rows = (data ?? []) as { type: string; ref_id: string | null }[];
    for (const r of rows) {
      if (r.ref_id) notified.add(`${r.type}:${r.ref_id}`);
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  const toInsert = alerts
    .filter((a) => !notified.has(`${CERT_ALERT_TYPE_BY_STAGE[a.stage]}:${a.certId}`))
    .map((a) => {
      const { title, body } = buildCertAlertMessage(a, isCareManagement);
      return {
        tenant_id: tenantId,
        office_id: officeId,
        user_id: null,
        type: CERT_ALERT_TYPE_BY_STAGE[a.stage],
        ref_table: CERT_ALERT_REF_TABLE,
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

// ─── 入口: scan + sync (ダッシュボード読込時に呼ぶ) ─────────────────────

/**
 * 判定 → 未通知分の INSERT を行い、現在のアラート一覧を返す (カード表示用)。
 */
export async function runCertExpiryScan(
  supabase: SupabaseClient,
  opts: { officeId: string; tenantId: string; isCareManagement: boolean },
): Promise<CertExpiryAlert[]> {
  const alerts = await scanCertExpiry(supabase, opts.officeId);
  await syncCertExpiryNotifications(supabase, {
    officeId: opts.officeId,
    tenantId: opts.tenantId,
    alerts,
    isCareManagement: opts.isCareManagement,
  });
  return alerts;
}

// ─── 通知クリック時の遷移先解決 ─────────────────────────────────────────

/**
 * 認定行 id (notifications.ref_id) から client_id を解決する。
 * 見つからない / エラー時は null (呼出側でフォールバック)。
 */
export async function resolveCertClientId(
  supabase: SupabaseClient,
  certId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from(CERT_ALERT_REF_TABLE)
    .select("client_id")
    .eq("id", certId)
    .maybeSingle();
  if (error) {
    console.error("認定情報の参照に失敗:", error.message);
    return null;
  }
  return (data as { client_id: string } | null)?.client_id ?? null;
}
