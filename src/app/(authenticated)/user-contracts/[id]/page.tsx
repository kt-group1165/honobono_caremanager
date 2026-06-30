import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  CONTRACT_STATUS_LABELS,
  getSectionsForType,
  KEIYAKU_KEN_JUYO_SECTIONS,
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

  // 契約書兼重要事項説明書 は docx 由来の縦組み専用レイアウトを使う
  const isCombinedContract = contract.contract_type === "契約書兼重要事項説明書";

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

      {isCombinedContract ? (
        <CombinedContractView contract={contract} user={user} officeName={officeName} />
      ) : (
        <GenericContractView
          contract={contract}
          user={user}
          officeName={officeName}
          sections={sections}
        />
      )}
    </div>
  );
}

/**
 * 既存 4 種類 (= 重要事項説明書 / 契約書 / 個人情報同意書 / その他) 用 view (= 後方互換)
 */
function GenericContractView({
  contract,
  user,
  officeName,
  sections,
}: {
  contract: UserContract;
  user: KaigoClientLite | null;
  officeName: string | null;
  sections: ReturnType<typeof getSectionsForType>;
}) {
  return (
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
  );
}

/**
 * 「契約書兼重要事項説明書」専用 view (= docx の縦組みを踏襲した A4 縦レイアウト)
 *
 * - 表紙: 標題 + 利用者欄 + 事業者欄
 * - 第1〜22条 (article_01 〜 article_22) を順次表示
 * - 個人情報の取り扱いについて
 * - 別紙重要事項 1〜8 章
 * - 末尾: 説明日 / 契約締結日 / 事業者署名欄 / 利用者署名欄 / 代筆者署名欄
 */
