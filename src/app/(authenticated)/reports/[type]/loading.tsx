import { UserSidebar } from "@/components/users/user-sidebar";

// /reports/[type] の RSC fetch (cert + docs) が走っている間の skeleton。
// 利用者 sidebar はそのまま見せて、右ペインだけ skeleton 化する。
// → user click 直後に「サクサク」感を出すために最重要。
export default function ReportTypeLoading() {
  return (
    <div className="flex h-full -m-6">
      <UserSidebar />
      <div className="flex-1 overflow-y-auto p-6">
        {/* Header skeleton */}
        <div className="no-print mb-4 flex items-center justify-between animate-pulse">
          <div className="h-8 w-32 rounded-md bg-gray-200" />
          <div className="flex flex-col items-center gap-1">
            <div className="h-5 w-48 rounded bg-gray-200" />
            <div className="h-3 w-16 rounded bg-gray-100" />
          </div>
          <div className="h-8 w-32 rounded-md bg-gray-200" />
        </div>

        {/* Month selector skeleton */}
        <div className="no-print mb-4 flex items-center justify-between animate-pulse">
          <div className="h-8 w-40 rounded-lg bg-gray-100" />
          <div className="h-8 w-24 rounded-md bg-gray-100" />
        </div>

        {/* Doc list skeleton */}
        <div className="mb-4 rounded-xl border bg-white shadow-sm no-print animate-pulse">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="h-4 w-24 rounded bg-gray-200" />
            <div className="h-7 w-20 rounded-lg bg-gray-200" />
          </div>
          <div className="divide-y">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center justify-between px-4 py-2.5">
                <div className="space-y-1.5">
                  <div className="h-4 w-56 rounded bg-gray-200" />
                  <div className="h-3 w-32 rounded bg-gray-100" />
                </div>
                <div className="h-5 w-16 rounded-full bg-gray-100" />
              </div>
            ))}
          </div>
        </div>

        {/* Editor skeleton */}
        <div className="rounded-xl border bg-white shadow-sm animate-pulse">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="h-4 w-64 rounded bg-gray-200" />
            <div className="flex gap-2">
              <div className="h-7 w-24 rounded-lg bg-gray-100" />
              <div className="h-7 w-20 rounded-lg bg-gray-100" />
              <div className="h-7 w-16 rounded-lg bg-gray-100" />
            </div>
          </div>
          <div className="h-64 bg-gray-50" />
          <div className="px-4 py-2">
            <div className="h-3 w-32 rounded bg-gray-100" />
          </div>
          <div className="h-[400px] bg-gray-50" />
        </div>
      </div>
    </div>
  );
}
