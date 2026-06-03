/**
 * Phase Perf-1: Dashboard 即時表示用 skeleton
 * server-side data 取得中の体感速度改善
 */
export default function DashboardLoading() {
  return (
    <div className="p-6 space-y-6">
      <div className="h-8 w-48 bg-gray-100 rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg shadow-sm border p-5">
            <div className="h-4 w-24 bg-gray-50 rounded animate-pulse mb-2" />
            <div className="h-9 w-20 bg-gray-100 rounded animate-pulse" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg shadow-sm border p-5 space-y-3">
            <div className="h-5 w-32 bg-gray-100 rounded animate-pulse" />
            {Array.from({ length: 5 }).map((_, j) => (
              <div key={j} className="h-12 bg-gray-50 rounded animate-pulse" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
