import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  CONTRACT_STATUS_LABELS,
  getSectionsForType,
  getKeiyakuKenJuyoDefaults,
  KEIYAKU_KEN_JUYO_SECTIONS,
  type UserContract,
} from "@/lib/user-contract/types";
import { ContractPrintActions } from "./print-actions";

export interface OfficeLite {
  id: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  fax: string | null;
  business_number: string | null;
  representative_name: string | null;
  manager_name: string | null;
  postal_code: string | null;
  company_id: string | null;
}

export interface CompanyLite {
  id: string;
  name: string | null;
  short_name: string | null;
  address: string | null;
  phone: string | null;
  fax: string | null;
  representative_name: string | null;
  postal_code: string | null;
}

export interface KaigoClientLite {
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

  // office 情報 + 法人 (companies) を join fetch
  // = 契約書上の事業者欄 (法人名 / 事業所名 / 住所 / 電話 / 事業者番号 / 代表者) は
  //   ここから動的に埋める (= content の hard-code に依存しない)
  let officeRow: OfficeLite | null = null;
  let companyRow: CompanyLite | null = null;
  if (contract.office_id) {
    const { data: o } = await supabase
      .from("offices")
      .select(
        "id, name, address, phone, fax, business_number, representative_name, manager_name, postal_code, company_id",
      )
      .eq("id", contract.office_id)
      .maybeSingle();
    officeRow = (o as OfficeLite | null) ?? null;
    if (officeRow?.company_id) {
      const { data: co } = await supabase
        .from("companies")
        .select("id, name, short_name, address, phone, fax, representative_name, postal_code")
        .eq("id", officeRow.company_id)
        .maybeSingle();
      companyRow = (co as CompanyLite | null) ?? null;
    }
  }
  const officeName = officeRow?.name ?? null;

