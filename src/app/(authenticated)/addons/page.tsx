/**
 * 加算管理 page (= 居宅・訪問介護 両版共通)
 *
 * Server Component shell。実体は client component の <AddonsContent />。
 * 現在 office + business_type は useBusinessType (= client-side context) が解決するので、
 * このページは shell のみ。
 */
import { AddonsContent } from "./addons-content";

export default function AddonsPage() {
  return <AddonsContent />;
}
