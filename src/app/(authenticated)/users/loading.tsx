/**
 * /users → /users/[id] へリダイレクトする間、即時表示する skeleton。
 * Next.js が server component の処理完了を待たずに HTML を返してくれる。
 */
export default function UsersLoading() {
  return (
    <div className="flex h-full">
      {/* 左サイドバー skeleton (利用者一覧) */}
      <div className="w-64 border-r bg-white p-3 space-y-2">
        <div className="h-9 bg-gray-100 rounded animate-pulse" />
        <div className="flex gap-1 mt-3">
          <div className="h-7 flex-1 bg-blue-100 rounded animate-pulse" />
          <div className="h-7 flex-1 bg-gray-100 rounded animate-pulse" />
        </div>
        <div className="mt-4 space-y-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-10 bg-gray-50 rounded animate-pulse" />
          ))}
        </div>
      </div>
      {/* 右側 main skeleton */}
      <div className="flex-1 p-6">
        <div className="bg-white rounded-lg shadow-sm border p-6 space-y-4 max-w-4xl">
          <div className="flex items-center gap-3">
            <div className="h-14 w-14 rounded-full bg-blue-50 animate-pulse" />
            <div className="space-y-2 flex-1">
              <div className="h-7 w-64 bg-gray-100 rounded animate-pulse" />
              <div className="h-4 w-40 bg-gray-50 rounded animate-pulse" />
            </div>
          </div>
          <div className="border-t pt-4 grid grid-cols-2 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <div className="h-3 w-16 bg-gray-50 rounded animate-pulse" />
                <div className="h-5 w-full bg-gray-100 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
