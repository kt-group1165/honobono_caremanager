import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { KEIYAKU_KEN_JUYO_SECTIONS } from "@/lib/user-contract/types";
import { OverrideEditor } from "./_override-editor";

/**
 * /master/contract-templates/office-overrides/[officeId]
 *  = 事業所ごとの契約書 override 編集
 *
 * key 群:
 *   - juyo_* (別紙全 key)
 *   - 事業者系 (company_office_name / phone / fax 等) は offices 列側で管理されるので除外
 */
export default async function OfficeOverrideEditPage({
  params,
}: {
  params: Promise<{ officeId: string }>;
}) {
  const { officeId } = await params;
  const supabase = await createClient();

  const { data: office, error } = await supabase
    .from("offices")
    .select("id, name, service_type, contract_overrides")
    .eq("id", officeId)
    .maybeSingle();
  if (error) {
    return (
      <div className="p-6 text-sm text-red-600">読取失敗: {error.message}</div>
    );
  }
  if (!office) notFound();

  // 現在有効な template (v1 想定)
  const { data: tpl } = await supabase
    .from("kaigo_contract_templates")
    .select("content, version_no")
    .eq("kind", "契約書兼重要事項説明書")
    .eq("is_active", true)
    .maybeSingle();
  const templateContent: Record<string, string> =
    (tpl?.content as Record<string, string>) ?? {};

  // 事業所単位で override 可能な key = juyo_* 全部 (事業者系は除外)
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
  const editableSections = KEIYAKU_KEN_JUYO_SECTIONS.filter(
    (s) =>
      !AUTO_FILLED_KEYS.has(s.key) &&
      !s.key.startsWith("article_") &&
      s.key !== "preamble_text" &&
      s.key !== "closing_text" &&
      s.key !== "privacy_consent_text",
  ).map((s) => ({
    key: s.key,
    label: s.label,
    templateValue: templateContent[s.key] ?? "",
  }));

  const overrides =
    (office.contract_overrides as Record<string, string> | null) ?? {};

  return (
    <div className="space-y-4 p-4">
      <div>
        <Link
          href="/master/contract-templates/office-overrides"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={16} /> 事業所一覧へ戻る
        </Link>
      </div>

      <div className="rounded border bg-white p-4 shadow-sm">
        <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
          <Building2 size={18} /> {office.name}
        </h1>
        <p className="mt-1 text-xs text-gray-500">
          カテゴリ: {office.service_type} / 適用 template: v{tpl?.version_no ?? "?"}
        </p>
        <p className="mt-2 text-xs text-gray-500">
          空欄のままの key は「テンプレを使用」となります。値を入れた key だけがこの事業所の
          契約書で上書きされます。「テンプレの値」は参考として下に表示されます。
        </p>
      </div>

      <OverrideEditor
        officeId={officeId}
        initialOverrides={overrides}
        sections={editableSections}
      />
    </div>
  );
}
