"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Users,
  Receipt,
  ClipboardList,
  AlertTriangle,
  TrendingUp,
  FileText,
} from "lucide-react";
import { format, differenceInYears, parseISO, startOfMonth, endOfMonth } from "date-fns";
import { ja } from "date-fns/locale";

// ---- Types ----

type SummaryStats = {
  activeUsers: number;
  monthlyBilling: number;
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

// ---- Main Page ----

export default function DashboardPage() {
  const [stats, setStats] = useState<SummaryStats>({
    activeUsers: 0,
    monthlyBilling: 0,
    monthlyServiceCount: 0,
    expiringCarePlans: 0,
  });
  const [recentUsers, setRecentUsers] = useState<RecentUser[]>([]);
  const [recentServiceRecords, setRecentServiceRecords] = useState<RecentServiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          .eq("is_facility", false);
        if (e1) throw e1;

        // 2. This month's billing total
        const { data: billingData, error: e2 } = await supabase
          .from("kaigo_billing_records")
          .select("total_amount")
          .gte("billing_month", monthStart)
          .lte("billing_month", monthEnd);
        if (e2) throw e2;
        const monthlyBilling = (billingData ?? []).reduce(
          (sum: number, r: Record<string, number>) => sum + (r.total_amount ?? 0),
          0
        );

        // 3. This month's service record count
        const { count: monthlyServiceCount, error: e3 } = await supabase
          .from("kaigo_service_records")
          .select("*", { count: "exact", head: true })
          .gte("service_date", monthStart)
          .lte("service_date", monthEnd);
        if (e3) throw e3;

        // 4. Expiring care certifications within 30 days（client_insurance_records、新カラム名）
        const { count: expiringCarePlans, error: e4 } = await supabase
          .from("client_insurance_records")
          .select("*", { count: "exact", head: true })
          .eq("certification_status", "認定済み")
          .lte("certification_end_date", warnEnd)
          .gte("certification_end_date", todayStr);
        if (e4) throw e4;

        setStats({
          activeUsers: activeUsers ?? 0,
          monthlyBilling,
          monthlyServiceCount: monthlyServiceCount ?? 0,
          expiringCarePlans: expiringCarePlans ?? 0,
        });

        // 5. Recently registered users (latest 8)（法人/事業所エントリを除外）
        const { data: usersData, error: e5 } = await supabase
          .from("clients")
          .select(
            "id, name, birth_date, status, created_at"
          )
          .eq("is_facility", false)
          .order("created_at", { ascending: false })
          .limit(8);
        if (e5) throw e5;

        // Fetch latest active care certifications for those users
        const userIds = (usersData ?? []).map((u: any) => u.id);
        let certMap: Record<string, string> = {};
        if (userIds.length > 0) {
          // client_insurance_records、新カラム名（user_id → client_id, status → certification_status, start_date → certification_start_date）
          const { data: certData } = await supabase
            .from("client_insurance_records")
            .select("client_id, care_level")
            .in("client_id", userIds)
            .eq("certification_status", "認定済み")
            .order("certification_start_date", { ascending: false, nullsFirst: false });
          if (certData) {
            certData.forEach((c: any) => {
              if (!certMap[c.client_id]) certMap[c.client_id] = c.care_level;
            });
          }
        }

        setRecentUsers(
          (usersData ?? []).map((u: any) => ({
            ...u,
            care_level: certMap[u.id] ?? null,
          }))
        );

        // 6. Recent service records with user names (latest 10)
        const { data: serviceData, error: e6 } = await supabase
          .from("kaigo_service_records")
          .select("id, service_date, service_type, content, user_id")
          .order("service_date", { ascending: false })
          .limit(10);
        if (e6) throw e6;

        const serviceUserIds = [
          ...new Set((serviceData ?? []).map((s: any) => s.user_id).filter(Boolean)),
        ];
        let userNameMap: Record<string, string> = {};
        if (serviceUserIds.length > 0) {
          const { data: serviceUsersData } = await supabase
            .from("clients")
            .select("id, name")
            .in("id", serviceUserIds);
          if (serviceUsersData) {
            serviceUsersData.forEach((u: any) => {
              userNameMap[u.id] = u.name;
            });
          }
        }

        setRecentServiceRecords(
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
  }, []);

  const dateLabel = format(today, "yyyy年M月d日（EEE）", { locale: ja });

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
            title="今月の請求額"
            value={formatCurrency(stats.monthlyBilling)}
            icon={<Receipt size={22} className="text-emerald-600" />}
            iconBg="bg-emerald-50"
            sub={format(today, "yyyy年M月", { locale: ja })}
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
