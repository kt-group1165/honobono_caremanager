"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  Users,
  Wallet,
  ClipboardList,
  AlertTriangle,
  TrendingUp,
  FileText,
  CalendarClock,
} from "lucide-react";
import { format, differenceInYears, parseISO, startOfMonth, endOfMonth } from "date-fns";
import { ja } from "date-fns/locale";
import { useBusinessType } from "@/lib/business-type-context";
import { runCertExpiryScan, type CertExpiryAlert } from "@/lib/cert-expiry-alert";
import {
  aggregateMonthlyUriage,
  aggregateAllOfficesUriage,
  type UriageBreakdown,
  type AllOfficesUriage,
} from "@/lib/uriage/aggregate-uriage";
import { MonthNav } from "@/app/(authenticated)/billing-visit/_shared/month-nav";

// ---- Types ----

type SummaryStats = {
  activeUsers: number;
  monthlyServiceCount: number;
  expiringCarePlans: number;
};

type RecentUser = {
  id: string;
  name: string;
  birth_date: string | null;
  care_level: string | null;
  status: string;
  created_at: string;
};

type RecentServiceRecord = {
  id: string;
  service_date: string;
  user_name: string;
  service_type: string | null;
  content: string | null;
};

// ---- Helper ----

function calcAge(birthDate: string | null): string {
  if (!birthDate) return "—";
  return `${differenceInYears(new Date(), parseISO(birthDate))}歳`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(amount);
}

const statusLabel: Record<string, { text: string; cls: string }> = {
  active: { text: "在籍", cls: "bg-green-100 text-green-700" },
  inactive: { text: "退所", cls: "bg-gray-100 text-gray-600" },
  deceased: { text: "死亡", cls: "bg-red-100 text-red-700" },
};

// ---- Summary Card ----

type SummaryCardProps = {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  iconBg: string;
  sub?: string;
};

function SummaryCard({ title, value, icon, iconBg, sub }: SummaryCardProps) {
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
      <div className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm text-gray-500 truncate">{title}</p>
        <p className="mt-0.5 text-2xl font-bold text-gray-800 leading-tight">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
      </div>
    </div>
  );
}

// ---- Cert expiry stage badge ----

function CertStageBadge({
  stage,
  daysLeft,
}: {
  stage: CertExpiryAlert["stage"];
  daysLeft: number;
}) {
  if (stage === "expired") {
    return (
      <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 whitespace-nowrap">
        期限切れ ({-daysLeft}日経過)
      </span>
    );
  }
  const cls =
    stage === "within30"
      ? "bg-amber-100 text-amber-700"
      : "bg-yellow-50 text-yellow-700";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}>
      残{daysLeft}日
    </span>
  );
}

// ---- Main Page ----

