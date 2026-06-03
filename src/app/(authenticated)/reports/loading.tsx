/**
 * Phase Perf-1: reports 即時表示用 skeleton
 * 大型コンポーネント (4093 行) の hydration 時間短縮
 */
export default function ReportsLoading() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex gap-2 border-b">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-9 w-24 bg-gray-100 rounded-t animate-pulse" />
        ))}
      </div>
      <div className="bg-white rounded-lg shadow-sm border p-6 space-y-4">
        <div className="h-6 w-48 bg-gray-100 rounded animate-pulse" />
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <div className="h-4 w-20 bg-gray-50 rounded animate-pulse" />
              <div className="h-10 bg-gray-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
