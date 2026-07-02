/**
 * 汎用ルート loading skeleton。
 * loading.tsx から re-export するだけで dynamic ページも prefetch 対象になり
 * (layout〜loading boundary まで事前取得)、クリック時に即 skeleton が出る。
 */
export function RouteLoading() {
  return (
    <div className="animate-pulse space-y-4 p-2">
      <div className="h-7 w-56 rounded bg-gray-200" />
      <div className="h-4 w-80 rounded bg-gray-100" />
      <div className="space-y-2 pt-2">
        <div className="h-24 rounded-lg bg-gray-100" />
        <div className="h-24 rounded-lg bg-gray-100" />
        <div className="h-24 rounded-lg bg-gray-100" />
      </div>
    </div>
  );
}
