"use client";

import Link from "next/link";
import { Database, Building, FileText, ScrollText } from "lucide-react";

export default function MasterPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">マスタ管理</h1>
        <p className="mt-1 text-sm text-gray-500">サービスコードや事業所の基本情報を管理します</p>
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Link
          href="/master/service-codes"
          className="flex items-center gap-4 rounded-xl border bg-white p-6 shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="rounded-lg bg-blue-50 p-3">
            <Database size={24} className="text-blue-600" />
          </div>
          <div>
            <h2 className="font-bold text-gray-900">サービスコードマスタ</h2>
            <p className="text-sm text-gray-500">サービスコード・単位数・加算の管理</p>
          </div>
        </Link>
        <Link
          href="/master/offices"
          className="flex items-center gap-4 rounded-xl border bg-white p-6 shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="rounded-lg bg-indigo-50 p-3">
            <Building size={24} className="text-indigo-600" />
          </div>
          <div>
            <h2 className="font-bold text-gray-900">事業所マスタ</h2>
            <p className="text-sm text-gray-500">自社グループ・他社（居宅ケアマネ／サービス提供）の事業所を種別タブで管理</p>
          </div>
        </Link>
        <Link
          href="/master/record-templates"
          className="flex items-center gap-4 rounded-xl border bg-white p-6 shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="rounded-lg bg-purple-50 p-3">
            <FileText size={24} className="text-purple-600" />
          </div>
          <div>
            <h2 className="font-bold text-gray-900">定型文マスタ</h2>
            <p className="text-sm text-gray-500">訪問記録・支援経過の定型文テンプレート管理</p>
          </div>
        </Link>
        <Link
          href="/master/contract-templates"
          className="flex items-center gap-4 rounded-xl border bg-white p-6 shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="rounded-lg bg-amber-50 p-3">
            <ScrollText size={24} className="text-amber-600" />
          </div>
          <div>
            <h2 className="font-bold text-gray-900">契約書フォーマット</h2>
            <p className="text-sm text-gray-500">契約書兼重要事項説明書の条文・別紙・版管理</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
