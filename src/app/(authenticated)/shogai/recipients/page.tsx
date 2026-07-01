import Link from "next/link";
import { Plus, FileCheck, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

/**
 * /shogai/recipients
 *  = 障害福祉サービス 受給者一覧
 */
export default async function ShogaiRecipientsPage() {
  const supabase = await createClient();

  const { data: certs, error } = await supabase
    .from("shogai_recipient_certs")
    .select(
      "id, client_id, recipient_number, disability_category, disability_class, benefit_start_date, benefit_end_date, self_payment_limit, seiho_flag, updated_at",
    )
    .order("updated_at", { ascending: false });

  if (error) {
    return (
      <div className="p-6 text-sm text-red-600">読取失敗: {error.message}</div>
    );
  }

  const clientIds = Array.from(new Set((certs ?? []).map((c) => c.client_id)));
  const { data: clientRows } =
    clientIds.length > 0
      ? await supabase
          .from("clients")
          .select("id, name, furigana, user_number")
          .in("id", clientIds)
      : { data: [] as { id: string; name: string; furigana: string | null; user_number: string | null }[] };
  const clientById = new Map(
    (clientRows ?? []).map((c) => [c.id, c] as const),
  );

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">障害福祉受給者管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            受給者証・支給決定・障害支援区分・支給量 を管理します
          </p>
        </div>
        <Link
          href="/shogai/recipients/new"
          className="inline-flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={14} /> 新規登録
        </Link>
      </div>

      <div className="rounded-lg border bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-600">
            <tr>
              <th className="px-4 py-2">利用者</th>
              <th className="px-4 py-2">受給者番号</th>
              <th className="px-4 py-2">障害区分</th>
              <th className="px-4 py-2">支援区分</th>
              <th className="px-4 py-2">支給期間</th>
              <th className="px-4 py-2">自己負担上限</th>
              <th className="px-4 py-2">状態</th>
              <th className="px-4 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {(certs ?? []).length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-gray-500">
                  受給者証が登録されていません
                </td>
              </tr>
            )}
            {(certs ?? []).map((c) => {
              const cl = clientById.get(c.client_id);
              const expired = c.benefit_end_date && c.benefit_end_date < today;
              const expiringSoon =
                c.benefit_end_date &&
                !expired &&
                c.benefit_end_date <
                  new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
              return (
                <tr key={c.id} className="border-t">
                  <td className="px-4 py-3">
                    <div className="font-medium">{cl?.name ?? "(利用者不明)"}</div>
                    {cl?.furigana && (
                      <div className="text-xs text-gray-500">{cl.furigana}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {c.recipient_number ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {c.disability_category ?? "—"}
                    {c.seiho_flag && (
                      <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700 ring-1 ring-amber-200">
                        生保
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.disability_class ? (
                      <span className="rounded bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                        区分{c.disability_class}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    <div>{c.benefit_start_date ?? "—"}</div>
                    <div>〜 {c.benefit_end_date ?? "—"}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    ¥{c.self_payment_limit?.toLocaleString() ?? "0"}
                  </td>
                  <td className="px-4 py-3">
                    {expired ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-700 ring-1 ring-rose-200">
                        <AlertTriangle size={10} /> 期限切れ
                      </span>
                    ) : expiringSoon ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 ring-1 ring-amber-200">
                        <AlertTriangle size={10} /> 90日以内
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-200">
                        <FileCheck size={10} /> 有効
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/shogai/recipients/${c.id}`}
                      className="inline-flex rounded border border-indigo-300 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
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
