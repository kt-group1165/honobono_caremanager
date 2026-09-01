/**
 * 訪問介護計画書の 未作成 / 期限切れ アラート
 *
 * 訪問介護計画 (指定基準 第28条) は 未作成・期限切れ が運営指導の指摘対象になる。
 * cron が無い構成なので、認定更新アラート (cert-expiry-alert.ts) と同じく
 * 画面読込時に scan → 未通知分だけ notifications へ INSERT する。
 *
 * 判定仕様:
 *   - 母集団: 自事業所 (client_office_assignments.end_date IS NULL) の
 *     active 利用者 (clients.status='active' / is_facility=false / deleted_at IS NULL)
 *     ← clients.office_id では引かない (CLAUDE.md §3.1)
 *   - 各利用者の「最新計画」= plan_date が最大の 1 件
 *   - 状態:
 *       計画なし                        → none    (アラート対象)
 *       valid_until < 今日              → expired (アラート対象)
 *       valid_until <= 今日+30日        → soon    (アラート対象)
 *       status='draft' のまま           → draft   (一覧のみ。通知はしない)
 *       それ以外 (期限未設定含む)       → ok
 *
 * 通知に出すのは expired / soon だけ (= 計画という個別イベントに紐づくもの)。
 *   ❗ none (未作成) は通知しない。運用開始前は自事業所の利用者が丸ごと未作成になり
 *      (例: 1 事業所 120〜190 名)、初回読込で通知が一気に積まれて他の通知が埋もれる。
 *      未作成は ダッシュボードの「訪問介護計画書 要対応」と一覧で見せる。
 *
 * 重複防止キー: notifications の (office_id, type, ref_id)
 *   ref_table='kaigo_houmon_care_plans', ref_id=計画 id
 *   → 版ごとに 1 回だけ通知される (新しい版を作れば、その版で再び通知され得る)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK, mapChunksParallel } from "@/lib/chunk-parallel";
import type { HoumonCarePlanStatus, HoumonPlanKind } from "./types";

// ─── 型・定数 ─────────────────────────────────────────────────────────

export type PlanState = "none" | "expired" | "soon" | "draft" | "ok";

/** 要対応として画面に出す状態 (draft / ok は出さない) */
export type HoumonPlanAlertStage = Extract<PlanState, "none" | "expired" | "soon">;

/** そのうち「通知」に積む状態 (= 未作成は積まない。冒頭コメント参照) */
export type HoumonPlanNotifyStage = Extract<HoumonPlanAlertStage, "expired" | "soon">;

export const HOUMON_PLAN_ALERT_TYPE_BY_STAGE: Record<HoumonPlanNotifyStage, string> = {
  expired: "houmon_plan_expired",
  soon: "houmon_plan_expiry_30",
};

export const HOUMON_PLAN_ALERT_TYPES: string[] = Object.values(HOUMON_PLAN_ALERT_TYPE_BY_STAGE);

export const HOUMON_PLAN_REF_TABLE = "kaigo_houmon_care_plans";

export interface LatestPlan {
  id: string;
  user_id: string;
  plan_kind: HoumonPlanKind;
  plan_date: string;
  valid_until: string | null;
  status: HoumonCarePlanStatus;
}

export interface PlanStateRow {
  clientId: string;
  clientName: string;
  furigana: string | null;
  plan: LatestPlan | null;
  state: PlanState;
  /** 期限までの日数 (期限未設定 / 計画なしは null。負 = 期限切れからの経過日数) */
  daysLeft: number | null;
}

/** 通知行が訪問介護計画アラートか (notifications ページのクリック分岐用) */
export function isHoumonPlanAlertNotification(n: {
  type: string;
  ref_table: string | null;
  ref_id: string | null;
}): boolean {
  return HOUMON_PLAN_ALERT_TYPES.includes(n.type) && !!n.ref_id;
}

// ─── 日付 helper (ローカル演算のみ = TZ 安全。比較は 'YYYY-MM-DD' 文字列) ─────
// toISOString() は JST で前日になるので使わない (memory: feedback_toisostring_jst_offset)

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

/** 状態判定 (純関数 = 一覧・通知で同じ判定を使う) */
export function resolvePlanState(
  plan: LatestPlan | null,
  todayIso: string,
  soonLimitIso: string,
): PlanState {
  if (!plan) return "none";
  if (plan.valid_until && plan.valid_until < todayIso) return "expired";
  if (plan.valid_until && plan.valid_until <= soonLimitIso) return "soon";
  if (plan.status === "draft") return "draft";
  return "ok";
}

