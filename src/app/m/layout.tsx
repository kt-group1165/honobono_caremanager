"use client";

/**
 * モバイル閲覧専用 layout
 * - サイドバー / ヘッダ なしのミニマル UI
 * - 認証は proxy で必須 (/m は exclusion 対象外)
 */
export default function MobileViewLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50 px-3 py-3 sm:px-6 sm:py-6">
      {children}
    </main>
  );
}
