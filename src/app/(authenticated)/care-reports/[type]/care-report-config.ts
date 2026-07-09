// 課題整理総括表 / 評価表 の設定を Server / Client 両方から import できるよう
// "use client" 無しの独立 module に切り出し (reports/[type]/report-config.ts と同流儀)。

export type CareReportConfig = {
  titleJa: string;
  // true の帳票は対象月セレクタを表示する
  needsPeriod: boolean;
  landscape?: boolean;
};

export const CARE_REPORT_CONFIG: Record<string, CareReportConfig> = {
  "kadai-seiri": { titleJa: "課題整理総括表", needsPeriod: false, landscape: true },
  "hyouka": { titleJa: "評価表（サービス担当者会議の評価）", needsPeriod: true, landscape: true },
};
