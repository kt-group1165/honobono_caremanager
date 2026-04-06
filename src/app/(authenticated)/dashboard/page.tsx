"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Users,
  Receipt,
  CalendarDays,
  AlertTriangle,
  TrendingUp,
  Clock,
} from "lucide-react";
import { format, differenceInYears, parseISO, startOfMonth, endOfMonth } from "date-fns";
import { ja } from "date-fns/locale";

// ---- Types ----

type SummaryStats = {
  activeUsers: number;
  monthlyBilling: number;
  todayShiftCount: number;
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

type TodayShift = {
  id: string;
  staff_name: string;
  shift_type: string;
  start_time: string | null;
  end_time: string | null;
};

// ---- Helper ----

function calcAge(birthDate: string | null): string {
  if (!birthDate) return "—";
  return `${differenceInYears(new Date(), parseISO(birthDate))}歳`;
}

function formatTime(t: string | null): string {
  if (!t) return "—";
  return t.slice(0, 5);
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

const shiftTypeColors: Record<string, string> = {
  早番: "bg-orange-100 text-orange-700",
  日勤: "bg-blue-100 text-blue-700",
  遅番: "bg-purple-100 text-purple-700",
  夜勤: "bg-indigo-100 text-indigo-700",
  休み: "bg-gray-100 text-gray-500",
  有給: "bg-teal-100 text-teal-700",
  公休: "bg-slate-100 text-slate-600",
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
    todayShiftCount: 0,
    expiringCarePlans: 0,
  });
  const [recentUsers, setRecentUsers] = useState<RecentUser[]>([]);
  const [todayShifts, setTodayShifts] = useState<TodayShift[]>([]);
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
        // 1. Active user count
        const { count: activeUsers, error: e1 } = await supabase
          .from("kaigo_users")
          .select("*", { count: "exact", head: true })
          .eq("status", "active");
        if (e1) throw e1;

        // 2. This month's billing total
        const { data: billingData, error: e2 } = await supabase
          .from("kaigo_billing_records")
          .select("total_amount")
          .gte("billing_month", monthStart)
          .lte("billing_month", monthEnd);
        if (e2) throw e2;
        const monthlyBilling = (billingData ?? []).reduce(
          (sum, r) => sum + (r.total_amount ?? 0),
          0
        );

        // 3. Today's shift count (non-休み shifts)
        const { count: todayShiftCount, error: e3 } = await supabase
          .from("kaigo_shifts")
          .select("*", { count: "exact", head: true })
          .eq("shift_date", todayStr)
          .not("shift_type", "in", '("休み","有給","公休")');
        if (e3) throw e3;

        // 4. Expiring care certifications within 30 days
        const { count: expiringCarePlans, error: e4 } = await supabase
          .from("kaigo_care_certifications")
          .select("*", { count: "exact", head: true })
          .eq("status", "active")
          .lte("end_date", warnEnd)
          .gte("end_date", todayStr);
        if (e4) throw e4;

        setStats({
          activeUsers: activeUsers ?? 0,
          monthlyBilling,
          todayShiftCount: todayShiftCount ?? 0,
          expiringCarePlans: expiringCarePlans ?? 0,
        });

        // 5. Recently registered users (latest 8)
        const { data: usersData, error: e5 } = await supabase
          .from("kaigo_users")
          .select(
            "id, name, birth_date, status, created_at"
          )
          .order("created_at", { ascending: false })
          .limit(8);
        if (e5) throw e5;

        // Fetch latest active care certifications for those users
        const userIds = (usersData ?? []).map((u) => u.id);
        let certMap: Record<string, string> = {};
        if (userIds.length > 0) {
          const { data: certData } = await supabase
            .from("kaigo_care_certifications")
            .select("user_id, care_level")
            .in("user_id", userIds)
            .eq("status", "active")
            .order("start_date", { ascending: false });
          if (certData) {
            certData.forEach((c) => {
              if (!certMap[c.user_id]) certMap[c.user_id] = c.care_level;
            });
          }
        }

        setRecentUsers(
          (usersData ?? []).map((u) => ({
            ...u,
            care_level: certMap[u.id] ?? null,
          }))
        );

        // 6. Today's shifts with staff names
        const { data: shiftsData, error: e6 } = await supabase
          .from("kaigo_shifts")
          .select("id, shift_type, start_time, end_time, staff_id")
          .eq("shift_date", todayStr)
          .not("shift_type", "in", '("休み","有給","公休")')
          .order("start_time", { ascending: true })
          .limit(10);
        if (e6) throw e6;

        const staffIds = [...new Set((shiftsData ?? []).map((s) => s.staff_id).filter(Boolean))];
        let staffMap: Record<string, string> = {};
        if (staffIds.length > 0) {
          const { data: staffData } = await supabase
            .from("kaigo_staff")
            .select("id, name")
            .in("id", staffIds);
          if (staffData) {
            staffData.forEach((s) => {
              staffMap[s.id] = s.name;
            });
          }
        }

        setTodayShifts(
          (shiftsData ?? []).map((s) => ({
            id: s.id,
            staff_name: staffMap[s.staff_id] ?? "—",
            shift_type: s.shift_type,
            start_time: s.start_time,
            end_time: s.end_time,
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
            title="今日のシフト人数"
            value={`${stats.todayShiftCount}名`}
            icon={<CalendarDays size={22} className="text-violet-600" />}
            iconBg="bg-violet-50"
            sub="勤務予定スタッフ"
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

        {/* Today's shifts */}
        <section className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Clock size={18} className="text-violet-500" />
              <h2 className="font-semibold text-gray-700">今日のシフト</h2>
            </div>
            <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-600">
              {dateLabel}
            </span>
          </div>

          {loading ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded-lg bg-gray-100" />
              ))}
            </div>
          ) : todayShifts.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-gray-400">
              本日のシフトはありません
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500">
                    <th className="px-4 py-3">職員名</th>
                    <th className="px-4 py-3">シフト区分</th>
                    <th className="px-4 py-3">時間帯</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {todayShifts.map((s) => {
                    const shiftCls = shiftTypeColors[s.shift_type] ?? "bg-gray-100 text-gray-600";
                    const timeRange =
                      s.start_time && s.end_time
                        ? `${formatTime(s.start_time)} 〜 ${formatTime(s.end_time)}`
                        : s.start_time
                        ? `${formatTime(s.start_time)}〜`
                        : "—";
                    return (
                      <tr key={s.id} className="hover:bg-gray-50/60 transition-colors">
                        <td className="px-4 py-3 font-medium text-gray-800">{s.staff_name}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${shiftCls}`}>
                            {s.shift_type}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{timeRange}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
