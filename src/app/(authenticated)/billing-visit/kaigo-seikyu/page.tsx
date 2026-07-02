import { KaigoSeikyuContent } from "./kaigo-seikyu-content";

/**
 * /billing-visit/kaigo-seikyu — 介護請求 (訪問介護)
 * 利用者ごとに 1 行、月次の単位数集計 + 保険請求額。
 * 明細 (何のサービスで何単位) は右パネルに表示。
 */
export default function KaigoSeikyuPage() {
  return <KaigoSeikyuContent />;
}
