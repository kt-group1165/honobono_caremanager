"use client";

import Link from "next/link";
import { MessagesSquare, FileText } from "lucide-react";

export default function MeetingMinutesPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <MessagesSquare className="text-indigo-600" size={24} />
        <h1 className="text-xl font-bold text-gray-900">会議録</h1>
      </div>

      <div className="rounded-lg border bg-white p-8 shadow-sm">
        <div className="mx-auto max-w-xl text-center">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 mb-4">
            <MessagesSquare size={28} />
          </div>
          <h2 className="text-base font-semibold text-gray-900 mb-2">
            サービス担当者会議の要点（第4表）
          </h2>
          <p className="text-sm text-gray-600 mb-6">
            会議録の専用入力画面は準備中です。現時点では以下の帳票機能から会議の要点を記載・出力できます。
          </p>

          <div className="space-y-2">
            <Link
              href="/reports/support-progress"
              className="flex items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
            >
              <FileText size={16} />
              居宅介護支援経過（第5表）で会議要点を記載
            </Link>
            <Link
              href="/support-records"
              className="flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <FileText size={16} />
              支援経過記録に会議内容を追加
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
