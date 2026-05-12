/**
 * /master/service-codes 用の Suspense fallback (Next.js App Router 規約)
 *
 * 目的: クリック直後に即スケルトンを表示し、画面が反応した感を出す。
 *   通常 page.tsx は Supabase クエリ (limit 2000) を await してから render するので
 *   1-2 秒は古い画面のまま固まって見えてしまう。loading.tsx があると Next.js が
 *   自動で <Suspense fallback> として使い、クリック直後に置換される。
 *
 * デザイン: page の Header / Filter bar / Table の骨格と一致させ、コンテンツが
 *   stream-in したときに layout shift を最小化する。
 */
import { Tag, Loader2 } from "lucide-react";

export default function ServiceCodesLoading() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header (実画面と同じ高さ / 同じレイアウト) ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <Tag className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800">
                サービスコードマスタ
              </h1>
              <p className="text-sm text-gray-500">介護サービスコードの管理</p>
            </div>
            <span className="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
              <Loader2 className="w-3 h-3 animate-spin" />
              読み込み中
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-9 w-24 rounded-lg bg-gray-100 animate-pulse" />
            <div className="h-9 w-24 rounded-lg bg-gray-100 animate-pulse" />
            <div className="h-9 w-28 rounded-lg bg-indigo-200 animate-pulse" />
          </div>
        </div>
      </div>

      {/* ── Filters skeleton ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-9 w-36 rounded-lg bg-gray-100 animate-pulse" />
          <div className="h-9 w-44 rounded-lg bg-gray-100 animate-pulse" />
          <div className="h-9 w-32 rounded-lg bg-gray-100 animate-pulse" />
          <div className="h-9 flex-1 min-w-[200px] rounded-lg bg-gray-100 animate-pulse" />
        </div>
      </div>

      {/* ── Table skeleton ── */}
      <div className="p-6">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-6 py-3 border-b border-gray-200 bg-gray-50">
            <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
          </div>
          <div className="divide-y divide-gray-100">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="px-6 py-3 flex items-center gap-4">
                <div className="h-4 w-20 rounded bg-gray-100 animate-pulse" />
                <div className="h-4 w-16 rounded bg-gray-100 animate-pulse" />
                <div className="h-4 flex-1 rounded bg-gray-100 animate-pulse" />
                <div className="h-4 w-12 rounded bg-gray-100 animate-pulse" />
                <div className="h-4 w-16 rounded bg-gray-100 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