// ─── scan: 自事業所 利用者 × 最新計画 ──────────────────────────────────

/**
 * 自事業所の active 利用者について、最新計画と状態を返す (ふりがな順)。
 * DB への書込はしない。一覧画面 (overview) と通知 sync の共通の元データ。
 */
export async function scanHoumonPlanStates(
  supabase: SupabaseClient,
  officeId: string,
  today: Date = new Date(),
): Promise<PlanStateRow[]> {
  const todayIso = dateToIso(today);
  const soonLimit = addDaysIso(today, 30);
  const todayMid = isoToLocalDate(todayIso)!.getTime();

  // 1) 自事業所の active 利用者 (junction を !inner 埋め込みで 1 往復)
  const { data: clientData, error: cErr } = await supabase
    .from("clients")
    .select("id, name, furigana, client_office_assignments!inner(office_id)")
    .eq("client_office_assignments.office_id", officeId)
    .is("client_office_assignments.end_date", null)
    .eq("status", "active")
    .eq("is_facility", false)
    .is("deleted_at", null)
    .order("furigana", { ascending: true, nullsFirst: false })
    .range(0, 9999);
  if (cErr) throw new Error(`自事業所利用者の取得に失敗: ${cErr.message}`);
  const clients = ((clientData ?? []) as unknown as {
    id: string;
    name: string;
    furigana: string | null;
  }[]).map((c) => ({ id: c.id, name: c.name, furigana: c.furigana }));
  if (clients.length === 0) return [];

  // 2) 計画書を id chunk 並列で取得 (URL 長 / 1000 行制限対策)
  const chunks = await mapChunksParallel(
    clients.map((c) => c.id),
    ID_IN_CHUNK,
    async (ids) => {
      const { data, error } = await supabase
        .from("kaigo_houmon_care_plans")
        .select("id, user_id, plan_kind, plan_date, valid_until, status")
        .in("user_id", ids)
        .order("plan_date", { ascending: false });
      if (error) throw new Error(`訪問介護計画書の取得に失敗: ${error.message}`);
      return (data ?? []) as LatestPlan[];
    },
  );

  // 3) 利用者ごとに最新 1 件
  const latest = new Map<string, LatestPlan>();
  for (const p of chunks.flat()) {
    const cur = latest.get(p.user_id);
    if (!cur || p.plan_date > cur.plan_date) latest.set(p.user_id, p);
  }

  return clients.map((c) => {
    const plan = latest.get(c.id) ?? null;
    const state = resolvePlanState(plan, todayIso, soonLimit);
    let daysLeft: number | null = null;
    if (plan?.valid_until) {
      const end = isoToLocalDate(plan.valid_until)?.getTime();
      if (end !== undefined) daysLeft = Math.round((end - todayMid) / 86_400_000);
    }
    return { clientId: c.id, clientName: c.name, furigana: c.furigana, plan, state, daysLeft };
  });
}

export interface HoumonPlanAlert extends PlanStateRow {
  stage: HoumonPlanAlertStage;
}

/** 要対応 (未作成 / 期限切れ / 30日以内) だけ抜き出して stage を付ける */
export function toAlerts(rows: PlanStateRow[]): HoumonPlanAlert[] {
  const alerts = rows
    .filter(
      (r): r is PlanStateRow & { state: HoumonPlanAlertStage } =>
        r.state === "none" || r.state === "expired" || r.state === "soon",
    )
    // state をそのまま stage として持たせる (型述語だけでは stage が undefined になる)
    .map((r) => ({ ...r, stage: r.state }));
  // 未作成 → 期限切れ → 期限が近い順
  const order: Record<HoumonPlanAlertStage, number> = { none: 0, expired: 1, soon: 2 };
  return [...alerts].sort((a, b) => {
    const d = order[a.stage] - order[b.stage];
    if (d !== 0) return d;
    return (a.plan?.valid_until ?? "").localeCompare(b.plan?.valid_until ?? "");
  });
}

// ─── 通知メッセージ ───────────────────────────────────────────────────

