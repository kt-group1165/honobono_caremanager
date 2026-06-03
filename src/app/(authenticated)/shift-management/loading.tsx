/**
 * Phase Perf-1: shift-management 即時表示用 skeleton
 * 複数 fetch (visit_schedule + clients + members 等) 待機時の体感速度改善
 */
export default function ShiftManagementLoading() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-8 w-40 bg-gray-100 rounded animate-pulse" />
        <div className="h-9 w-32 bg-blue-50 rounded animate-pulse" />
      </div>
      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        <div className="grid grid-cols-8 gap-1 p-2 bg-gray-50">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-6 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
        <div className="divide-y">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="grid grid-cols-8 gap-1 p-2">
              {Array.from({ length: 8 }).map((_, j) => (
                <div key={j} className="h-10 bg-gray-50 rounded animate-pulse" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