  // template 版 (= 契約書フォーマット) の content を fallback として取得
  // - contract.template_version_no があればその版
  // - なければ is_active=true な版
  // - どちらも無ければ空 (=defaults に依存)
  let templateContent: Record<string, string> = {};
  {
    let q = supabase
      .from("kaigo_contract_templates")
      .select("content")
      .eq("kind", contract.contract_type)
      .limit(1);
    const ver = (contract as unknown as { template_version_no?: number | null })
      .template_version_no;
    if (typeof ver === "number") {
      q = q.eq("version_no", ver);
    } else {
      q = q.eq("is_active", true);
    }
    const { data: tpl } = await q.maybeSingle();
    if (tpl && (tpl as { content?: Record<string, string> }).content) {
      templateContent = (tpl as { content: Record<string, string> }).content;
    }
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
        <CombinedContractView
          contract={contract}
          user={user}
          officeName={officeName}
          office={officeRow}
          company={companyRow}
          templateContent={templateContent}
        />
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
export function CombinedContractView({
  contract,
  user,
  officeName,
  office,
  company,
  templateContent,
}: {
  contract: UserContract;
  user: KaigoClientLite | null;
  officeName: string | null;
  office: OfficeLite | null;
  company: CompanyLite | null;
  templateContent: Record<string, string>;
}) {
  // 参照優先順位:
  //   1) contract.content (= 締結時点 snapshot)
  //   2) template (= kaigo_contract_templates の有効版 or 締結時点版)
  //   3) types.ts の getKeiyakuKenJuyoDefaults() (= 最終 fallback / 移行期の互換)
  const defaultsForFallback = getKeiyakuKenJuyoDefaults();
  const c = (key: string): string => {
    const raw = contract.content?.[key];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") return String(raw);
    const tpl = templateContent[key];
    if (tpl !== undefined && tpl !== null && String(tpl).trim() !== "") return String(tpl);
    return (defaultsForFallback[key] ?? "").toString();
  };

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

  // 別紙重要事項 8 章: docx 章単位に grouping (= 章ごと見出し + 章内小見出し)
  // 数字は全角に揃える ("１ 当事業所が提供する〜")
  type JuyoSubsection = { key: string; subheading?: string };
  type JuyoChapter = { title: string; subs: JuyoSubsection[] };
  const juyoChapters: JuyoChapter[] = [
    {
      title: "１　当事業所が提供する居宅介護支援サービスについての相談窓口",
      subs: [{ key: "juyo_01_contact" }],
    },
    {
      title: "２　当事業所の概要",
      subs: [
        { key: "juyo_02_overview_intro" },
        { key: "juyo_02_staff_table_note", subheading: "当事業所の職員体制" },
        { key: "juyo_02_hours_note", subheading: "営業日及び営業時間" },
        // 後方互換: 旧 1 key 版が残っていれば末尾に表示
        { key: "juyo_02_overview" },
      ],
    },
    {
      title: "３　居宅介護支援の申し込みからサービス提供までの流れと主な内容",
      subs: [{ key: "juyo_03_flow" }],
    },
    {
      title: "４　利用料金",
      subs: [
        { key: "juyo_04_fee_intro", subheading: "利用料" },
        { key: "juyo_04_fee_table_note" },
        { key: "juyo_04_fee_shoguu", subheading: "介護職員等処遇改善加算" },
        { key: "juyo_04_fee_transport", subheading: "交通費" },
        { key: "juyo_04_fee_other", subheading: "その他" },
        { key: "juyo_04_fee_payment", subheading: "支払方法" },
        { key: "juyo_04_fee" }, // 後方互換
      ],
    },
    {
      title: "５　サービスの利用方法",
      subs: [
        { key: "juyo_05_usage_start", subheading: "サービスの利用開始" },
        { key: "juyo_05_usage_end_user", subheading: "お客様のご都合でサービスを終了する場合" },
        { key: "juyo_05_usage_end_office", subheading: "当事業所の都合でサービスを終了する場合" },
        { key: "juyo_05_usage_auto_end", subheading: "自動終了" },
        { key: "juyo_05_usage_other_end", subheading: "その他" },
        { key: "juyo_05_usage" }, // 後方互換
      ],
    },
    {
      title: "６　当事業所の居宅介護支援の特徴等",
      subs: [
        { key: "juyo_06_policy", subheading: "運営の方針" },
        { key: "juyo_06_assessment", subheading: "課題分析票" },
        { key: "juyo_06_explanation", subheading: "居宅サービス作成に係る説明・同意" },
        { key: "juyo_06_usage_ratio", subheading: "サービス利用割合" },
        { key: "juyo_06_monitoring", subheading: "モニタリング" },
        { key: "juyo_06_carekaigi", subheading: "地域ケア会議への協力" },
        { key: "juyo_06_jisshu", subheading: "新人介護支援専門員の実習協力" },
        { key: "juyo_06_medical", subheading: "医療機関との連携" },
        { key: "juyo_06_gyakutai", subheading: "虐待に関する措置" },
        { key: "juyo_06_kansensho", subheading: "感染症の発生及びまん延の防止に関する措置" },
        { key: "juyo_06_bcp", subheading: "非常時における業務継続に向けた取り組み" },
        { key: "juyo_06_kosoku", subheading: "身体的拘束に関する措置" },
        { key: "juyo_06_privacy", subheading: "個人情報の取扱いについて（秘密保持）" },
        { key: "juyo_06_incident", subheading: "事故発生時の対応" },
        { key: "juyo_06_other", subheading: "その他の重要事項" },
        { key: "juyo_06_features" }, // 後方互換
      ],
    },
    {
      title: "７　サービス内容に関する苦情",
      subs: [
        { key: "juyo_07_complaint_intro" },
        { key: "juyo_07_complaint_service" },
        { key: "juyo_07_complaint_office" },
        { key: "juyo_07_complaint_hq" },
        { key: "juyo_07_complaint_external" },
        { key: "juyo_07_complaint" }, // 後方互換
      ],
    },
    {
      title: "８　当社の概要",
      subs: [{ key: "juyo_08_company" }],
    },
  ];


  // 事業者情報は「offices + companies (= contract.office_id が指している事業所) が master」。
  // 今の要件では master 最優先 (= 事業所マスタを変えたら契約書表示も追従する)。
  // 旧 seed の hard-code (= content 側) は master が空のときの fallback だけに残す。
  const companyName = company?.name || c("company_name") || "";
  const companyOfficeName =
    office?.name || officeName || c("company_office_name") || "";
  const companyAddress =
    office?.address || company?.address || c("company_address") || "";
  const companyPhone =
    office?.phone || company?.phone || c("company_phone") || "";
  const representativeName =
    company?.representative_name || c("representative_name") || "";
  const officeDesignationNumber =
    office?.business_number || c("office_designation_number") || "";
  const officeServiceArea = c("office_service_area") || "";

  const issuedW = fmtWareki(contract.issued_date);
  const signedW = fmtWareki(contract.signed_at ?? contract.issued_date);

  return (
    <>
      {/* 印刷用 style (= docx 余白を A4 で再現) */}
      <style>{`
        /* 画面: 各 .uc-page を A4 1 枚の白カードとして個別表示 (= ページ境界が視認できる) */
        .uc-stage {
          background: #e5e7eb; /* slate-200 ぽいグレー */
          padding: 24px 0;
          min-height: 100vh;
        }
        .uc-sheet {
          font-family: "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Hiragino Mincho Pro",
                       "MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif;
          color: #111;
          font-size: 11pt;
          line-height: 1.8;
          font-feature-settings: "palt" 1;
        }
        .uc-page {
          width: 210mm;
          min-height: 297mm;
          background: #fff;
          box-shadow: 0 4px 16px rgba(0,0,0,0.12);
          margin: 0 auto 18mm auto;
          box-sizing: border-box;
          position: relative;
        }
        .uc-page:last-child { margin-bottom: 0; }
        .uc-sheet table { border-collapse: collapse; width: 100%; }
        .uc-sheet td, .uc-sheet th {
          border: 1px solid #000;
          padding: 4px 8px;
          vertical-align: middle;
          font-size: 10.5pt;
          line-height: 1.6;
        }

        @media print {
          @page { size: A4 portrait; margin: 20mm 30mm 15mm 30mm; }
          html, body { background: #fff !important; }
          .uc-stage { background: #fff !important; padding: 0 !important; min-height: 0 !important; }
          .uc-page {
            width: auto !important;
            min-height: 0 !important;
            box-shadow: none !important;
            margin: 0 !important;
            page-break-after: always;
          }
          .uc-page:last-child { page-break-after: auto; }
          .uc-avoid { page-break-inside: avoid; }
        }
      `}</style>

      {/* 画面用 stage: グレー背景 + 各 page を 1 枚ずつ白カード化 */}
      <div className="uc-stage">
      <div className="uc-sheet">
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

          {/* 利用者欄 (28pt) — docx 仕様: 1 paragraph で
              '　　　　　　　　　様' (全角空白 9 + 様) を center / underline=True / 28pt 1 行表示 */}
          <div className="mt-[40mm] text-center" style={{ fontSize: "28pt" }}>
            <span style={{ textDecoration: "underline", textUnderlineOffset: "6px" }}>
              {user?.name
                ? `　　　　${user.name}　　　　　様`
                : "　　　　　　　　　様"}
            </span>
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

          {juyoChapters.map((chapter, chapIdx) => {
            // 章全体が空 (= 全 subs が空) ならそもそも描画しない
            const hasAnyBody =
              chapter.subs.some((s) => c(s.key).trim().length > 0) ||
              chapter.title.startsWith("２") || // 別紙2 は事業所情報表があるため空でも描画
              chapter.title.startsWith("４"); // 別紙4 も料金表テーブルがあるため空でも描画
            if (!hasAnyBody) return null;
            return (
              <section
                key={chapter.title}
                className="uc-avoid"
                style={{ marginTop: chapIdx === 0 ? "0" : "1.5em" }}
              >
                <h3 className="font-bold" style={{ fontSize: "12pt", marginBottom: "0.4em" }}>
                  {chapter.title}
                </h3>

                {/* 別紙2 (= "２　当事業所の概要") では事業所情報・職員体制・営業時間 の 3 表を追加表示 */}
                {chapter.title.startsWith("２") && (
                  <>
                    {/* (1) 事業所情報表 */}
                    <table className="mt-2">
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
                          <th className="text-center" style={{ background: "#f5f5f5" }}>
                            所　在　地
                          </th>
                          <td>{companyAddress || "　"}</td>
                        </tr>
                        <tr>
                          <th className="text-center" style={{ background: "#f5f5f5" }}>
                            介護保険 指定事業所番号
                          </th>
                          <td>{officeDesignationNumber || "　"}</td>
                        </tr>
                        <tr>
                          <th className="text-center" style={{ background: "#f5f5f5" }}>
                            通常のサービス実施地域
                          </th>
                          <td className="whitespace-pre-wrap">{officeServiceArea || "　"}</td>
                        </tr>
                      </tbody>
                    </table>

                    {/* (2) 職員体制表 (= docx: 4 行 × 4 列) */}
                    <p className="mt-3 font-semibold">・当事業所の職員体制</p>
                    <table className="mt-1">
                      <thead>
                        <tr>
                          <th style={{ width: "40%", background: "#f5f5f5" }}>　</th>
                          <th className="text-center" style={{ background: "#f5f5f5" }}>
                            常勤
                          </th>
                          <th className="text-center" style={{ background: "#f5f5f5" }}>
                            非常勤
                          </th>
                          <th className="text-center" style={{ background: "#f5f5f5" }}>
                            計
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>管理者 兼 主任介護支援専門員</td>
                          <td className="text-center">１名</td>
                          <td className="text-center">０名</td>
                          <td className="text-center">１名</td>
                        </tr>
                        <tr>
                          <td>主任介護支援専門員</td>
                          <td className="text-center">１名</td>
                          <td className="text-center">０名</td>
                          <td className="text-center">１名</td>
                        </tr>
                        <tr>
                          <td>介護支援専門員</td>
                          <td className="text-center">２名</td>
                          <td className="text-center">０名</td>
                          <td className="text-center">２名</td>
                        </tr>
                        <tr>
                          <td>事務職員</td>
                          <td className="text-center">１名</td>
                          <td className="text-center">０名</td>
                          <td className="text-center">１名</td>
                        </tr>
                      </tbody>
                    </table>

                    {/* (3) 営業日・営業時間表 (= docx: 2 行 × 2 列) */}
                    <p className="mt-3 font-semibold">・営業日及び営業時間</p>
                    <table className="mt-1">
                      <tbody>
                        <tr>
                          <th
                            className="text-center"
                            style={{ width: "20%", background: "#f5f5f5" }}
                          >
                            営業日
                          </th>
                          <td className="whitespace-pre-wrap">
                            月曜日から金曜日です。{"\n"}
                            但し、祝日・８月１３日～８月１５日及び１２月３０日～１月３日までにつきましては、その曜日に関わらず年間の休日となります。
                          </td>
                        </tr>
                        <tr>
                          <th className="text-center" style={{ background: "#f5f5f5" }}>
                            営業時間
                          </th>
                          <td className="whitespace-pre-wrap">
                            午前９時から午後６時です。{"\n"}
                            但し、転送電話等により24時間365日の連絡体制を確保し、かつ必要に応じて利用者様等からの相談に対応 及び 必要と認められる居宅介護支援サービスを行うことができる体制を確保しています。{"\n"}
                            ※営業日及び営業時間外の連絡につきましては、管理者の会社所有の携帯電話（{c("company_emergency_phone") || "080-9342-6539"}）までご連絡いただければ、担当の介護支援専門員に連絡がとれる体制を確保しています。
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </>
                )}

                {/* 別紙4 (= "４　利用料金") では介護保険給付の料金表を追加表示 */}
                {chapter.title.startsWith("４") && (
                  <>
                    {/* 利用料 intro (該当 key の本文を見出し付きで先に表示) */}
                    {c("juyo_04_fee_intro").trim() && (
                      <>
                        <p className="mt-2 font-semibold">・利用料</p>
                        <p className="whitespace-pre-wrap" style={{ marginTop: "0.2em" }}>
                          {c("juyo_04_fee_intro")}
                        </p>
                      </>
                    )}
                    {/* 料金表 (= docx: 5 行 × 2 列、その他加算は別行) */}
                    <p className="mt-3">
                      ※　保険料の滞納等により、法定代理受領ができなくなった場合の料金
                    </p>
                    <table className="mt-1">
                      <tbody>
                        <tr>
                          <th
                            className="text-center"
                            style={{ width: "30%", background: "#f5f5f5" }}
                          >

                          </th>
                          <th className="text-center" style={{ background: "#f5f5f5" }}>
                            居宅介護支援費（特定事業所加算Ⅱ）
                          </th>
                        </tr>
                        <tr>
                          <td className="text-center whitespace-pre-wrap">
                            要介護{"\n"}１・２
                          </td>
                          <td>１５，３８６円／月</td>
                        </tr>
                        <tr>
                          <td className="text-center whitespace-pre-wrap">
                            要介護{"\n"}３～５
                          </td>
                          <td>１８，７０４円／月</td>
                        </tr>
                        <tr>
                          <td className="text-center">その他加算</td>
                          <td className="whitespace-pre-wrap" style={{ lineHeight: 1.7 }}>
                            初回加算　　　　　　　　　　　　　　　　　　 ３，０６３円{"\n"}
                            入院時情報連携加算（Ⅰ）　　　　　　　　　　 ２，５５２円{"\n"}
                            入院時情報連携加算（Ⅱ）　　　　　　　　　　 ２，０４２円{"\n"}
                            退院・退所加算（Ⅰ）イ　　　　　　　　　　　 ４，５９４円{"\n"}
                            退院・退所加算（Ⅰ）ロ　　　　　　　　　　　 ６，１２６円{"\n"}
                            退院・退所加算（Ⅱ）イ　　　　　　　　　　　 ６，１２６円{"\n"}
                            退院・退所加算（Ⅱ）ロ　　　　　　　　　　　 ７，６５７円{"\n"}
                            退院・退所加算（Ⅲ）　　　　　　　　　　　　 ９，１８９円{"\n"}
                            緊急時等居宅カンファレンス加算　　　　　　　 ２，０４２円{"\n"}
                            ターミナルケアマネジメント加算　　　　　　　 ４，０８４円{"\n"}
                            通院時情報連携加算　　　　　　 　　 　　　 　 ５１０円
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    {/* 料金表 補足 (intro 以外) — 各小見出しは下の subs.map でまとめて render */}
                  </>
                )}

                {/* 各小見出し (sub) の本文表示 */}
                {chapter.subs.map((sub) => {
                  const body = c(sub.key);
                  if (!body.trim()) return null;
                  // 別紙4: juyo_04_fee_intro は table 前に既に render したので skip。
                  if (sub.key === "juyo_04_fee_intro") return null;
                  // 別紙4 の table_note は table 部分。本文として skip
                  if (sub.key === "juyo_04_fee_table_note") {
                    // 補足部分のみ本文として残す (= 「その他加算」見出しの行は table 内に既に出ているので本文では再描画しない)
                    return null;
                  }
                  return (
                    <div key={sub.key} style={{ marginTop: "0.8em" }}>
                      {sub.subheading && (
                        <p className="font-semibold">・{sub.subheading}</p>
                      )}
                      <p
                        className="whitespace-pre-wrap"
                        style={{ marginTop: sub.subheading ? "0.2em" : "0.4em" }}
                      >
                        {body}
                      </p>
                    </div>
                  );
                })}
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
      </div>
    </>
  );
}
