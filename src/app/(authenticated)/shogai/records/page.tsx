import Link from "next/link";
import { Plus, CheckCircle2, XCircle, FileEdit } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

const YM_RE = /^(\d{4})-(\d{2})$/;

export default async function ShogaiRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month: monthParam } = await searchParams;
  const supabase = await createClient();

  // 対象月 (未指定なら 今月)
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const month = monthParam && YM_RE.test(monthParam) ? monthParam : defaultMonth;
  const [year, mo] = month.split("-").map(Number);
  const first = `${month}-01`;
  const lastDay = new Date(year, mo, 0).getDate();
  const last = `${month}-${String(lastDay).padStart(2, "0")}`;

  const { data: records } = await supabase
    .from("shogai_service_records")
    .select(
      "id, service_date, start_time, end_time, duration_minutes, service_type, service_category, unit_count, staff_name_cached, status, client_id",
    )
    .gte("service_date", first)
    .lte("service_date", last)
    .order("service_date", { ascending: false })
    .order("start_time", { ascending: false });

  const clientIds = Array.from(new Set((records ?? []).map((r) => r.client_id)));
  const { data: clientRows } =
    clientIds.length > 0
      ? await supabase.from("clients").select("id, name").in("id", clientIds)
      : { data: [] as { id: string; name: string }[] };
  const clientById = new Map(
    (clientRows ?? []).map((c) => [c.id, c.name] as const),
  );

  const totalMinutes = (records ?? [])
    .filter((r) => r.status !== "cancelled")
    .reduce((s, r) => s + (r.duration_minutes ?? 0), 0);
  const totalUnits = (records ?? [])
    .filter((r) => r.status !== "cancelled")
    .reduce((s, r) => s + (r.unit_count ?? 0), 0);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            障害福祉 サービス提供実績
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            対象月: {month} / 全 {(records ?? []).length} 件、合計{" "}
            {Math.floor(totalMinutes / 60)}時間 {totalMinutes % 60}分、
            {totalUnits.toLocaleString()} 単位
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form>
            <input
              type="month"
              name="month"
              defaultValue={month}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <button className="ml-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs">
              切替
            </button>
          </form>
          <Link
            href="/shogai/records/new"
            className="inline-flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus size={14} /> 新規記録
          </Link>
        </div>
      </div>

      <div className="rounded-lg border bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-600">
            <tr>
              <th className="px-4 py-2">日付</th>
              <th className="px-4 py-2">時間帯</th>
              <th className="px-4 py-2">分数</th>
              <th className="px-4 py-2">利用者</th>
              <th className="px-4 py-2">サービス</th>
              <th className="px-4 py-2">単位数</th>
              <th className="px-4 py-2">職員</th>
              <th className="px-4 py-2">状態</th>
              <th className="px-4 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {(records ?? []).length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-6 text-center text-sm text-gray-500"
                >
                  対象月の記録がありません
                </td>
              </tr>
            )}
            {(records ?? []).map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-3 text-xs text-gray-700">
                  {r.service_date}
                </td>
                <td className="px-4 py-3 text-xs text-gray-700">
                  {r.start_time && r.end_time
                    ? `${r.start_time.slice(0, 5)}〜${r.end_time.slice(0, 5)}`
                    : "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {r.duration_minutes ?? "—"} 分
                </td>
                <td className="px-4 py-3 font-medium">
                  {clientById.get(r.client_id) ?? "(不明)"}
                </td>
                <td className="px-4 py-3 text-xs">
                  <div>{r.service_type}</div>
                  {r.service_category && (
                    <div className="text-gray-500">{r.service_category}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs">
                  {r.unit_count?.toLocaleString() ?? "—"}
                </td>
                <td className="px-4 py-3 text-xs text-gray-700">
                  {r.staff_name_cached ?? "—"}
                </td>
                <td className="px-4 py-3">
                  {r.status === "confirmed" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-200">
                      <CheckCircle2 size={10} /> 確定
                    </span>
                  ) : r.status === "cancelled" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-700 ring-1 ring-rose-200">
                      <XCircle size={10} /> キャンセル
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                      下書き
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/shogai/records/${r.id}`}
                    className="inline-flex items-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                  >
                    <FileEdit size={10} /> 編集
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
