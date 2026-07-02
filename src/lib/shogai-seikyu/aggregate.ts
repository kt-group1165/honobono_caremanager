/**
 * 障害福祉サービス 請求集計 (障害請求画面 + 国保連 CSV 用)
 *
 * データフロー:
 *   shogai_service_records (status='confirmed' = 実績確定)
 *     × clients (氏名)
 *     × shougai_certifications (受給者証番号 / 市町村番号 / 障害支援区分 / 上限月額 / 生保)
 *   → 利用者ごとに 1 行の請求サマリ + サービスコード別明細
 *
 * 金額計算 (障害者総合支援法の標準):
 *   総費用額 = floor(総単位数 × 地域単価)
 *   利用者負担 = min(floor(総費用額 × 負担率 10%), 負担上限月額)   ※生保は 0
 *   介護給付費請求額 = 総費用額 - 利用者負担
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ShogaiSeikyuDetail {
  /** サービス種別 (居宅介護 等) */
  service_type: string;
  /** サービス内容 (身体介護 等 category) */
  service_category: string | null;
  /** サービスコード (6 桁) */
  service_code: string | null;
  /** 1 回あたり単位数 */
  unit_per: number;
  /** 回数 */
  count: number;
  /** 小計単位数 */
  units: number;
}

export interface ShogaiSeikyuRow {
  user_id: string;
  user_name: string;
  user_name_kana: string | null;
  /** 受給者証番号 */
  beneficiary_number: string | null;
  /** 市町村番号 (支給決定自治体) */
  municipality: string | null;
  /** 障害支援区分 */
  support_level: string | null;
  /** 負担上限月額 (0 = 負担なし) */
  self_payment_limit: number;
  /** 生保フラグ */
  seiho: boolean;
  details: ShogaiSeikyuDetail[];
  totalUnits: number;
  unitPrice: number;
  /** 総費用額 (円) */
  totalAmount: number;
  /** 利用者負担額 (上限適用後) */
  userAmount: number;
  /** 介護給付費請求額 */
  benefitAmount: number;
}

export interface ShogaiSeikyuResult {
  rows: ShogaiSeikyuRow[];
  month: string; // YYYY-MM
  recordCount: number;
}

