/**
 * Phase Perf-1: provision-tickets 即時表示用 skeleton
 */
export default function ProvisionTicketsLoading() {
  return (
    <div className="p-6 space-y-4">
      <div className="h-8 w-48 bg-gray-100 rounded animate-pulse" />
      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        <div className="grid grid-cols-[200px_repeat(31,minmax(40px,1fr))] gap-px bg-gray-200">
          {Array.from({ length: 32 }).map((_, i) => (
            <div key={i} className="h-8 bg-gray-50" />
          ))}
        </div>
        <div className="divide-y">
          {Array.from({ length: 15 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[200px_repeat(31,minmax(40px,1fr))] gap-px bg-gray-100">
              <div className="h-10 bg-white animate-pulse" />
              {Array.from({ length: 31 }).map((_, j) => (
                <div key={j} className="h-10 bg-white" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
