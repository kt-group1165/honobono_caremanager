"use client";

import Link from "next/link";
import { Database, Building2, Building, FileText } from "lucide-react";

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
          href="/master/office"
          className="flex items-center gap-4 rounded-xl border bg-white p-6 shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="rounded-lg bg-indigo-50 p-3">
            <Building size={24} className="text-indigo-600" />
          </div>
          <div>
            <h2 className="font-bold text-gray-900">自事業所管理 (グループ事業所)</h2>
            <p className="text-sm text-gray-500">自社グループの事業所登録・地域区分・特定事業所加算</p>
          </div>
        </Link>
        <Link
          href="/master/providers"
          className="flex items-center gap-4 rounded-xl border bg-white p-6 shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="rounded-lg bg-green-50 p-3">
            <Building2 size={24} className="text-green-600" />
          </div>
          <div>
            <h2 className="font-bold text-gray-900">サービス事業所マスタ (他社事業所)</h2>
            <p className="text-sm text-gray-500">他社・連携先事業所の登録・提供サービス管理</p>
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
      </div>
    </div>
  );
}