function CombinedContractView({
  contract,
  user,
  officeName,
}: {
  contract: UserContract;
  user: KaigoClientLite | null;
  officeName: string | null;
}) {
  const c = (key: string): string => (contract.content?.[key] ?? "").toString();

  const articleKeys = Array.from({ length: 22 }, (_, i) =>
    `article_${String(i + 1).padStart(2, "0")}`,
  );
  const articleLabels: Record<string, string> = Object.fromEntries(
    KEIYAKU_KEN_JUYO_SECTIONS.filter((s) => s.key.startsWith("article_")).map((s) => [
      s.key,
      s.label,
    ]),
  );
  const juyoSections = KEIYAKU_KEN_JUYO_SECTIONS.filter((s) => s.key.startsWith("juyo_"));

  const companyOfficeName = c("company_office_name") || officeName || "—";
  const companyName = c("company_name") || "—";
  const companyAddress = c("company_address") || "—";
  const representativeName = c("representative_name") || "—";

  return (
    <div className="mx-auto my-6 max-w-3xl bg-white p-10 text-[13px] leading-relaxed text-gray-900 shadow-sm print:my-0 print:max-w-none print:p-12 print:shadow-none">
      {/* 表紙 */}
      <header className="text-center">
        <p className="text-xs text-gray-600">居宅介護支援</p>
        <h1 className="mt-2 text-3xl font-bold tracking-[0.4em]">契約書</h1>
        <p className="my-1 text-sm text-gray-700">兼</p>
        <h2 className="text-2xl font-bold tracking-[0.4em]">重要事項説明書</h2>
        <p className="mt-4 text-xs text-gray-600">
          ({fmtDate(contract.issued_date)} 現在)
        </p>
      </header>

      {/* 利用者・事業者 */}
      <section className="mt-8 space-y-3 text-sm">
        <div className="flex items-end gap-3 border-b border-gray-300 pb-1">
          <span className="text-xs text-gray-500">利用者氏名</span>
          <span className="flex-1 text-lg font-semibold">{user?.name ?? "—"}</span>
          <span className="text-sm">様</span>
        </div>
        <div className="text-xs leading-loose text-gray-700">
          <span className="font-semibold text-gray-900">{companyName}</span>
          <br />
          <span className="font-semibold text-gray-900">{companyOfficeName}</span>
          <br />
          (以下、「利用者」といいます) と、{companyName}{" "}
          {companyOfficeName} (以下、「事業者」といいます) は、事業者が利用者に対して行う居宅介護支援について次の通り契約します。
        </div>
      </section>

      {/* 契約条文 (第1〜22条) */}
      <section className="mt-6 space-y-4">
        {articleKeys.map((key) => {
          const body = c(key);
          if (!body.trim()) return null;
          return (
            <article key={key} className="break-inside-avoid">
              <h3 className="text-sm font-bold text-gray-900">
                {articleLabels[key] ?? key}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-7 text-gray-800">
                {body}
              </p>
            </article>
          );
        })}
      </section>

      {/* 個人情報取扱い */}
      {c("privacy_consent_text").trim() && (
        <section className="mt-8 break-inside-avoid border-t border-gray-300 pt-4">
          <h3 className="text-sm font-bold text-gray-900">【個人情報の取り扱いについて】</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-7 text-gray-800">
            {c("privacy_consent_text")}
          </p>
          <p className="mt-3 text-sm leading-7 text-gray-800">
            上記の契約を証するため本書2通を作成し、利用者・事業者が署名押印の上、1通ずつ保有するものとします。
          </p>
        </section>
      )}

      {/* 改頁: 別紙重要事項 */}
      <div className="mt-12 break-before-page">
        <header className="text-center">
          <h2 className="text-2xl font-bold tracking-[0.4em]">重要事項</h2>
        </header>

        {juyoSections.map((sec, idx) => {
          const body = c(sec.key);
          if (!body.trim()) return null;
          return (
            <section key={sec.key} className="mt-6 break-inside-avoid">
              <h3 className="border-b border-gray-400 pb-1 text-sm font-bold text-gray-900">
                {idx + 1} {sec.label.replace(/^別紙\d+\s*/, "")}
              </h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-gray-800">
                {body}
              </p>
            </section>
          );
        })}
      </div>

      {/* 末尾 署名欄 */}
      <section className="mt-12 break-inside-avoid border-t-2 border-gray-700 pt-6 text-sm">
        <p className="leading-7 text-gray-800">
          事業者は居宅介護支援の提供開始にあたり、利用者様に対し本書面を用いて契約書及び重要事項、個人情報の取扱いについて説明しました。
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3">
          <div className="flex items-end gap-3 border-b border-gray-400 pb-1">
            <span className="w-24 text-xs text-gray-500">説明日</span>
            <span className="flex-1">{fmtDate(contract.issued_date)}</span>
          </div>
          <div className="flex items-end gap-3 border-b border-gray-400 pb-1">
            <span className="w-24 text-xs text-gray-500">【 説明者 】</span>
            <span className="flex-1" />
            <span className="text-xs text-gray-500">印</span>
          </div>
          <div className="flex items-end gap-3 border-b border-gray-400 pb-1">
            <span className="w-24 text-xs text-gray-500">契約締結日</span>
            <span className="flex-1">
              {fmtDate(contract.signed_at ?? contract.issued_date)}
            </span>
          </div>
        </div>

        {/* 事業者署名 */}
        <div className="mt-6 rounded border border-gray-300 p-4">
          <p className="text-xs font-semibold text-gray-600">事業者</p>
          <div className="mt-2 space-y-2">
            <div className="flex">
              <span className="w-32 text-xs text-gray-500">【事業者名】</span>
              <span className="flex-1">
                {companyName}
                <br />
                {companyOfficeName}
              </span>
            </div>
            <div className="flex">
              <span className="w-32 text-xs text-gray-500">【 所在地 】</span>
              <span className="flex-1">{companyAddress}</span>
            </div>
            <div className="flex items-end">
              <span className="w-32 text-xs text-gray-500">【 法人代表者 】</span>
              <span className="flex-1 border-b border-gray-400">
                {representativeName}
              </span>
              <span className="ml-2 text-xs text-gray-500">印</span>
            </div>
          </div>
        </div>

        <p className="mt-6 text-sm leading-7 text-gray-800">
          利用者は本書面により、事業者から居宅介護支援について契約書、重要事項、個人情報の取扱いについて、内容の説明を受け確認した上で、契約書記載の各条項及び重要事項説明書、個人情報の取扱いに記載されている内容につき同意します。また、事業者が「居宅サービス計画」を作成する為に必要がある時は、要介護認定にかかる調査内容・介護認定審査会による判定結果、意見・主治医意見書を閲覧することに同意します。
        </p>

        {/* 利用者署名 */}
        <div className="mt-6 rounded border border-gray-300 p-4">
          <p className="text-xs font-semibold text-gray-600">利用者</p>
          <div className="mt-2 space-y-2">
            <div className="flex">
              <span className="w-24 text-xs text-gray-500">【 住所 】</span>
              <span className="flex-1 border-b border-gray-400">&nbsp;</span>
            </div>
            <div className="flex items-end">
              <span className="w-24 text-xs text-gray-500">【 氏名 】</span>
              <span className="flex-1 border-b border-gray-400">
                {contract.signed_by_relation === "本人"
                  ? contract.signed_by_name ?? ""
                  : user?.name ?? ""}
              </span>
              <span className="ml-2 text-xs text-gray-500">印</span>
            </div>
          </div>
        </div>

        {/* 代筆者 (= signed_by_relation が「本人」以外なら表示) */}
        {contract.signed_by_relation && contract.signed_by_relation !== "本人" && (
          <div className="mt-4 rounded border border-gray-300 p-4">
            <p className="text-xs leading-6 text-gray-700">
              利用者は心身の状況等により署名ができないため、利用者本人の意思を確認の上、私が利用者に代わってその署名を代筆しました。
            </p>
            <div className="mt-3 space-y-2">
              <div className="flex items-end">
                <span className="w-24 text-xs text-gray-500">代筆者</span>
                <span className="flex-1 border-b border-gray-400">
                  {contract.signed_by_name ?? ""}
                </span>
                <span className="ml-2 text-xs text-gray-500">
                  (続柄: {contract.signed_by_relation})
                </span>
              </div>
              <div className="flex">
                <span className="w-24 text-xs text-gray-500">【 住所 】</span>
                <span className="flex-1 border-b border-gray-400">&nbsp;</span>
              </div>
              <div className="flex items-end">
                <span className="w-24 text-xs text-gray-500">【 氏名 】</span>
                <span className="flex-1 border-b border-gray-400">&nbsp;</span>
                <span className="ml-2 text-xs text-gray-500">印</span>
              </div>
            </div>
          </div>
        )}
      </section>

      {contract.notes && (
        <section className="mt-6 border-t pt-3 print:hidden">
          <h2 className="text-xs font-semibold text-gray-500">備考 (印刷非表示)</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{contract.notes}</p>
        </section>
      )}

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
  );
}
