import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Eye } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { EditTemplateForm } from "./_edit-form";
import { KEIYAKU_KEN_JUYO_SECTIONS } from "@/lib/user-contract/types";

// contract kind → 適用される事業カテゴリ (= UI 表示 & preview の office 抽出用)
const KIND_BUSINESS_CATEGORY: Record<string, string> = {
  契約書兼重要事項説明書: "居宅介護支援",
};

// 事業所マスタ (offices/companies) から自動で埋まる key = 編集画面から除外
const AUTO_FILLED_KEYS = new Set([
  "company_name",
  "company_office_name",
  "company_address",
  "company_phone",
  "company_emergency_phone",
  "representative_name",
  "office_designation_number",
  "office_service_area",
]);

/**
 * /master/contract-templates/[id]
 *  = 契約書フォーマット (1 版) の編集
 *  section 単位 (article_*, juyo_01_*, ..., 別紙7_*) で textarea を並べる
 */
export default async function ContractTemplateEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("kaigo_contract_templates")
    .select("id, kind, version_no, effective_from, is_active, content, notes, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return (
      <div className="p-6 text-sm text-red-600">読取失敗: {error.message}</div>
    );
  }
  if (!data) notFound();

  const row = data as {
    id: string;
    kind: string;
    version_no: number;
    effective_from: string;
    is_active: boolean;
    content: Record<string, unknown>;
    notes: string | null;
    updated_at: string;
  };

  // key prefix から group を推定 (= 編集画面の見出し用)
  function groupOf(key: string): string {
    if (key.startsWith("article_")) return "契約本文 (第1〜22条)";
    if (key.startsWith("juyo_01")) return "別紙1 相談窓口";
    if (key.startsWith("juyo_02")) return "別紙2 事業所概要";
    if (key.startsWith("juyo_03")) return "別紙3 申込〜提供の流れ";
    if (key.startsWith("juyo_04")) return "別紙4 利用料金";
    if (key.startsWith("juyo_05")) return "別紙5 利用開始・終了";
    if (key.startsWith("juyo_06")) return "別紙6 事業所の運営方針";
    if (key.startsWith("juyo_07")) return "別紙7 相談・苦情窓口";
    if (key === "privacy_consent_text") return "個人情報同意条項";
    if (key === "preamble_text" || key === "closing_text") return "契約 前文・末尾";
    if (
      key.startsWith("company_") ||
      key === "representative_name" ||
      key.startsWith("office_")
    )
      return "事業者情報 (法人・事業所)";
    return "その他";
  }

  const sections = (
    row.kind === "契約書兼重要事項説明書"
      ? KEIYAKU_KEN_JUYO_SECTIONS.map((s) => ({
          key: s.key,
          label: s.label,
          multiline: s.type === "textarea",
          group: groupOf(s.key),
        }))
      : Object.keys(row.content ?? {}).map((k) => ({
          key: k,
          label: k,
          multiline: true,
          group: groupOf(k),
        }))
  ).filter((s) => !AUTO_FILLED_KEYS.has(s.key));

  // group ごとに並べる
  const grouped = new Map<string, typeof sections>();
  for (const s of sections) {
    if (!grouped.has(s.group)) grouped.set(s.group, []);
    grouped.get(s.group)!.push(s);
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <Link
          href="/master/contract-templates"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={16} /> 版一覧へ戻る
        </Link>
      </div>

      <div className="rounded border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">{row.kind}</h1>
          <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-sm text-gray-700">
            v{row.version_no}
          </span>
          {KIND_BUSINESS_CATEGORY[row.kind] && (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
              対象カテゴリ: {KIND_BUSINESS_CATEGORY[row.kind]}
            </span>
          )}
          {row.is_active ? (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              有効
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
              非有効
            </span>
          )}
          <span className="text-xs text-gray-500">
            有効化日 {row.effective_from} / 最終更新{" "}
            {new Date(row.updated_at).toLocaleString("ja-JP")}
          </span>
          <div className="ml-auto">
            <Link
              href={`/master/contract-templates/${row.id}/preview`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
            >
              <Eye size={14} /> プレビュー (別タブ)
            </Link>
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          事業者情報 (法人名 / 事業所名 / 住所 / 電話 / 事業者番号 / 代表者) は
          事業所マスタから自動反映されるため、ここでは編集しません。制度改正で本文が変わったら
          「新版を作成」 → 編集 → 「有効化」してください。
        </p>
      </div>

      <EditTemplateForm
        id={row.id}
        initialContent={row.content ?? {}}
        initialNotes={row.notes ?? ""}
        groupedSections={Array.from(grouped.entries()).map(([g, arr]) => ({
          group: g,
          items: arr,
        }))}
      />
    </div>
  );
}
