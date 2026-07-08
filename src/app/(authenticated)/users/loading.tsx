/**
 * /users → /users/[id] へリダイレクトする間、右ペインに即時表示する skeleton。
 *
 * サイドバーは親レイアウト (users/layout.tsx) で永続描画されるため、ここでは
 * 右ペインの詳細 skeleton だけを出す (外側の padding / 枠は layout が持つ)。
 */
export default function UsersLoading() {
  return (
    <div className="space-y-4">
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
  );
}
