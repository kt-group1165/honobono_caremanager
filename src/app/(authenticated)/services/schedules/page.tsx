"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Loader2,
  User,
} from "lucide-react";
import {
  format,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addWeeks,
  subWeeks,
  isSameDay,
  getDay,
} from "date-fns";
import { ja } from "date-fns/locale";

const SERVICE_TYPE_COLORS: Record<string, string> = {
  訪問介護: "bg-blue-100 text-blue-800 border-blue-200",
  訪問看護: "bg-green-100 text-green-800 border-green-200",
  訪問リハビリ: "bg-teal-100 text-teal-800 border-teal-200",
  通所介護: "bg-orange-100 text-orange-800 border-orange-200",
  通所リハビリ: "bg-yellow-100 text-yellow-800 border-yellow-200",
  短期入所: "bg-purple-100 text-purple-800 border-purple-200",
  居宅療養管理指導: "bg-pink-100 text-pink-800 border-pink-200",
  福祉用具貸与: "bg-gray-100 text-gray-700 border-gray-200",
  その他: "bg-slate-100 text-slate-700 border-slate-200",
};

const DEFAULT_COLOR = "bg-indigo-100 text-indigo-800 border-indigo-200";

interface KaigoUser {
  id: string;
  name: string;
}

interface ServiceRecord {
  id: string;
  service_date: string;
  service_type: string;
  start_time: string;
  end_time: string;
  content: string;
  user_id: string;
  staff_id: string;
  clients?: { name: string };
  members?: { name: string };
}

