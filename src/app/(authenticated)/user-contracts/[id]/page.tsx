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

/**
 * 西暦 → 和暦 (令和/平成/昭和) 変換 (= docx の「令和 年 月 日」表記に合わせる)
 *
 * - 2019-05-01 以降 → 令和 (y - 2018)
 * - 1989-01-08〜2019-04-30 → 平成 (y - 1988)
 * - それ以前 → 昭和 (y - 1925) ※ 安全側、実際は使われない想定
 */
function fmtWareki(s: string | null): {
  era: string;
  year: number | "";
  month: number | "";
  day: number | "";
} {
  if (!s) return { era: "令和", year: "", month: "", day: "" };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return { era: "令和", year: "", month: "", day: "" };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  let era = "令和";
  let yy = y - 2018;
  if (y < 2019 || (y === 2019 && mo < 5)) {
    era = "平成";
    yy = y - 1988;
  }
  if (y < 1989 || (y === 1989 && mo === 1 && d < 8)) {
    era = "昭和";
    yy = y - 1925;
  }
  return { era, year: yy, month: mo, day: d };
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
 * 「契約書兼重要事項説明書」専用 view (= docx に忠実な A4 縦レイアウト)
 *
 * 元 docx: `apps/kaigo-app/契約書/居宅介護支援/26.6月 契約書原本(大網）.docx`
 *
 * docx 構造 (= 抽出元):
 *   - A4 縦, 余白 上 1134 / 下 851 / 左右 1701 twip (≒ 20mm/15mm/30mm)
 *   - font: ＭＳ 明朝 (eastAsia 設定済)
 *   - 半角ポイント (sz/2):
 *       cover タイトル "居宅介護支援" 36pt / "契約書"・"重要事項説明書" 26pt
 *       cover 利用者欄 "      様"   28pt
 *       cover 事業者名               20pt
 *       本文タイトル "居宅介護支援 契約書 / 兼 / …" 14pt bold
 *       別紙重要事項のタイトル/見出し 12pt
 *       条文本文 / 別紙本文           11pt
 *
 * - p.1   表紙 (居宅介護支援 / 契約書 / 兼 / 重要事項説明書 / 利用者 様 / 事業者名)
 * - p.2〜 契約書本文 (第1〜22条 + 個人情報の取り扱いについて)
 * - p.4〜 別紙「重要事項」(1 相談窓口 〜 8 当社の概要)
 * - 末尾   署名欄 (説明日 / 説明者 / 契約締結日 / 事業者 / 利用者 / 代筆者)
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
  // 条見出しは docx に合わせ "第○条（…）" の全角丸括弧表記に揃える
  const renderArticleHeading = (key: string): string => {
    const raw = articleLabels[key] ?? key;
    // "第1条 (契約の目的)" → "第１条（契約の目的）"
    const numMap: Record<string, string> = {
      "1": "１",
      "2": "２",
      "3": "３",
      "4": "４",
      "5": "５",
      "6": "６",
      "7": "７",
      "8": "８",
      "9": "９",
      "10": "１０",
      "11": "１１",
      "12": "１２",
      "13": "１３",
      "14": "１４",
      "15": "１５",
      "16": "１６",
      "17": "１７",
      "18": "１８",
      "19": "１９",
      "20": "２０",
      "21": "２１",
      "22": "２２",
    };
    const m = /^第(\d+)条\s*\((.+)\)$/.exec(raw);
    if (!m) return raw;
    const z = numMap[m[1]] ?? m[1];
    return `第${z}条（${m[2]}）`;
  };

  const juyoSections = KEIYAKU_KEN_JUYO_SECTIONS.filter((s) => s.key.startsWith("juyo_"));
  const juyoTitle = (sec: { key: string; label: string }, idx: number): string => {
    // "別紙1 当事業所が提供する..." → "１ 当事業所が提供する..."
    const stripped = sec.label.replace(/^別紙\d+\s*/, "");
    const zen = "１２３４５６７８"[idx] ?? String(idx + 1);
    return `${zen}　${stripped}`;
  };

  const companyOfficeName = c("company_office_name") || officeName || "";
  const companyName = c("company_name") || "";
  const companyAddress = c("company_address") || "";
  const companyPhone = c("company_phone") || "";
  const representativeName = c("representative_name") || "";
  const officeDesignationNumber = c("office_designation_number") || "";
  const officeServiceArea = c("office_service_area") || "";

  const issuedW = fmtWareki(contract.issued_date);
  const signedW = fmtWareki(contract.signed_at ?? contract.issued_date);

  return (
    <>
      {/* 印刷用 style (= docx 余白を A4 で再現) */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 20mm 30mm 15mm 30mm; }
          html, body { background: #fff !important; }
          .uc-sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; max-width: none !important; }
          .uc-page { page-break-after: always; }
          .uc-page:last-child { page-break-after: auto; }
          .uc-avoid { page-break-inside: avoid; }
        }
        .uc-sheet {
          font-family: "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Hiragino Mincho Pro",
                       "MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif;
          color: #111;
          font-size: 11pt;
          line-height: 1.8;
          font-feature-settings: "palt" 1;
        }
        .uc-sheet table { border-collapse: collapse; width: 100%; }
        .uc-sheet td, .uc-sheet th {
          border: 1px solid #000;
          padding: 4px 8px;
          vertical-align: middle;
          font-size: 10.5pt;
          line-height: 1.6;
        }
      `}</style>

      {/* 画面用 wrapper: A4 比率に近い max-width / 印刷時は uc-sheet 内に展開 */}
      <div
        className="uc-sheet mx-auto my-6 bg-white shadow-sm print:my-0 print:shadow-none"
        style={{ maxWidth: "210mm" }}
      >
        {/* ===== Page 1: 表紙 ===== */}
        <section
          className="uc-page relative px-[30mm] py-[20mm]"
          style={{ minHeight: "297mm" }}
        >
          {/* 居宅介護支援 (36pt) — docx で center, 上 ⅓ 付近 */}
          <div className="pt-[24mm] text-center" style={{ fontSize: "36pt", letterSpacing: "0.5em" }}>
            居宅介護支援
          </div>
          {/* 契約書 (26pt) */}
          <div className="mt-[16mm] text-center" style={{ fontSize: "26pt", letterSpacing: "0.4em" }}>
            契約書
          </div>
          {/* 重要事項説明書 (26pt) */}
          <div className="mt-[6mm] text-center" style={{ fontSize: "26pt", letterSpacing: "0.4em" }}>
            重要事項説明書
          </div>

          {/* 利用者欄 (28pt) — docx は 9個の全角空白 + 様 */}
          <div className="mt-[40mm] text-center" style={{ fontSize: "28pt" }}>
            <span
              className="inline-block border-b border-black pb-1 text-left"
              style={{ minWidth: "160mm" }}
            >
              <span style={{ paddingLeft: "20mm" }}>{user?.name ?? ""}</span>
            </span>
            <span className="ml-2">様</span>
          </div>

          {/* 事業者名・事業所名 (20pt) — center */}
          <div className="mt-[40mm] text-center" style={{ fontSize: "20pt" }}>
            {companyName || "　"}
          </div>
          <div className="mt-[4mm] text-center" style={{ fontSize: "20pt" }}>
            {companyOfficeName || "　"}
          </div>
        </section>

        {/* ===== Page 2〜: 契約書本文 ===== */}
        <section className="uc-page px-[30mm] py-[18mm]">
          {/* タイトル (14pt bold) — center */}
          <div
            className="text-center font-bold"
            style={{ fontSize: "14pt", lineHeight: 1.9 }}
          >
            居宅介護支援　契約書
          </div>
          <div
            className="text-center font-bold"
            style={{ fontSize: "14pt", lineHeight: 1.9 }}
          >
            兼
          </div>
          <div
            className="text-center font-bold"
            style={{ fontSize: "14pt", lineHeight: 1.9 }}
          >
            居宅介護支援　重要事項説明書
          </div>

          {/* 日付行 (右寄せ気味、docx は ind_firstLine=1680) */}
          <div className="mt-2" style={{ paddingLeft: "60mm", fontSize: "12pt" }}>
            （　　{issuedW.year || "　　"}　年　　{issuedW.month || "　　"}　月
            {issuedW.day || "　　"}　日　現在　）
          </div>

          {/* 前文 (利用者…事業者…契約します。) */}
          <p className="mt-6" style={{ textIndent: "1em" }}>
            <span className="inline-block border-b border-black" style={{ minWidth: "8em" }}>
              {user?.name ?? "　　　　　　　"}
            </span>
            様（以下、「利用者」といいます）と、
            {companyName ? <strong>{companyName}</strong> : "　"}

            {companyOfficeName ? <strong>{companyOfficeName}</strong> : "　"}
            （以下、「事業者」といいます）は、事業者が利用者に対して行う居宅介護支援について次の通り契約します。
          </p>

          {/* 第1〜22条 */}
          <div className="mt-6 space-y-4">
            {articleKeys.map((key) => {
              const body = c(key);
              if (!body.trim()) return null;
              return (
                <article key={key} className="uc-avoid">
                  <h3 className="font-bold" style={{ fontSize: "11pt" }}>
                    {renderArticleHeading(key)}
                  </h3>
                  <p
                    className="whitespace-pre-wrap"
                    style={{ textIndent: "1em", marginTop: "0.2em" }}
                  >
                    {body}
                  </p>
                </article>
              );
            })}
          </div>

          {/* 個人情報の取り扱いについて */}
          {c("privacy_consent_text").trim() && (
            <section className="mt-8 uc-avoid">
              <h3 className="font-bold" style={{ fontSize: "11pt" }}>
                【個人情報の取り扱いについて】
              </h3>
              <p
                className="whitespace-pre-wrap"
                style={{ textIndent: "1em", marginTop: "0.2em" }}
              >
                {c("privacy_consent_text")}
              </p>
              <p className="mt-4" style={{ textIndent: "1em" }}>
                上記の契約を証するため本書２通を作成し、利用者・事業者が署名押印の上、１通ずつ保有するものとします。
              </p>
            </section>
          )}
        </section>

        {/* ===== Page N: 別紙「重要事項」 ===== */}
        <section className="uc-page px-[30mm] py-[18mm]">
          {/* 中央タイトル (12pt bold) */}
          <div
            className="text-center font-bold"
            style={{ fontSize: "12pt", letterSpacing: "0.6em", paddingTop: "60mm" }}
          >
            重要事項
          </div>
          <div style={{ pageBreakAfter: "always" }} />

          {juyoSections.map((sec, idx) => {
            const body = c(sec.key);
            if (!body.trim()) return null;
            const isFirstSection = idx === 0;
            return (
              <section
                key={sec.key}
                className="uc-avoid"
                style={{ marginTop: isFirstSection ? "0" : "1.5em" }}
              >
                <h3 className="font-bold" style={{ fontSize: "12pt", marginBottom: "0.4em" }}>
                  {juyoTitle(sec, idx)}
                </h3>

                {/* idx=1 (= juyo_02 当事業所の概要) では事業所情報の表 を追加表示 */}
                {idx === 1 && (
                  <>
                    <p className="mt-2">・居宅介護支援事業所の名称、所在地、指定番号、サービスを提供できる地域</p>
                    <table className="mt-1">
                      <tbody>
                        <tr>
                          <th
                            className="text-center"
                            style={{ width: "35%", background: "#f5f5f5" }}
                          >
                            事　業　所　名
                          </th>
                          <td>{companyOfficeName || "　"}</td>
                        </tr>
                        <tr>
                          <th
                            className="text-center"
                            style={{ background: "#f5f5f5" }}
                          >
                            所　在　地
                          </th>
                          <td>{companyAddress || "　"}</td>
                        </tr>
                        <tr>
                          <th
                            className="text-center"
                            style={{ background: "#f5f5f5" }}
                          >
                            介護保険 指定事業所番号
                          </th>
                          <td>{officeDesignationNumber || "　"}</td>
                        </tr>
                        <tr>
                          <th
                            className="text-center"
                            style={{ background: "#f5f5f5" }}
                          >
                            通常のサービス実施地域
                          </th>
                          <td className="whitespace-pre-wrap">
                            {officeServiceArea || "　"}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </>
                )}

                <p className="whitespace-pre-wrap" style={{ marginTop: "0.4em" }}>
                  {body}
                </p>
              </section>
            );
          })}
        </section>

        {/* ===== 末尾: 署名欄 ===== */}
        <section className="px-[30mm] py-[18mm]">
          <p style={{ textIndent: "1em" }}>
            事業者は居宅介護支援の提供開始にあたり、利用者様に対し本書面を用いて契約書及び重要事項、個人情報の取扱いについて説明しました。
          </p>

          {/* 説明日 (令和 _ 年 _ 月 _ 日) */}
          <div className="mt-6 uc-avoid">
            <div className="font-bold" style={{ fontSize: "11pt" }}>
              説明日　　　　　{signedW.era}
              <span className="inline-block border-b border-black text-center" style={{ minWidth: "3em" }}>
                {signedW.year || "　　"}
              </span>
              　年
              <span className="inline-block border-b border-black text-center" style={{ minWidth: "3em" }}>
                {signedW.month || "　　"}
              </span>
              　月
              <span className="inline-block border-b border-black text-center" style={{ minWidth: "3em" }}>
                {signedW.day || "　　"}
              </span>
              　日
            </div>
            <div className="mt-3 flex items-end gap-4">
              <span className="font-bold" style={{ fontSize: "11pt" }}>【 説明者 】</span>
              <span className="flex-1 border-b border-black" />
              <span style={{ fontSize: "10pt" }}>印</span>
            </div>
            <div className="mt-4 font-bold" style={{ fontSize: "11pt" }}>
              契約締結日　　　{signedW.era}
              <span className="inline-block border-b border-black text-center" style={{ minWidth: "3em" }}>
                {signedW.year || "　　"}
              </span>
              　年
              <span className="inline-block border-b border-black text-center" style={{ minWidth: "3em" }}>
                {signedW.month || "　　"}
              </span>
              　月
              <span className="inline-block border-b border-black text-center" style={{ minWidth: "3em" }}>
                {signedW.day || "　　"}
              </span>
              　日
            </div>
          </div>

          {/* 事業者欄 */}
          <div className="mt-6 uc-avoid">
            <p className="font-bold" style={{ fontSize: "11pt" }}>事業者</p>
            <div className="mt-2 space-y-2 pl-[6mm]">
              <div className="flex">
                <span className="font-bold" style={{ width: "30mm", fontSize: "11pt" }}>
                  【事業者名】
                </span>
                <span className="flex-1">
                  {companyName}
                  {companyOfficeName && (
                    <>
                      <br />
                      <span className="inline-block pl-[8mm]">{companyOfficeName}</span>
                    </>
                  )}
                </span>
              </div>
              <div className="flex">
                <span className="font-bold" style={{ width: "30mm", fontSize: "11pt" }}>
                  【 所在地 】
                </span>
                <span className="flex-1">{companyAddress}</span>
              </div>
              {companyPhone && (
                <div className="flex">
                  <span className="font-bold" style={{ width: "30mm", fontSize: "11pt" }}>
                    【 電話番号 】
                  </span>
                  <span className="flex-1">{companyPhone}</span>
                </div>
              )}
              <div className="flex items-end">
                <span className="font-bold" style={{ width: "30mm", fontSize: "11pt" }}>
                  【 法人代表者 】
                </span>
                <span className="flex-1 border-b border-black pb-0.5">{representativeName}</span>
                <span className="ml-2" style={{ fontSize: "10pt" }}>印</span>
              </div>
            </div>
          </div>

          {/* 利用者同意文 + 利用者欄 */}
          <p className="mt-6" style={{ textIndent: "1em" }}>
            利用者は本書面により、事業者から居宅介護支援について契約書、重要事項、個人情報の取扱いについて、内容の説明を受け確認した上で、契約書記載の各条項及び重要事項説明書、個人情報の取扱いに記載されている内容につき同意します。また、事業者が「居宅サービス計画」を作成する為に必要がある時は、要介護認定にかかる調査内容・介護認定審査会による判定結果、意見・主治医意見書を閲覧することに同意します。
          </p>

          <div className="mt-4 uc-avoid">
            <p className="font-bold" style={{ fontSize: "11pt" }}>利用者</p>
            <div className="mt-2 space-y-2 pl-[6mm]">
              <div className="flex items-end">
                <span className="font-bold" style={{ width: "24mm", fontSize: "11pt" }}>
                  【 住所 】
                </span>
                <span className="flex-1 border-b border-black">&nbsp;</span>
              </div>
              <div className="flex items-end">
                <span className="font-bold" style={{ width: "24mm", fontSize: "11pt" }}>
                  【 氏名 】
                </span>
                <span className="flex-1 border-b border-black pb-0.5">
                  {contract.signed_by_relation === "本人"
                    ? contract.signed_by_name ?? user?.name ?? ""
                    : user?.name ?? ""}
                </span>
                <span className="ml-2" style={{ fontSize: "10pt" }}>印</span>
              </div>
            </div>
          </div>

          {/* 代筆者欄 (= 本人以外で signed_by_relation がある場合) */}
          {contract.signed_by_relation && contract.signed_by_relation !== "本人" && (
            <div className="mt-6 uc-avoid">
              <p style={{ textIndent: "1em" }}>
                利用者は心身の状況等により署名ができないため、利用者本人の意思を確認の上、私が利用者に代わってその署名を代筆しました。
              </p>
              <div className="mt-3 pl-[6mm]">
                <p className="font-bold" style={{ fontSize: "11pt" }}>
                  代筆者　　　　　　　　　　　　　　　（続柄：{contract.signed_by_relation}）
                </p>
                <div className="mt-2 space-y-2">
                  <div className="flex items-end">
                    <span className="font-bold" style={{ width: "24mm", fontSize: "11pt" }}>
                      【 住所 】
                    </span>
                    <span className="flex-1 border-b border-black">&nbsp;</span>
                  </div>
                  <div className="flex items-end">
                    <span className="font-bold" style={{ width: "24mm", fontSize: "11pt" }}>
                      【 氏名 】
                    </span>
                    <span className="flex-1 border-b border-black pb-0.5">
                      {contract.signed_by_name ?? ""}
                    </span>
                    <span className="ml-2" style={{ fontSize: "10pt" }}>印</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* 備考・添付は印刷非表示 */}
        {contract.notes && (
          <section className="mx-[30mm] mb-6 border-t pt-3 print:hidden">
            <h2 className="text-xs font-semibold text-gray-500">備考 (印刷非表示)</h2>
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{contract.notes}</p>
          </section>
        )}

        {contract.attachment_url && (
          <p className="mx-[30mm] mb-6 text-xs text-gray-500 print:hidden">
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
    </>
  );
}
