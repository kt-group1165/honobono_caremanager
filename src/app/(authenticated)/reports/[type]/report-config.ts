// REPORT_CONFIG / 関連型 を Server Component と Client Component の両方から
// 安全に import できるよう、"use client" 指定の無い独立 module に切り出し。
// (Next.js 15 で "use client" file から定数を Server Component に import すると
//  bundling 上 undefined になる場合があり、page.tsx の `if (!config)` が誤って
//  発動するため。)

export type ReportConfig = { titleJa: string; needsPeriod: boolean; landscape?: boolean };

export const REPORT_CONFIG: Record<string, ReportConfig> = {
  "care-plan-1":       { titleJa: "居宅サービス計画書（第1表）",        needsPeriod: false, landscape: true },
  "care-plan-2":       { titleJa: "居宅サービス計画書（第2表）",        needsPeriod: false, landscape: true },
  "care-plan-3":       { titleJa: "週間サービス計画表（第3表）",        needsPeriod: false, landscape: true },
  "support-progress":  { titleJa: "居宅介護支援経過（第5表）",          needsPeriod: true,  landscape: true },
  "service-usage":        { titleJa: "利用票・提供票",                    needsPeriod: true,  landscape: true },
  "service-usage-detail": { titleJa: "サービス利用票別表",                needsPeriod: true,  landscape: true },
};
