import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: r } = await supabase
    .from("shogai_service_records")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!r) notFound();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", r.client_id)
    .maybeSingle();

  return (
    <div className="space-y-4 p-4">
      <Link
        href="/shogai/records"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft size={16} /> 一覧へ戻る
      </Link>
      <div className="rounded border bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">サービス提供実績</h1>
        <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs text-gray-500">利用者</dt>
            <dd className="font-medium">{client?.name ?? "(不明)"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">日付</dt>
            <dd>{r.service_date}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">時間帯</dt>
            <dd>
              {r.start_time?.slice(0, 5) ?? "—"} 〜{" "}
              {r.end_time?.slice(0, 5) ?? "—"} ({r.duration_minutes ?? 0} 分)
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">サービス種別</dt>
            <dd>{r.service_type}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">カテゴリ</dt>
            <dd>{r.service_category ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">単位数</dt>
            <dd className="font-mono">{r.unit_count?.toLocaleString() ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">状態</dt>
            <dd>{r.status}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">職員</dt>
            <dd>{r.staff_name_cached ?? "—"}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-gray-500">実施内容</dt>
            <dd className="whitespace-pre-wrap">{r.activities ?? "—"}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-gray-500">利用者の状態</dt>
            <dd className="whitespace-pre-wrap">{r.client_condition ?? "—"}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-gray-500">引継事項</dt>
            <dd className="whitespace-pre-wrap">{r.handover_notes ?? "—"}</dd>
          </div>
        </dl>
      </div>
      <p className="text-xs text-gray-500">
        編集・確定・キャンセルボタンは Phase 2 で実装予定
      </p>
    </div>
  );
}
