/**
 * 予防アセスメント 即時表示用 skeleton
 */
export default function YoboAssessmentLoading() {
  return (
    <div className="p-6 space-y-4">
      <div className="h-8 w-64 bg-gray-100 rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg shadow-sm border p-4 space-y-2">
            <div className="h-5 w-3/4 bg-gray-100 rounded animate-pulse" />
            <div className="h-4 w-1/2 bg-gray-50 rounded animate-pulse" />
            <div className="h-16 bg-gray-50 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
