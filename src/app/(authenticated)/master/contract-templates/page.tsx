import Link from "next/link";
import { ArrowLeft, Plus, CheckCircle2, Building2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { ActivateButton } from "./_activate-button";
import { NewVersionButton } from "./_new-version-button";

// contract kind → 適用される事業カテゴリ (= UI 表示用)
const KIND_BUSINESS_CATEGORY: Record<string, string> = {
  契約書兼重要事項説明書: "居宅介護支援",
};

/**
 * /master/contract-templates
 *  = 契約書フォーマット (kaigo_contract_templates) の一覧
 *  種類 (kind) ごとに version 一覧、is_active マーク、新版作成ボタン
 */
export default async function ContractTemplatesPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("kaigo_contract_templates")
    .select("id, kind, version_no, effective_from, is_active, notes, updated_at")
    .order("kind", { ascending: true })
    .order("version_no", { ascending: false });

  if (error) {
    return (
      <div className="p-6 text-sm text-red-600">読取失敗: {error.message}</div>
    );
  }

  // kind ごとにグループ化
  const rows = (data ?? []) as Array<{
    id: string;
    kind: string;
    version_no: number;
    effective_from: string;
    is_active: boolean;
    notes: string | null;
    updated_at: string;
  }>;
  const byKind = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind)!.push(r);
  }
  const kinds = Array.from(byKind.keys());
  if (kinds.length === 0) kinds.push("契約書兼重要事項説明書");

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-center gap-3">
        <Link
          href="/master"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={16} /> マスタ管理へ戻る
        </Link>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">契約書フォーマット</h1>
          <p className="mt-1 text-sm text-gray-500">
            契約書兼重要事項説明書などの条文・別紙・別紙補足を版で管理します。
            新しい版を作ると、以降の新規契約はその版で締結されます。
            既存の契約書は締結時点の版で凍結されます。
          </p>
        </div>
        <Link
          href="/master/contract-templates/office-overrides"
          className="mt-1 inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
        >
          <Building2 size={12} /> 事業所別上書き
        </Link>
      </div>

      {kinds.map((kind) => {
        const versions = byKind.get(kind) ?? [];
        return (
          <section key={kind} className="rounded-lg border bg-white shadow-sm">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-gray-900">{kind}</h2>
                {KIND_BUSINESS_CATEGORY[kind] && (
                  <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                    対象カテゴリ: {KIND_BUSINESS_CATEGORY[kind]}
                  </span>
                )}
              </div>
              <NewVersionButton kind={kind} />
            </header>
            {versions.length === 0 ? (
              <div className="px-4 py-6 text-sm text-gray-500">
                まだ版が登録されていません。「新版を作成」から追加してください。
              </div>
            ) : (
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs font-medium text-gray-600">
                  <tr>
                    <th className="px-4 py-2">version</th>
                    <th className="px-4 py-2">有効化日</th>
                    <th className="px-4 py-2">状態</th>
                    <th className="px-4 py-2">備考</th>
                    <th className="px-4 py-2">更新日時</th>
                    <th className="px-4 py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id} className="border-t">
                      <td className="px-4 py-3 font-mono text-sm">v{v.version_no}</td>
                      <td className="px-4 py-3">{v.effective_from}</td>
                      <td className="px-4 py-3">
                        {v.is_active ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            <CheckCircle2 size={12} /> 有効
                          </span>
                        ) : (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                            非有効
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {v.notes ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(v.updated_at).toLocaleString("ja-JP")}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          {!v.is_active && (
                            <ActivateButton id={v.id} kind={v.kind} />
                          )}
                          <Link
                            href={`/master/contract-templates/${v.id}/diff`}
                            className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100"
                          >
                            差分
                          </Link>
                          <Link
                            href={`/master/contract-templates/${v.id}`}
                            className="inline-flex items-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                          >
                            編集
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      <div className="rounded border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
        <p className="font-semibold">
          <Plus size={12} className="inline" /> 版管理の流れ
        </p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>「新版を作成」= 現行版を複製 (version_no + 1)</li>
          <li>編集画面で条文・別紙を修正</li>
          <li>「有効化」で active 版を切替 → 以降の新規契約はこの版</li>
          <li>過去の契約書は締結時点の版で凍結表示される</li>
        </ol>
      </div>
    </div>
  );
}