export async function aggregateMonthlyShogaiSeikyu(
  supabase: SupabaseClient,
  opts: {
    year: number;
    month: number;
    unitPrice?: number;
  },
): Promise<ShogaiSeikyuResult> {
  const monthStr = `${opts.year}-${String(opts.month).padStart(2, "0")}`;
  const daysInMonth = new Date(opts.year, opts.month, 0).getDate();
  const from = `${monthStr}-01`;
  const to = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const unitPrice = opts.unitPrice && opts.unitPrice > 0 ? opts.unitPrice : 10.0;

  // 1) 実績 (confirmed) を月範囲で取得 (page-loop)
  const PAGE = 1000;
  interface Rec {
    client_id: string;
    service_type: string;
    service_category: string | null;
    service_code: string | null;
    unit_count: number | null;
  }
  const records: Rec[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("shogai_service_records")
      .select("client_id, service_type, service_category, service_code, unit_count")
      .eq("status", "confirmed")
      .gte("service_date", from)
      .lte("service_date", to)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`実績取得失敗: ${error.message}`);
    const rows = (data ?? []) as Rec[];
    records.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  if (records.length === 0) {
    return { rows: [], month: monthStr, recordCount: 0 };
  }

  // 2) 利用者情報
  const userIds = Array.from(new Set(records.map((r) => r.client_id)));
  const clientById = new Map<string, { name: string; furigana: string | null }>();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, furigana")
      .in("id", chunk);
    if (error) throw new Error(`利用者取得失敗: ${error.message}`);
    for (const c of (data ?? []) as { id: string; name: string; furigana: string | null }[]) {
      clientById.set(c.id, { name: c.name, furigana: c.furigana });
    }
  }

  // 3) 受給者証 (最新 = certification_start_date DESC の 1 件)
  interface Cert {
    client_id: string;
    beneficiary_number: string | null;
    insurer_municipality: string | null;
    support_level: string | null;
    self_payment_limit: number | null;
    seiho_flag: boolean | null;
  }
  const certByClient = new Map<string, Cert>();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from("shougai_certifications")
      .select(
        "client_id, beneficiary_number, insurer_municipality, support_level, self_payment_limit, seiho_flag, certification_start_date",
      )
      .in("client_id", chunk)
      .order("certification_start_date", { ascending: false });
    if (error) throw new Error(`受給者証取得失敗: ${error.message}`);
    for (const r of (data ?? []) as Cert[]) {
      if (!certByClient.has(r.client_id)) certByClient.set(r.client_id, r);
    }
  }

  // 4) 利用者 × (service_type + code) 集計
  const byUser = new Map<string, Map<string, ShogaiSeikyuDetail>>();
  for (const r of records) {
    if (!byUser.has(r.client_id)) byUser.set(r.client_id, new Map());
    const m = byUser.get(r.client_id)!;
    const key = `${r.service_type}__${r.service_code ?? ""}__${r.service_category ?? ""}`;
    const cur = m.get(key);
    const unitPer = r.unit_count ?? 0;
    if (cur) {
      cur.count += 1;
      cur.units += unitPer;
    } else {
      m.set(key, {
        service_type: r.service_type,
        service_category: r.service_category,
        service_code: r.service_code,
        unit_per: unitPer,
        count: 1,
        units: unitPer,
      });
    }
  }

  const rows: ShogaiSeikyuRow[] = [];
  for (const [userId, detailMap] of byUser) {
    const client = clientById.get(userId);
    const cert = certByClient.get(userId);
    const details = Array.from(detailMap.values()).sort((a, b) => b.units - a.units);
    const totalUnits = details.reduce((s, d) => s + d.units, 0);
    const totalAmount = Math.floor(totalUnits * unitPrice);
    const seiho = !!cert?.seiho_flag;
    const limit = cert?.self_payment_limit ?? 0;
    let userAmount = seiho ? 0 : Math.floor(totalAmount * 0.1);
    if (!seiho && limit > 0) userAmount = Math.min(userAmount, limit);
    const benefitAmount = totalAmount - userAmount;

    rows.push({
      user_id: userId,
      user_name: client?.name ?? "(利用者不明)",
      user_name_kana: client?.furigana ?? null,
      beneficiary_number: cert?.beneficiary_number ?? null,
      municipality: cert?.insurer_municipality ?? null,
      support_level: cert?.support_level ?? null,
      self_payment_limit: limit,
      seiho,
      details,
      totalUnits,
      unitPrice,
      totalAmount,
      userAmount,
      benefitAmount,
    });
  }

  rows.sort((a, b) =>
    (a.user_name_kana ?? a.user_name).localeCompare(
      b.user_name_kana ?? b.user_name,
      "ja",
    ),
  );

  return { rows, month: monthStr, recordCount: records.length };
}

// ─── 国保連 CSV (介護給付費・訓練等給付費等明細書 J121 相当の簡易形式) ─────────

const SERVICE_TYPE_CODES: Record<string, string> = {
  居宅介護: "11",
  重度訪問介護: "12",
  行動援護: "13",
  同行援護: "14",
};

/**
 * 国保連請求 CSV 文字列を生成。
 * 完全な interface 仕様 (交換情報識別番号付き固定長 multi-record) は
 * 伝送ソフトの取込仕様確定後に対応する。ここでは明細書 (J121) 相当の
 * 項目を網羅した明細 CSV を出す。
 */
export function buildShogaiSeikyuCsv(
  rows: ShogaiSeikyuRow[],
  year: number,
  month: number,
): string {
  const ym = `${year}${String(month).padStart(2, "0")}`;
  const header = [
    "提供年月",
    "市町村番号",
    "受給者証番号",
    "支給決定障害者等氏名",
    "障害支援区分",
    "サービス種類コード",
    "サービス種類",
    "サービスコード",
    "サービス内容",
    "単位数",
    "回数",
    "サービス単位数",
    "合計単位数",
    "総費用額",
    "利用者負担上限月額",
    "利用者負担額",
    "介護給付費請求額",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    for (const d of r.details) {
      lines.push(
        [
          ym,
          r.municipality ?? "",
          r.beneficiary_number ?? "",
          `"${r.user_name}"`,
          r.support_level ?? "",
          SERVICE_TYPE_CODES[d.service_type] ?? "",
          `"${d.service_type}"`,
          d.service_code ?? "",
          `"${d.service_category ?? ""}"`,
          d.unit_per,
          d.count,
          d.units,
          r.totalUnits,
          r.totalAmount,
          r.self_payment_limit,
          r.userAmount,
          r.benefitAmount,
        ].join(","),
      );
    }
  }
  return lines.join("\r\n");
}
