import Link from "next/link";
import { ArrowLeft, Building2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

/**
 * /master/contract-templates/office-overrides
 *  = 契約書テンプレの事業所別 override を持つ office 一覧
 *    (現状は「契約書兼重要事項説明書」 = 居宅介護支援 office のみ対象)
 */
export default async function OfficeOverridesListPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("offices")
    .select("id, name, service_type, contract_overrides, is_active")
    .eq("service_type", "居宅介護支援")
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) {
    return (
      <div className="p-6 text-sm text-red-600">読取失敗: {error.message}</div>
    );
  }
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    service_type: string;
    contract_overrides: Record<string, string> | null;
    is_active: boolean;
  }>;

  return (
    <div className="space-y-4 p-4">
      <div>
        <Link
          href="/master/contract-templates"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={16} /> 契約書フォーマット一覧へ戻る
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-gray-900">事業所別 契約書上書き</h1>
        <p className="mt-1 text-sm text-gray-500">
          事業所ごとに苦情窓口・相談窓口・地域別料金など、テンプレの任意 key を上書きできます。
          <br />
          優先順位: 契約書 snapshot → <strong>事業所上書き</strong> → テンプレ有効版 → defaults
        </p>
      </div>

      <div className="rounded-lg border bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-600">
            <tr>
              <th className="px-4 py-2">事業所</th>
              <th className="px-4 py-2">カテゴリ</th>
              <th className="px-4 py-2">上書き key 数</th>
              <th className="px-4 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-500">
                  居宅介護支援 office が見つかりません
                </td>
              </tr>
            )}
            {rows.map((o) => {
              const overrideKeys = Object.keys(o.contract_overrides ?? {}).filter(
                (k) => {
                  const v = o.contract_overrides?.[k];
                  return v !== undefined && v !== null && String(v).trim() !== "";
                },
              );
              return (
                <tr key={o.id} className="border-t">
                  <td className="px-4 py-3 font-medium">
                    <Building2 size={12} className="mr-1 inline text-gray-400" />
                    {o.name}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 ring-1 ring-sky-200">
                      {o.service_type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {overrideKeys.length > 0 ? (
                      <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                        {overrideKeys.length} 個
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">なし (テンプレを使用)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/master/contract-templates/office-overrides/${o.id}`}
                      className="inline-flex items-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                    >
                      編集
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
