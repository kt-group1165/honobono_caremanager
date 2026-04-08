/**
 * ケアプランデータ連携システム標準仕様 v4.1 (202407) に準拠したCSV生成
 * 居宅介護支援事業所 → サービス事業所 へのデータ送信用
 */

const CSV_VERSION = "202407";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(v: string | null | undefined): string {
  const s = v ?? "";
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCSV(rows: string[][]): string {
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

function yyyymmdd(d: string | null | undefined): string {
  if (!d) return "";
  return d.replace(/-/g, "").slice(0, 8);
}

function yyyymm(d: string | null | undefined): string {
  if (!d) return "";
  return d.replace(/-/g, "").slice(0, 6);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserData {
  name?: string;
  name_kana?: string;
  birth_date?: string;
  gender?: string;
  address?: string;
  phone?: string;
  care_level?: string;
  insurer_no?: string;
  insured_no?: string;
}

export interface OfficeData {
  provider_number?: string;
  office_name?: string;
}

// ─── 利用者基本情報 CSV (p27-28) ──────────────────────────────────────────────

export function generateUserInfoCSV(user: UserData, office: OfficeData): string {
  const rows: string[][] = [];
  rows.push([
    CSV_VERSION,                          // 1: CSVバージョン
    user.insurer_no ?? "",                // 2: 保険者番号
    user.insured_no ?? "",                // 3: 被保険者番号
    user.name ?? "",                      // 4: 利用者氏名
    user.name_kana ?? "",                 // 5: 利用者カナ
    user.birth_date ? yyyymmdd(user.birth_date) : "", // 6: 生年月日
    user.gender === "男性" ? "1" : user.gender === "女性" ? "2" : "", // 7: 性別
    user.phone ?? "",                     // 8: 電話番号
    user.address ?? "",                   // 9: 住所
    user.care_level ?? "",                // 10: 要介護度
    "",                                   // 11: 認定有効期間開始
    "",                                   // 12: 認定有効期間終了
    "1",                                  // 13: 認定状況区分 (1:認定済)
    office.provider_number ?? "",         // 14: 居宅介護支援事業者コード
    office.office_name ?? "",             // 15: 居宅介護支援事業者名
    "",                                   // 16: 連絡先
    "",                                   // 17: 書面連絡状況区分
  ]);
  return toCSV(rows);
}

// ─── 第1表 居宅サービス計画書 (p29-30) ────────────────────────────────────────

export function generateCarePlan1CSV(
  content: Record<string, any>,
  user: UserData,
  office: OfficeData
): string {
  const rows: string[][] = [];
  rows.push([
    CSV_VERSION,                          // 1: CSVバージョン
    user.insurer_no ?? "",                // 2: 保険者番号
    user.insured_no ?? "",                // 3: 被保険者番号
    yyyymmdd(content.creation_date),      // 4: 居宅サービス計画作成日
    content.plan_type === "初回" ? "1" : content.plan_type === "紹介" ? "2" : "3", // 5: 初回/紹介/継続
    "",                                   // 6: 認定申請中区分
    user.care_level ?? "",                // 7: 要介護状態区分
    "",                                   // 8: 認定有効期間開始日
    "",                                   // 9: 認定有効期間終了日
    yyyymmdd(content.initial_creation_date), // 10: 初回居宅サービス計画作成日
    office.provider_number ?? "",         // 11: 居宅介護支援事業者コード
    office.office_name ?? "",             // 12: 居宅介護支援事業者名
    content.creator_name ?? "",           // 13: 担当者名
    content.issue_analysis ?? "",         // 14: 利用者及び家族の意向
    content.review_opinion ?? "",         // 15: 介護認定審査会の意見
    content.overall_policy ?? "",         // 16: 総合的な援助の方針
    content.living_support_reason ?? "",  // 17: 生活援助中心型の算定理由
    "",                                   // 18: 変更日
    "",                                   // 19: 前回作成日
    "",                                   // 20: 認定有効期間開始年月日
    "",                                   // 21: 認定有効期間終了年月日
    "",                                   // 22: 更新最後コード
    "1",                                  // 23: 識別子
  ]);
  return toCSV(rows);
}

// ─── 第2表 居宅サービス計画書 (p31) ──────────────────────────────────────────

export function generateCarePlan2CSV(
  content: Record<string, any>,
  user: UserData,
  office: OfficeData
): string {
  const rows: string[][] = [];
  const blocks = content.blocks ?? [];
  let rowNo = 0;

  for (const block of blocks) {
    const goals = block.goals ?? [];
    for (const goal of goals) {
      const services = goal.services ?? [];
      for (const svc of services) {
        rowNo++;
        rows.push([
          CSV_VERSION,                        // 1: CSVバージョン
          user.insurer_no ?? "",              // 2: 保険者番号
          user.insured_no ?? "",              // 3: 被保険者番号
          yyyymmdd(content.creation_date),    // 4: 居宅サービス計画作成日
          String(rowNo),                      // 5: 連番NO
          block.needs ?? "",                  // 6: 生活全般の解決すべき課題
          block.long_term_goal ?? "",         // 7: 長期目標
          block.long_term_period ?? "",       // 8: 長期目標期間
          goal.short_term_goal ?? "",         // 9: 短期目標
          goal.short_term_period ?? "",       // 10: 短期目標期間
          svc.content ?? "",                  // 11: サービス内容
          svc.insurance_flag === "○" ? "1" : "2", // 12: 保険給付対象
          svc.type ?? "",                     // 13: サービス種別
          svc.provider ?? "",                 // 14: サービス事業者名
          svc.frequency ?? "",                // 15: 頻度
          svc.period ?? "",                   // 16: 期間
          "",                                 // 17: 更新最後コード
          "1",                                // 18: 識別子
        ]);
      }
    }
  }
  return toCSV(rows);
}

// ─── 第3表 週間サービス計画表 (p32) ──────────────────────────────────────────

export function generateCarePlan3CSV(
  content: Record<string, any>,
  user: UserData,
  office: OfficeData
): string {
  const rows: string[][] = [];
  const schedule = content.schedule ?? {};
  const timeSlots = ["early_morning", "morning", "afternoon", "evening", "night"];
  const dayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  // Each slot-day combination that has content = one row
  let rowNo = 0;
  for (const slot of timeSlots) {
    const slotData = schedule[slot] ?? {};
    for (const day of dayKeys) {
      const val = slotData[day];
      if (val && val.trim()) {
        rowNo++;
        const dayNum = dayKeys.indexOf(day) + 1; // 1=月, 7=日
        const timeRange = slot === "early_morning" ? "0000-0600"
          : slot === "morning" ? "0600-1200"
          : slot === "afternoon" ? "1200-1800"
          : slot === "evening" ? "1800-2100"
          : "2100-2400";
        const [startTime, endTime] = timeRange.split("-");

        rows.push([
          CSV_VERSION,                        // 1: CSVバージョン
          user.insurer_no ?? "",              // 2: 保険者番号
          user.insured_no ?? "",              // 3: 被保険者番号
          yyyymmdd(content.creation_date),    // 4: 居宅サービス計画作成年月
          val,                                // 5: 介護サービスA/B欄
          String(dayNum),                     // 6: 曜日 (1=月〜7=日)
          startTime,                          // 7: 開始時刻
          endTime,                            // 8: 終了時刻
          content.daily_activities ?? "",      // 9: 主な日常生活上の活動
          content.other_services ?? "",        // 10: 週単位以外のサービス
          "",                                 // 11: 更新最後コード
          "1",                                // 12: 識別子
        ]);
      }
    }
  }
  return toCSV(rows);
}

// ─── 第6表 サービス利用票 予定 (p33-34) ──────────────────────────────────────

export interface Table6Service {
  service_type: string;
  start_time: string;
  end_time: string;
  provider_code?: string;
  provider_name?: string;
}

export interface Table6Grid {
  [rowKey: string]: { [day: number]: { planned: boolean; actual: boolean } };
}

export function generateTable6PlanCSV(
  services: Table6Service[],
  grid: Table6Grid,
  user: UserData,
  office: OfficeData,
  monthStr: string, // "YYYY-MM"
  daysCount: number
): string {
  const rows: string[][] = [];

  for (const svc of services) {
    const key = `${svc.service_type}__${svc.start_time}__${svc.end_time}`;
    const rowGrid = grid[key] ?? {};

    // 日別フラグ
    const dayFlags: string[] = [];
    for (let d = 1; d <= 31; d++) {
      if (d <= daysCount) {
        dayFlags.push(rowGrid[d]?.planned ? "1" : "");
      } else {
        dayFlags.push("");
      }
    }
    const plannedCount = dayFlags.filter((f) => f === "1").length;

    rows.push([
      CSV_VERSION,                          // 1: CSVバージョン
      user.insurer_no ?? "",                // 2: 保険者番号
      user.insured_no ?? "",                // 3: 被保険者番号
      yyyymm(monthStr),                     // 4: 利用対象年月
      "",                                   // 5: 居宅サービス計画作成日
      office.provider_number ?? "",         // 6: プラン居宅介護事業者コード
      office.office_name ?? "",             // 7: プラン事業者名
      "",                                   // 8: プラン事業所名
      "",                                   // 9: 開始年月日
      svc.service_type,                     // 10: サービス内容/名称
      svc.start_time.slice(0, 5).replace(":", ""), // 11: サービス開始時刻
      svc.end_time.slice(0, 5).replace(":", ""),   // 12: サービス終了時刻
      "",                                   // 13: サービスコード
      svc.provider_code ?? "",              // 14: サービス事業者コード
      svc.provider_name ?? "",              // 15: サービス事業者名
      ...dayFlags,                          // 16-46: 1日〜31日
      String(plannedCount),                 // 47: 回数合計
      "",                                   // 48: 更新最後コード
      "1",                                  // 49: 識別子
    ]);
  }
  return toCSV(rows);
}

// ─── 第6表 実績 ──────────────────────────────────────────────────────────────

export function generateTable6ActualCSV(
  services: Table6Service[],
  grid: Table6Grid,
  user: UserData,
  office: OfficeData,
  monthStr: string,
  daysCount: number
): string {
  const rows: string[][] = [];

  for (const svc of services) {
    const key = `${svc.service_type}__${svc.start_time}__${svc.end_time}`;
    const rowGrid = grid[key] ?? {};

    const dayFlags: string[] = [];
    for (let d = 1; d <= 31; d++) {
      if (d <= daysCount) {
        dayFlags.push(rowGrid[d]?.actual ? "1" : "");
      } else {
        dayFlags.push("");
      }
    }
    const actualCount = dayFlags.filter((f) => f === "1").length;

    rows.push([
      CSV_VERSION,
      user.insurer_no ?? "",
      user.insured_no ?? "",
      yyyymm(monthStr),
      svc.provider_code ?? office.provider_number ?? "",
      "11",                                 // サービス種類コード（訪問介護デフォルト）
      svc.service_type,
      svc.start_time.slice(0, 5).replace(":", ""),
      svc.end_time.slice(0, 5).replace(":", ""),
      ...dayFlags,
      String(actualCount),
      "",
      "1",
    ]);
  }
  return toCSV(rows);
}

// ─── 第7表 サービス利用票別表 (p35) ──────────────────────────────────────────

export function generateTable7CSV(
  content: Record<string, any>,
  user: UserData,
  office: OfficeData
): string {
  const rows: string[][] = [];
  const items = content.items ?? [];

  for (const item of items) {
    rows.push([
      CSV_VERSION,                          // 1: CSVバージョン
      user.insurer_no ?? "",                // 2: 保険者番号
      user.insured_no ?? "",                // 3: 被保険者番号
      yyyymm(content.creation_date),        // 4: 期間対象年月
      item.provider_number ?? "",           // 5: サービス事業者コード
      "",                                   // 6: サービス種類コード
      item.service_code ?? "",              // 7: サービスコード
      item.service_content ?? "",           // 8: サービス内容/名称
      String(item.units ?? ""),             // 9: 単位数
      String(item.count ?? ""),             // 10: 回数
      String(item.service_units ?? ""),     // 11: サービス単位数
      String(item.within_limit_units ?? ""), // 12: 区分支給限度内単位数
      String(item.unit_price ?? ""),        // 13: 単位数単価
      String(item.total_cost ?? ""),        // 14: 費用総額
      String(item.benefit_rate ?? ""),      // 15: 給付率
      String(item.insurance_claim ?? ""),   // 16: 保険請求額
      String(item.user_copay ?? ""),        // 17: 利用者負担
      "",                                   // 18: 更新最後コード
      "1",                                  // 19: 識別子
    ]);
  }
  return toCSV(rows);
}

// ─── 一括ダウンロード ────────────────────────────────────────────────────────

export function downloadCSV(content: string, filename: string) {
  const bom = "\uFEFF";
  const blob = new Blob([bom + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function generateTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