export default function SchedulesPage() {
  const supabase = createClient();
  const [currentWeek, setCurrentWeek] = useState(new Date());
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [records, setRecords] = useState<ServiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterUser, setFilterUser] = useState("");

  const weekStart = startOfWeek(currentWeek, { weekStartsOn: 1 }); // Monday start
  const weekEnd = endOfWeek(currentWeek, { weekStartsOn: 1 });
  const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd });

  const fetchUsers = useCallback(async () => {
    const { data } = await supabase
      .from("clients")
      .select("id, name")
      .is("deleted_at", null)
      .order("name");
    setUsers(data || []);
  }, [supabase]);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    const fromDate = format(weekStart, "yyyy-MM-dd");
    const toDate = format(weekEnd, "yyyy-MM-dd");

    let query = supabase
      .from("kaigo_service_records")
      .select("*, clients(name), members(name)")
      .gte("service_date", fromDate)
      .lte("service_date", toDate)
      .order("start_time");

    if (filterUser) query = query.eq("user_id", filterUser);

    const { data, error } = await query;
    if (error) {
      toast.error("スケジュールの取得に失敗しました");
    } else {
      setRecords(data || []);
    }
    setLoading(false);
  }, [supabase, weekStart, weekEnd, filterUser]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const getRecordsForDay = (day: Date): ServiceRecord[] =>
    records.filter((r) => {
      try {
        return isSameDay(new Date(r.service_date), day);
      } catch {
        return false;
      }
    });

  const prevWeek = () => setCurrentWeek(subWeeks(currentWeek, 1));
  const nextWeek = () => setCurrentWeek(addWeeks(currentWeek, 1));
  const goToday = () => setCurrentWeek(new Date());

  const isToday = (day: Date) => isSameDay(day, new Date());

  // For user-grouped view: get unique users appearing in current records
  const activeUserIds = filterUser
    ? [filterUser]
    : [...new Set(records.map((r) => r.user_id))];

  const activeUsers = filterUser
    ? users.filter((u) => u.id === filterUser)
    : users.filter((u) => activeUserIds.includes(u.id));

  const weekLabel = `${format(weekStart, "yyyy年M月d日", { locale: ja })} 〜 ${format(weekEnd, "M月d日(E)", { locale: ja })}`;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">サービス予定</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <User size={14} className="text-gray-400" />
            <select
              value={filterUser}
              onChange={(e) => setFilterUser(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">全利用者</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Week Navigation */}
      <div className="flex items-center gap-3">
        <button
          onClick={prevWeek}
          className="rounded-lg border p-2 hover:bg-gray-50 transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-base font-semibold text-gray-800 min-w-[240px] text-center">
          {weekLabel}
        </span>
        <button
          onClick={nextWeek}
          className="rounded-lg border p-2 hover:bg-gray-50 transition-colors"
        >
          <ChevronRight size={18} />
        </button>
        <button
          onClick={goToday}
          className="rounded-lg border px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          今週
        </button>
        {loading && <Loader2 size={16} className="animate-spin text-blue-500" />}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(SERVICE_TYPE_COLORS).map(([type, cls]) => (
          <span key={type} className={`rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>
            {type}
          </span>
        ))}
      </div>

      {/* Calendar Grid */}
      {activeUsers.length === 0 && !loading ? (
        <div className="rounded-lg border bg-white py-16 text-center">
          <Calendar size={32} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">この週のサービス予定はありません</p>
        </div>
      ) : (
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          {/* Day headers */}
          <div className="grid border-b bg-gray-50" style={{ gridTemplateColumns: "160px repeat(7, 1fr)" }}>
            <div className="px-3 py-2 text-xs font-medium text-gray-500 border-r">
              利用者
            </div>
            {weekDays.map((day) => {
              const dow = getDay(day);
              const isSun = dow === 0;
              const isSat = dow === 6;
              const today = isToday(day);
              return (
                <div
                  key={day.toISOString()}
                  className={`px-2 py-2 text-center text-xs font-medium border-r last:border-r-0 ${
                    today
                      ? "bg-blue-600 text-white"
                      : isSun
                      ? "text-red-500"
                      : isSat
                      ? "text-blue-500"
                      : "text-gray-600"
                  }`}
                >
                  <div className="font-semibold">{format(day, "d")}</div>
                  <div className={`text-[11px] ${today ? "text-blue-100" : "opacity-70"}`}>
                    {format(day, "E", { locale: ja })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* User rows */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-blue-500" />
            </div>
          ) : (
            <div className="divide-y">
              {activeUsers.map((user) => (
                <div
                  key={user.id}
                  className="grid hover:bg-gray-50/50 transition-colors"
                  style={{ gridTemplateColumns: "160px repeat(7, 1fr)" }}
                >
                  {/* User name */}
                  <div className="flex items-start gap-2 px-3 py-2 border-r">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
                      <User size={12} className="text-blue-600" />
                    </div>
                    <span className="text-sm font-medium text-gray-800 leading-tight">
                      {user.name}
                    </span>
                  </div>

                  {/* Day cells */}
                  {weekDays.map((day) => {
                    const dayRecords = getRecordsForDay(day).filter(
                      (r) => r.user_id === user.id
                    );
                    const today = isToday(day);
                    const dow = getDay(day);

                    return (
                      <div
                        key={day.toISOString()}
                        className={`min-h-[60px] px-1 py-1 border-r last:border-r-0 ${
                          today ? "bg-blue-50/40" : dow === 0 ? "bg-red-50/20" : dow === 6 ? "bg-blue-50/10" : ""
                        }`}
                      >
                        <div className="space-y-0.5">
                          {dayRecords.length === 0 ? null : (
                            dayRecords.map((record) => {
                              const colorCls =
                                SERVICE_TYPE_COLORS[record.service_type] || DEFAULT_COLOR;
                              return (
                                <div
                                  key={record.id}
                                  className={`rounded border px-1.5 py-0.5 text-[11px] font-medium leading-tight ${colorCls}`}
                                  title={[
                                    record.service_type,
                                    record.start_time && record.end_time
                                      ? `${record.start_time}〜${record.end_time}`
                                      : record.start_time || "",
                                    record.members?.name || "",
                                    record.content || "",
                                  ]
                                    .filter(Boolean)
                                    .join(" | ")}
                                >
                                  <div className="font-semibold truncate">{record.service_type}</div>
                                  {(record.start_time || record.end_time) && (
                                    <div className="opacity-75 truncate">
                                      {record.start_time}
                                      {record.end_time && `〜${record.end_time}`}
                                    </div>
                                  )}
                                  {record.members?.name && (
                                    <div className="opacity-60 truncate">
                                      {record.members.name}
                                    </div>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Weekly summary */}
      {!loading && records.length > 0 && (
        <div className="rounded-lg border bg-gray-50 p-4">
          <div className="text-sm font-medium text-gray-700 mb-2">週間サマリー</div>
          <div className="grid grid-cols-7 gap-2 text-xs">
            {weekDays.map((day) => {
              const dayRecs = getRecordsForDay(day);
              const dow = getDay(day);
              const today = isToday(day);
              return (
                <div
                  key={day.toISOString()}
                  className={`rounded-lg border p-2 text-center ${
                    today ? "border-blue-300 bg-blue-50" : "bg-white"
                  }`}
                >
                  <div
                    className={`font-semibold mb-1 ${
                      today ? "text-blue-600" : dow === 0 ? "text-red-500" : dow === 6 ? "text-blue-500" : "text-gray-700"
                    }`}
                  >
                    {format(day, "E", { locale: ja })}
                  </div>
                  <div className="text-lg font-bold text-gray-900">{dayRecs.length}</div>
                  <div className="text-gray-400">件</div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs text-gray-600">
            <span>週合計: <strong className="text-gray-900">{records.length}件</strong></span>
            <span>利用者数: <strong className="text-gray-900">{activeUsers.length}名</strong></span>
          </div>
        </div>
      )}
    </div>
  );
}
