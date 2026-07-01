import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  CombinedContractView,
  type OfficeLite,
  type CompanyLite,
  type KaigoClientLite,
} from "../../../../user-contracts/[id]/page";
import type { UserContract } from "@/lib/user-contract/types";

// contract kind → 適用される事業カテゴリ (= プレビュー用 office 抽出)
const KIND_BUSINESS_CATEGORY: Record<string, string> = {
  契約書兼重要事項説明書: "居宅介護支援",
};

/**
 * /master/contract-templates/[id]/preview
 *  = 版の内容 (content) をダミー利用者 + 有効な事業所マスタで render し、
 *    実際の契約書がどう見えるかプレビューする。
 */
export default async function ContractTemplatePreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: tpl } = await supabase
    .from("kaigo_contract_templates")
    .select("id, kind, version_no, content, is_active, effective_from")
    .eq("id", id)
    .maybeSingle();
  if (!tpl) {
    // notFound() は import 経路が違うが、ここは redirect の代替として空 UI で返す
    return (
      <div className="p-6 text-sm text-red-600">version が見つかりません。</div>
    );
  }
  const row = tpl as {
    id: string;
    kind: string;
    version_no: number;
    content: Record<string, string>;
    is_active: boolean;
    effective_from: string;
  };

  const category = KIND_BUSINESS_CATEGORY[row.kind] ?? null;

  // カテゴリに一致する office (先頭 1 件) を sample として fetch
  let office: OfficeLite | null = null;
  let company: CompanyLite | null = null;
  if (category) {
    const { data: o } = await supabase
      .from("offices")
      .select(
        "id, name, address, phone, fax, business_number, representative_name, manager_name, postal_code, company_id",
      )
      .eq("service_type", category)
      .eq("is_active", true)
      .order("name", { ascending: true })
      .limit(1)
      .maybeSingle();
    office = (o as OfficeLite | null) ?? null;
    if (office?.company_id) {
      const { data: co } = await supabase
        .from("companies")
        .select("id, name, short_name, address, phone, fax, representative_name, postal_code")
        .eq("id", office.company_id)
        .maybeSingle();
      company = (co as CompanyLite | null) ?? null;
    }
  }

  // ダミー contract / user
  const dummyUser: KaigoClientLite = {
    id: "00000000-0000-0000-0000-000000000000",
    name: "〇〇 〇〇",
    furigana: "サンプル",
  };
  const dummyContract = {
    id: "preview",
    user_id: dummyUser.id,
    office_id: office?.id ?? null,
    contract_type: row.kind,
    business_type: category,
    status: "draft",
    issued_date: row.effective_from,
    effective_from: row.effective_from,
    effective_until: null,
    signed_at: row.effective_from,
    signed_by_relation: "本人",
    content: {}, // = 契約書本人の snapshot は空 → template から fallback される
    notes: null,
    attachment_url: null,
    template_version_no: row.version_no,
  } as unknown as UserContract;

  return (
    <div>
      {/* Preview banner (印刷時は非表示) */}
      <div className="flex items-center justify-between border-b bg-amber-50 px-4 py-2 text-sm print:hidden">
        <div className="flex items-center gap-3">
          <Link
            href={`/master/contract-templates/${row.id}`}
            className="inline-flex items-center gap-1 text-amber-800 hover:text-amber-900"
          >
            <ArrowLeft size={14} /> 編集画面へ戻る
          </Link>
          <span className="font-mono text-xs text-amber-800">
            {row.kind} v{row.version_no} プレビュー
          </span>
          {category && (
            <span className="rounded bg-white px-2 py-0.5 text-xs text-sky-700 ring-1 ring-sky-200">
              {category}
            </span>
          )}
        </div>
        <div className="text-xs text-amber-800">
          サンプル事業所 = {office?.name ?? "(該当なし)"} / 利用者 = ダミー
        </div>
      </div>

      <CombinedContractView
        contract={dummyContract}
        user={dummyUser}
        officeName={office?.name ?? null}
        office={office}
        company={company}
        templateContent={row.content ?? {}}
      />
    </div>
  );
}
