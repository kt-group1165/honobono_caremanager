import { redirect } from "next/navigation";

// 事業所マスタは /master/offices に統合。旧 URL・ブックマーク保護のためリダイレクト。
export default function OfficeRedirect() {
  redirect("/master/offices?tab=group");
}
