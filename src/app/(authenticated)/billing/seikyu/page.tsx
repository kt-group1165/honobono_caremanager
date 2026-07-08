import { KyotakuSeikyuContent } from "./seikyu-content";

/**
 * /billing/seikyu — 請求 (居宅介護支援・1 画面タブ切替)
 * 月次情報 / 介護請求 / 国保請求 / 入金管理 をタブで切替える統合画面。
 * (訪問介護版 /billing-visit/seikyu の居宅版)
 */
export default function KyotakuSeikyuPage() {
  return <KyotakuSeikyuContent />;
}
