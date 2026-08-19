import { redirect } from "next/navigation";

/**
 * 旧「受給者証 (詳細)」ページの転送先。
 *
 * 受給者証の画面が /disability と /shougai-cert に二重実装されていて、
 * /disability 側は client_disability_certifications (0 件・取込も請求も未接続) を
 * 見ていたため常に空だった。実データのある /shougai-cert に一本化した (2026-08-19)。
 *
 * 既存のブックマーク・開きっぱなしのタブが 404 にならないよう転送だけ残す。
 * 参照が無くなったら消してよい。
 */
export default async function DisabilityRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/users/${id}/shougai-cert`);
}