export function buildHoumonPlanAlertMessage(alert: HoumonPlanAlert): {
  title: string;
  body: string;
} {
  if (alert.stage === "none") {
    return {
      title: `訪問介護計画書 未作成: ${alert.clientName}さん`,
      body: `${alert.clientName}さんの訪問介護計画書がまだ作成されていません。サービス提供責任者が作成し、本人の同意を得てください。`,
    };
  }
  const md = alert.plan?.valid_until ? isoToMd(alert.plan.valid_until) : "—";
  if (alert.stage === "expired") {
    return {
      title: `訪問介護計画書 期限切れ: ${alert.clientName}さん (${md} 満了)`,
      body: `${alert.clientName}さんの訪問介護計画書の計画期間が ${md} で満了しました。見直して新しい版を作成してください。`,
    };
  }
  const days = alert.daysLeft ?? 0;
  return {
    title: `訪問介護計画書 更新: ${alert.clientName}さん (残${days}日)`,
    body: `${alert.clientName}さんの訪問介護計画書の計画期間が ${md} で満了します (残${days}日)。見直しの要否を確認してください。`,
  };
}

// ─── sync: 未通知分だけ notifications へ INSERT ────────────────────────

const PAGE = 1000;

/** 通知対象 (= 計画が存在し、期限系のもの) だけ抜く */
function notifiable(
  alerts: HoumonPlanAlert[],
): (HoumonPlanAlert & { stage: HoumonPlanNotifyStage; plan: LatestPlan })[] {
  return alerts.filter(
    (a): a is HoumonPlanAlert & { stage: HoumonPlanNotifyStage; plan: LatestPlan } =>
      (a.stage === "expired" || a.stage === "soon") && a.plan !== null,
  );
}

/**
 * 既通知 (office_id + type + ref_id が一致、既読/未読問わず) をスキップして
 * 未通知分だけ INSERT する。戻り値は INSERT 件数。
 * 未作成 (none) は通知しない (= 冒頭コメント参照)。
 */
export async function syncHoumonPlanNotifications(
  supabase: SupabaseClient,
  opts: { officeId: string; tenantId: string; alerts: HoumonPlanAlert[] },
): Promise<number> {
  const { officeId, tenantId } = opts;
  const alerts = notifiable(opts.alerts);
  if (alerts.length === 0) return 0;

  const notified = new Set<string>();
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("notifications")
      .select("type, ref_id")
      .eq("office_id", officeId)
      .in("type", HOUMON_PLAN_ALERT_TYPES)
      .order("id") // page-loop の安定順序
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
    .map((a) => {
      const type = HOUMON_PLAN_ALERT_TYPE_BY_STAGE[a.stage];
      if (notified.has(`${type}:${a.plan.id}`)) return null;
      const { title, body } = buildHoumonPlanAlertMessage(a);
      return {
        tenant_id: tenantId,
        office_id: officeId,
        user_id: null,
        type,
        ref_table: HOUMON_PLAN_REF_TABLE,
        ref_id: a.plan.id,
        title,
        body,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (toInsert.length === 0) return 0;

  const { error: insErr } = await supabase.from("notifications").insert(toInsert);
  if (insErr) throw new Error(`通知の作成に失敗: ${insErr.message}`);
  return toInsert.length;
}

/** 判定 → 未通知分の INSERT を行い、状態一覧を返す (画面表示用) */
export async function runHoumonPlanAlertScan(
  supabase: SupabaseClient,
  opts: { officeId: string; tenantId: string },
): Promise<{ rows: PlanStateRow[]; alerts: HoumonPlanAlert[] }> {
  const rows = await scanHoumonPlanStates(supabase, opts.officeId);
  const alerts = toAlerts(rows);
  await syncHoumonPlanNotifications(supabase, {
    officeId: opts.officeId,
    tenantId: opts.tenantId,
    alerts,
  });
  return { rows, alerts };
}

// ─── 通知クリック時の遷移先解決 ─────────────────────────────────────────

/**
 * 通知行から利用者 id を解決する (ref_id = 計画 id → user_id)。
 * 見つからない / エラー時は null (呼出側でフォールバック)。
 */
export async function resolveHoumonPlanClientId(
  supabase: SupabaseClient,
  n: { ref_table: string | null; ref_id: string | null },
): Promise<string | null> {
  if (!n.ref_id) return null;
  const { data, error } = await supabase
    .from(HOUMON_PLAN_REF_TABLE)
    .select("user_id")
    .eq("id", n.ref_id)
    .maybeSingle();
  if (error) {
    console.error("訪問介護計画書の参照に失敗:", error.message);
    return null;
  }
  return (data as { user_id: string } | null)?.user_id ?? null;
}
