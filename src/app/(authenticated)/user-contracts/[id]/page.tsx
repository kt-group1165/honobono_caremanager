import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  CONTRACT_STATUS_LABELS,
  getSectionsForType,
  type UserContract,
} from "@/lib/user-contract/types";
import { ContractPrintActions } from "./print-actions";

interface KaigoClientLite {
  id: string;
  name: string;
  furigana: string | null;
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  // ISO YYYY-MM-DD を簡易整形 (= サーバー側で date-fns に依存しない)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

export default async function ContractDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ user?: string }>;
}) {
  const { id } = await params;
  const { user: backUserParam } = await searchParams;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("kaigo_user_contracts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return (
      <div className="p-6 text-sm text-red-600">
        取得に失敗しました: {error.message}
      </div>
    );
  }
  const contract = data as UserContract | null;
  if (!contract) notFound();

  // user 情報を取る
  const { data: userRow } = await supabase
    .from("clients")
    .select("id, name, furigana")
    .eq("id", contract.user_id)
    .maybeSingle();
  const user = (userRow ?? null) as KaigoClientLite | null;

  // office 情報
  let officeName: string | null = null;
  if (contract.office_id) {
    const { data: officeRow } = await supabase
      .from("offices")
      .select("name")
      .eq("id", contract.office_id)
      .maybeSingle();
    officeName = (officeRow as { name?: string } | null)?.name ?? null;
  }

  const sections = getSectionsForType(contract.contract_type);
  const backHref = backUserParam
    ? `/user-contracts?user=${encodeURIComponent(backUserParam)}`
    : "/user-contracts";

  return (
    <div className="-m-6">
      {/* 印刷時は非表示にする操作バー */}
      <div className="flex items-center justify-between border-b bg-white px-6 py-3 print:hidden">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={16} /> 一覧へ戻る
        </Link>
        <ContractPrintActions>
          <span className="inline-flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
            <Printer size={14} /> 印刷
          </span>
        </ContractPrintActions>
      </div>

      {/* 印刷用 A4 縦 */}
      <div className="mx-auto my-6 max-w-3xl bg-white p-10 shadow-sm print:my-0 print:max-w-none print:p-12 print:shadow-none">
        <header className="border-b-2 border-gray-700 pb-3 text-center">
          <h1 className="text-2xl font-bold tracking-wider text-gray-900">
            {contract.contract_type}
          </h1>
          {contract.business_type && (
            <p className="mt-1 text-sm text-gray-600">{contract.business_type}</p>
          )}
        </header>

        <section className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-gray-800">
          <div>
            <span className="font-medium text-gray-500">利用者:</span>{" "}
            <span className="font-semibold">{user?.name ?? "—"} 様</span>
            {user?.furigana ? (
              <span className="ml-1 text-xs text-gray-500">({user.furigana})</span>
            ) : null}
          </div>
          <div>
            <span className="font-medium text-gray-500">交付日:</span>{" "}
            {fmtDate(contract.issued_date)}
          </div>
          <div>
            <span className="font-medium text-gray-500">事業所:</span>{" "}
            {officeName ?? "—"}
          </div>
          <div>
            <span className="font-medium text-gray-500">状態:</span>{" "}
            {CONTRACT_STATUS_LABELS[contract.status]}
          </div>
          <div>
            <span className="font-medium text-gray-500">効力発生:</span>{" "}
            {fmtDate(contract.effective_from)}
          </div>
          <div>
            <span className="font-medium text-gray-500">効力終了:</span>{" "}
            {fmtDate(contract.effective_until)}
          </div>
        </section>

        <section className="mt-6 space-y-4">
          {sections.map((sec) => {
            const value = (contract.content?.[sec.key] ?? "").toString();
            if (!value.trim()) return null;
            return (
              <div key={sec.key}>
                <h2 className="border-l-4 border-indigo-500 pl-2 text-sm font-semibold text-gray-800">
                  {sec.label}
                </h2>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {value}
                </p>
              </div>
            );
          })}
          {sections.every((sec) => !(contract.content?.[sec.key] ?? "").toString().trim()) && (
            <p className="text-sm text-gray-400">本文未入力</p>
          )}
        </section>

        {contract.notes && (
          <section className="mt-6 border-t pt-3">
            <h2 className="text-xs font-semibold text-gray-500">備考</h2>
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{contract.notes}</p>
          </section>
        )}

        {/* 署名欄 */}
        <section className="mt-10 grid grid-cols-2 gap-6 border-t pt-4 text-sm">
          <div>
            <p className="text-xs text-gray-500">説明者 (事業者):</p>
            <div className="mt-6 border-b border-gray-400" />
          </div>
          <div>
            <p className="text-xs text-gray-500">
              署名者 (利用者・代理人):
              {contract.signed_by_relation ? (
                <span className="ml-1">({contract.signed_by_relation})</span>
              ) : null}
            </p>
            <div className="mt-6 border-b border-gray-400">
              {contract.signed_by_name ? (
                <span className="text-sm">{contract.signed_by_name}</span>
              ) : null}
            </div>
            {contract.signed_at && (
              <p className="mt-1 text-xs text-gray-500">
                署名日: {fmtDate(contract.signed_at)}
              </p>
            )}
          </div>
        </section>

        {contract.attachment_url && (
          <p className="mt-6 text-xs text-gray-500 print:hidden">
            添付:{" "}
            <a
              href={contract.attachment_url}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-600 underline"
            >
              {contract.attachment_url}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