export default function DashboardPage() {
  const [stats, setStats] = useState<SummaryStats>({
    activeUsers: 0,
    monthlyServiceCount: 0,
    expiringCarePlans: 0,
  });
  const [recentUsers, setRecentUsers] = useState<RecentUser[]>([]);
  const [recentServiceRecords, setRecentServiceRecords] = useState<RecentServiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 認定更新の能動アラート (段階判定 + 未通知分の notifications INSERT + カード表示)
  const { businessType, loading: bizLoading, currentOfficeId, currentOffice } = useBusinessType();
  const tenantId = currentOffice?.tenant_id ?? null;
  const isCareManagement = businessType === "居宅介護支援";
  const [certAlerts, setCertAlerts] = useState<CertExpiryAlert[]>([]);
  const [certLoading, setCertLoading] = useState(true);
  const [certError, setCertError] = useState<string | null>(null);

  // 売上 (予定+実績) と 請求額 (実績のみ) — 同じ集計エンジンを status 条件だけ変えて 2 本流す
  const [uriage, setUriage] = useState<UriageBreakdown | null>(null);
  const [jisseki, setJisseki] = useState<UriageBreakdown | null>(null);
  const [uriageLoading, setUriageLoading] = useState(true);
  const [uriageError, setUriageError] = useState<string | null>(null);

  // 売上の対象月 (サマリーカードや認定アラートは常に当月なので、月切替は売上セクションのみ)
  const nowForInit = new Date();
  const [uriageYear, setUriageYear] = useState(nowForInit.getFullYear());
  const [uriageMonth, setUriageMonth] = useState(nowForInit.getMonth() + 1);

  // 集計スコープ: 自事業所 (自動) / 全事業所 (重いのでボタンで明示起動)
  const [scope, setScope] = useState<"self" | "all">("self");
  const [allUriage, setAllUriage] = useState<AllOfficesUriage | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [allProgress, setAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [allError, setAllError] = useState<string | null>(null);

  const today = new Date();
  const todayStr = format(today, "yyyy-MM-dd");
  const monthStart = format(startOfMonth(today), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(today), "yyyy-MM-dd");
  // Expiry warning: care plans ending within 30 days
  const warnEnd = format(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30),
    "yyyy-MM-dd"
  );

  useEffect(() => {
    const supabase = createClient();

    async function fetchDashboard() {
      setLoading(true);
      setError(null);

      try {
        // 1. Active user count（is_facility=false で法人/事業所エントリを除外）
        const { count: activeUsers, error: e1 } = await supabase
          .from("clients")
          .select("*", { count: "exact", head: true })
          .eq("status", "active")
          .eq("is_facility", false)
          .is("deleted_at", null);
        if (e1) throw e1;

        // 2. This month's service record count
        const { count: monthlyServiceCount, error: e3 } = await supabase
          .from("kaigo_service_records")
          .select("*", { count: "exact", head: true })
          .gte("service_date", monthStart)
          .lte("service_date", monthEnd);
        if (e3) throw e3;

        // 3. Expiring care certifications within 30 days（client_insurance_records、新カラム名）
        const { count: expiringCarePlans, error: e4 } = await supabase
          .from("client_insurance_records")
          .select("*", { count: "exact", head: true })
          .eq("certification_status", "認定済み")
          .lte("certification_end_date", warnEnd)
          .gte("certification_end_date", todayStr);
        if (e4) throw e4;

        setStats({
          activeUsers: activeUsers ?? 0,
          monthlyServiceCount: monthlyServiceCount ?? 0,
          expiringCarePlans: expiringCarePlans ?? 0,
        });

        // 4. Recently registered users (latest 8)（法人/事業所エントリを除外）
        const { data: usersData, error: e5 } = await supabase
          .from("clients")
          .select(
            "id, name, birth_date, status, created_at"
          )
          .eq("is_facility", false)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(8);
        if (e5) throw e5;

        // Fetch latest active care certifications for those users
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
        const userIds = (usersData ?? []).map((u: any) => u.id);
        const certMap: Record<string, string> = {};
        if (userIds.length > 0) {
          // client_insurance_records、新カラム名（user_id → client_id, status → certification_status, start_date → certification_start_date）
          const { data: certData } = await supabase
            .from("client_insurance_records")
            .select("client_id, care_level")
            .in("client_id", userIds)
            .eq("certification_status", "認定済み")
            .order("certification_start_date", { ascending: false, nullsFirst: false });
          if (certData) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
            certData.forEach((c: any) => {
              if (!certMap[c.client_id]) certMap[c.client_id] = c.care_level;
            });
          }
        }

        setRecentUsers(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
          (usersData ?? []).map((u: any) => ({
            ...u,
            care_level: certMap[u.id] ?? null,
          }))
        );

        // 5. Recent service records with user names (latest 10)
        const { data: serviceData, error: e6 } = await supabase
          .from("kaigo_service_records")
          .select("id, service_date, service_type, content, user_id")
          .order("service_date", { ascending: false })
          .limit(10);
        if (e6) throw e6;

        const serviceUserIds = [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
          ...new Set((serviceData ?? []).map((s: any) => s.user_id).filter(Boolean)),
        ];
        const userNameMap: Record<string, string> = {};
        if (serviceUserIds.length > 0) {
          const { data: serviceUsersData } = await supabase
            .from("clients")
            .select("id, name")
            .in("id", serviceUserIds);
          if (serviceUsersData) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
            serviceUsersData.forEach((u: any) => {
              userNameMap[u.id] = u.name;
            });
          }
        }

        setRecentServiceRecords(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
          (serviceData ?? []).map((s: any) => ({
            id: s.id,
            service_date: s.service_date,
            user_name: userNameMap[s.user_id] ?? "—",
            service_type: s.service_type ?? null,
            content: s.content ?? null,
          }))
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "データの取得に失敗しました";
        setError(msg);
      } finally {
        setLoading(false);
      }
    }

    fetchDashboard();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
  }, []);

  // 認定更新アラート: ダッシュボード読込時に判定 → 未通知分だけ notifications へ INSERT
  useEffect(() => {
    if (bizLoading) return; // office 解決待ち
    let cancelled = false;
    const run = async () => {
      if (!currentOfficeId || !tenantId) {
        setCertAlerts([]);
        setCertLoading(false);
        return;
      }
      setCertLoading(true);
      setCertError(null);
      try {
        const supabase = createClient();
        const alerts = await runCertExpiryScan(supabase, {
          officeId: currentOfficeId,
          tenantId,
          isCareManagement,
        });
        if (!cancelled) setCertAlerts(alerts);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "認定更新アラートの生成に失敗しました";
        console.error("cert expiry scan failed:", msg);
        if (!cancelled) setCertError(msg);
      } finally {
        if (!cancelled) setCertLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [bizLoading, currentOfficeId, tenantId, isCareManagement]);

  // 売上 (予定+実績) / 請求額 (実績のみ) の月次集計。
  // 請求集計エンジンをそのまま回すので重い → サマリーカードとは独立に遅延ロードする。
  useEffect(() => {
    if (bizLoading) return;
    let cancelled = false;
    const run = async () => {
      if (!currentOfficeId || !tenantId) {
        setUriage(null);
        setJisseki(null);
        setUriageLoading(false);
        return;
      }
      setUriageLoading(true);
      setUriageError(null);
      try {
        const supabase = createClient();
        const base = {
          officeId: currentOfficeId,
          tenantId,
          businessType,
          year: uriageYear,
          month: uriageMonth,
        };
        const [u, j] = await Promise.all([
          aggregateMonthlyUriage(supabase, { ...base, includeScheduled: true }),
          aggregateMonthlyUriage(supabase, { ...base, includeScheduled: false }),
        ]);
        if (cancelled) return;
        setUriage(u);
        setJisseki(j);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "売上の集計に失敗しました";
        console.error("uriage aggregation failed:", msg);
        if (!cancelled) setUriageError(msg);
      } finally {
        if (!cancelled) setUriageLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [bizLoading, currentOfficeId, tenantId, businessType, uriageYear, uriageMonth]);

  // 全事業所の売上集計 (明示操作で起動)。事業所数 × 請求エンジンなので自動では走らせない
  const runAllOffices = async () => {
    setAllLoading(true);
    setAllError(null);
    setAllProgress({ done: 0, total: 0 });
    try {
      const supabase = createClient();
      const res = await aggregateAllOfficesUriage(supabase, {
        year: uriageYear,
        month: uriageMonth,
        includeScheduled: true,
        concurrency: 4,
        onProgress: (done, total) => setAllProgress({ done, total }),
      });
      setAllUriage(res);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "全事業所の集計に失敗しました";
      console.error("all-offices uriage failed:", msg);
      setAllError(msg);
    } finally {
      setAllLoading(false);
    }
  };

  const dateLabel = format(today, "yyyy年M月d日（EEE）", { locale: ja });

  // 全事業所の結果は集計した月のものだけ有効 (月を変えたら再集計させる)
  const uriageYm = `${uriageYear}-${String(uriageMonth).padStart(2, "0")}`;
  const allForMonth = allUriage && allUriage.month === uriageYm ? allUriage : null;

  // 表示中の売上 (自事業所 or 全事業所合算)
  const shownUriage = scope === "all" ? (allForMonth?.total ?? null) : uriage;
  const shownLoading = scope === "all" ? allLoading : uriageLoading;
  const shownError = scope === "all" ? allError : uriageError;

  // 売上内訳の表示行 (0 円の制度は畳む。全部 0 のときは介護保険だけ残す)
  const uriageLines = (() => {
    if (!shownUriage) return [];
    const all = [
      { key: "kaigo", label: "介護保険", value: shownUriage.kaigo, cls: "bg-emerald-400" },
      { key: "sougou", label: "総合事業", value: shownUriage.sougou, cls: "bg-teal-400" },
      { key: "shogai", label: "障害福祉", value: shownUriage.shogai, cls: "bg-indigo-400" },
      { key: "chiiki", label: "地域生活支援", value: shownUriage.chiiki, cls: "bg-violet-400" },
      { key: "kyotaku", label: "居宅介護支援費", value: shownUriage.kyotaku, cls: "bg-sky-400" },
      { key: "jihi", label: "自費", value: shownUriage.jihi, cls: "bg-amber-400" },
    ];
    const nonZero = all.filter((l) => l.value !== 0);
    return nonZero.length > 0 ? nonZero : [all[0]];
  })();

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800">ダッシュボード</h1>
          <p className="mt-0.5 text-sm text-gray-500">{dateLabel}</p>
        </div>
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Summary cards */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl bg-gray-100"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            title="利用者数"
            value={`${stats.activeUsers}名`}
            icon={<Users size={22} className="text-blue-600" />}
            iconBg="bg-blue-50"
            sub="現在の在籍者"
          />
          <SummaryCard
            title={scope === "all" ? "売上（全事業所）" : "売上"}
            value={
              shownLoading
                ? "集計中…"
                : shownError || !shownUriage
                  ? "—"
                  : formatCurrency(shownUriage.total)
            }
            icon={<Wallet size={22} className="text-emerald-600" />}
            iconBg="bg-emerald-50"
            sub={`${uriageYear}年${uriageMonth}月 予定+実績`}
          />
          <SummaryCard
            title="今月のサービス件数"
            value={`${stats.monthlyServiceCount}件`}
            icon={<ClipboardList size={22} className="text-violet-600" />}
            iconBg="bg-violet-50"
            sub={format(today, "yyyy年M月", { locale: ja })}
          />
          <SummaryCard
            title="ケアプラン期限切れ"
            value={`${stats.expiringCarePlans}件`}
            icon={<AlertTriangle size={22} className="text-amber-500" />}
            iconBg="bg-amber-50"
            sub="30日以内に期限到来"
          />
        </div>
      )}

      {/* 売上 内訳 (予定+実績で算定。請求のタイミングとは無関係) */}
      <section className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Wallet size={18} className="text-emerald-500" />
            <h2 className="font-semibold text-gray-700">売上内訳</h2>
            <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
              予定+実績 / キャンセル除く
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* 集計スコープ */}
            <div className="inline-flex rounded-lg border bg-white p-0.5 text-sm">
              {(["self", "all"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={`rounded-md px-3 py-1 font-medium transition-colors ${
                    scope === s
                      ? "bg-emerald-500 text-white"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {s === "self" ? "自事業所" : "全事業所"}
                </button>
              ))}
            </div>
            <MonthNav
              year={uriageYear}
              month={uriageMonth}
              onChange={(y, m) => {
                setUriageYear(y);
                setUriageMonth(m);
              }}
              label={(y, m) => `${y}年${m}月`}
            />
          </div>
        </div>

        {scope === "all" && !allForMonth && !allLoading ? (
          <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
            <p className="text-sm text-gray-500">
              全事業所（訪問介護・訪問看護・訪問入浴・居宅介護支援）の売上を
              {uriageYear}年{uriageMonth}月分で集計します。
              <br />
              <span className="text-xs text-gray-400">
                事業所数ぶん請求エンジンを回すため 1 分ほどかかります
              </span>
            </p>
            {allError && (
              <p className="flex items-center gap-1.5 text-sm text-red-600">
                <AlertTriangle size={14} /> {allError}
              </p>
            )}
            <button
              type="button"
              onClick={runAllOffices}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
            >
              全事業所を集計
            </button>
          </div>
        ) : shownLoading ? (
          <div className="space-y-3 p-5">
            {scope === "all" && allProgress && allProgress.total > 0 && (
              <p className="text-center text-sm text-gray-500">
                集計中… {allProgress.done} / {allProgress.total} 事業所
              </p>
            )}
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-6 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : shownError ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-red-600">
            <AlertTriangle size={16} />
            <span>売上の集計に失敗しました: {shownError}</span>
          </div>
        ) : !shownUriage || (scope === "self" && !currentOfficeId) ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">
            事業所を選択してください
          </p>
        ) : (
          <div className="px-5 py-4">
            {/* 合計 */}
            <div className="flex items-baseline justify-between border-b border-gray-100 pb-3">
              <span className="text-sm font-medium text-gray-600">
                売上合計
                {scope === "all" && allForMonth && (
                  <span className="ml-2 text-xs text-gray-400">
                    {allForMonth.offices.length}事業所
                  </span>
                )}
              </span>
              <span className="text-2xl font-bold text-gray-800 tabular-nums">
                {formatCurrency(shownUriage.total)}
              </span>
            </div>

            {/* 制度別内訳 */}
            <dl className="mt-3 space-y-2">
              {uriageLines.map((l) => {
                const pct = shownUriage.total > 0 ? (l.value / shownUriage.total) * 100 : 0;
                return (
                  <div key={l.key} className="flex items-center gap-3">
                    <dt className="flex w-32 shrink-0 items-center gap-2 text-sm text-gray-600">
                      <span className={`size-2.5 shrink-0 rounded-full ${l.cls}`} />
                      <span className="truncate">{l.label}</span>
                    </dt>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <div className={`h-full rounded-full ${l.cls}`} style={{ width: `${pct}%` }} />
                    </div>
                    <dd className="w-28 shrink-0 text-right text-sm font-medium text-gray-700 tabular-nums">
                      {formatCurrency(l.value)}
                    </dd>
                    <span className="w-12 shrink-0 text-right text-xs text-gray-400 tabular-nums">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                );
              })}
            </dl>

            {/* 実績確定分 = 今そのまま請求できる額 (自事業所のみ。全事業所は負荷が倍になるので出さない) */}
            {scope === "self" && (
              <div className="mt-4 flex items-baseline justify-between border-t border-gray-100 pt-3">
                <span className="text-sm text-gray-500">
                  うち実績確定分（請求額）
                  <span className="ml-2 text-xs text-gray-400">
                    残り予定 {formatCurrency(Math.max(0, shownUriage.total - (jisseki?.total ?? 0)))}
                  </span>
                </span>
                <span className="text-base font-semibold text-gray-700 tabular-nums">
                  {formatCurrency(jisseki?.total ?? 0)}
                </span>
              </div>
            )}

            {/* 事業所別 (全事業所モードのみ) */}
            {scope === "all" && allForMonth && allForMonth.offices.length > 0 && (
              <div className="mt-4 border-t border-gray-100 pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-600">事業所別</h3>
                  <button
                    type="button"
                    onClick={runAllOffices}
                    className="text-xs text-emerald-600 hover:underline"
                  >
                    再集計
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500">
                        <th className="px-3 py-2">事業所</th>
                        <th className="px-3 py-2">種別</th>
                        <th className="px-3 py-2 text-right">介護保険</th>
                        <th className="px-3 py-2 text-right">総合事業</th>
                        <th className="px-3 py-2 text-right">障害福祉</th>
                        <th className="px-3 py-2 text-right">地域生活支援</th>
                        <th className="px-3 py-2 text-right">居宅支援費</th>
                        <th className="px-3 py-2 text-right">自費</th>
                        <th className="px-3 py-2 text-right">売上</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {allForMonth.offices.map((o) => (
                        <tr key={o.officeId} className="hover:bg-gray-50/60 transition-colors">
                          <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">
                            {o.officeName}
                          </td>
                          <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                            {o.serviceType}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                            {o.uriage.kaigo ? o.uriage.kaigo.toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                            {o.uriage.sougou ? o.uriage.sougou.toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                            {o.uriage.shogai ? o.uriage.shogai.toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                            {o.uriage.chiiki ? o.uriage.chiiki.toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                            {o.uriage.kyotaku ? o.uriage.kyotaku.toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                            {o.uriage.jihi ? o.uriage.jihi.toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-800 tabular-nums">
                            {o.uriage.total.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 集計できなかった事業所 (金額を握り潰さず出す) */}
            {scope === "all" && allForMonth && allForMonth.errors.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {allForMonth.errors.map((e, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{e}（この事業所は合計に含まれていません）</span>
                  </li>
                ))}
              </ul>
            )}

            {shownUriage.warnings.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {[...new Set(shownUriage.warnings)].slice(0, 5).map((w, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* 認定更新が近い利用者 (60日以内 / 30日以内 / 期限切れ) */}
      <section className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <CalendarClock size={18} className="text-amber-500" />
            <h2 className="font-semibold text-gray-700">認定更新が近い利用者</h2>
          </div>
          {!certLoading && !certError && (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                certAlerts.some((a) => a.stage === "expired")
                  ? "bg-red-50 text-red-600"
                  : "bg-amber-50 text-amber-600"
              }`}
            >
              {certAlerts.length}名
            </span>
          )}
        </div>

        {certLoading ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : certError ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-red-600">
            <AlertTriangle size={16} />
            <span>認定更新アラートの取得に失敗しました: {certError}</span>
          </div>
        ) : !currentOfficeId ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">
            事業所を選択してください
          </p>
        ) : certAlerts.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">
            60日以内に認定有効期間の満了を迎える利用者はいません
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500">
                  <th className="px-4 py-3">氏名</th>
                  <th className="px-4 py-3">介護度</th>
                  <th className="px-4 py-3">認定有効期間 満了日</th>
                  <th className="px-4 py-3">残り</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {certAlerts.map((a) => (
                  <tr key={a.certId} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/users/${a.clientId}/care-cert${currentOfficeId ? `?office=${encodeURIComponent(currentOfficeId)}` : ""}`}
                        className="text-blue-600 hover:underline"
                      >
                        {a.clientName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {a.careLevel ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      {format(parseISO(a.certEndDate), "yyyy/M/d", { locale: ja })}
                    </td>
                    <td className="px-4 py-3">
                      <CertStageBadge stage={a.stage} daysLeft={a.daysLeft} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Tables section */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recently registered users */}
        <section className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <TrendingUp size={18} className="text-blue-500" />
              <h2 className="font-semibold text-gray-700">最近登録された利用者</h2>
            </div>
            <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-600">
              直近8件
            </span>
          </div>

          {loading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded-lg bg-gray-100" />
              ))}
            </div>
          ) : recentUsers.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-gray-400">
              利用者データがありません
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500">
                    <th className="px-4 py-3">氏名</th>
                    <th className="px-4 py-3">年齢</th>
                    <th className="px-4 py-3">介護度</th>
                    <th className="px-4 py-3">状態</th>
                    <th className="px-4 py-3">登録日</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {recentUsers.map((u) => {
                    const st = statusLabel[u.status] ?? { text: u.status, cls: "bg-gray-100 text-gray-600" };
                    return (
                      <tr key={u.id} className="hover:bg-gray-50/60 transition-colors">
                        <td className="px-4 py-3 font-medium text-gray-800">{u.name}</td>
                        <td className="px-4 py-3 text-gray-600">{calcAge(u.birth_date)}</td>
                        <td className="px-4 py-3 text-gray-600">
                          {u.care_level ?? <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>
                            {st.text}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                          {format(parseISO(u.created_at), "M/d", { locale: ja })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent service records */}
        <section className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <FileText size={18} className="text-violet-500" />
              <h2 className="font-semibold text-gray-700">直近のサービス実績</h2>
            </div>
            <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-600">
              直近10件
            </span>
          </div>

          {loading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded-lg bg-gray-100" />
              ))}
            </div>
          ) : recentServiceRecords.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-gray-400">
              サービス実績がありません
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500">
                    <th className="px-4 py-3">日付</th>
                    <th className="px-4 py-3">利用者名</th>
                    <th className="px-4 py-3">サービス種別</th>
                    <th className="px-4 py-3">内容</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {recentServiceRecords.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {format(parseISO(s.service_date), "M/d", { locale: ja })}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-800">{s.user_name}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {s.service_type ?? <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-[180px] truncate">
                        {s.content ?? <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
