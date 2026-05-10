"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Send, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

// 居宅介護支援 (kaigo-app) → サービス事業所 (福祉用具/訪問介護/訪問入浴/訪問看護) への
// 書類送付用モーダル。order-app の SendRentalReportModal を参考にした汎用版。
//
// 動き:
//   1. tenant 内の対象 service_type の office を一覧 (radio + 検索)
//   2. 確定で shared_documents INSERT + notifications INSERT (type='document_received')
//   3. 受信側 office の全 staff 宛 (user_id=null, office_id=target) に通知

const DEFAULT_TARGET_SERVICE_TYPES = [
  "福祉用具",
  "訪問介護",
  "訪問入浴",
  "訪問看護",
] as const;

export type DocumentType =
  | "care_plan_1"
  | "care_plan_2"
  | "care_plan_3"
  | "emergency_sheet"
  | "service_record_monthly"
  | string; // 拡張余地

export interface SendDocumentModalClient {
  id: string;
  name: string;
}

export interface SendDocumentModalProps {
  tenantId: string;
  client: SendDocumentModalClient;
  sourceOfficeId: string;
  documentType: DocumentType;
  /** 通知 / shared_documents に保存される表示用タイトル (例: "緊急時シート 2026-05-10 山田 太郎 様") */
  title: string;
  /** 印刷対象 DOM の outerHTML を返す callback */
  getHtmlSnapshot: () => string;
  /** payload に詰める追加 metadata (任意) */
  payload?: Record<string, unknown>;
  /** 関連元 document の id (任意) */
  sourceDocumentId?: string | null;
  /** 送付先候補に含める service_type 一覧 (default: 福祉用具/訪問介護/訪問入浴/訪問看護)。
   *  例: 実績送付では `["居宅介護支援"]` を渡し、居宅介護支援事業所のみを候補にする。 */
  targetServiceTypes?: string[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

type OfficeChoice = {
  id: string;
  name: string;
  service_type: string;
  is_assigned: boolean;
};

export function SendDocumentModal({
  tenantId,
  client,
  sourceOfficeId,
  documentType,
  title,
  getHtmlSnapshot,
  payload,
  sourceDocumentId,
  targetServiceTypes,
  onClose,
  onSuccess,
  onError,
}: SendDocumentModalProps) {
  const supabase = useMemo(() => createClient(), []);
  const targetTypes = useMemo<string[]>(
    () => targetServiceTypes ?? (DEFAULT_TARGET_SERVICE_TYPES as unknown as string[]),
    [targetServiceTypes],
  );

  const [loading, setLoading] = useState(true);
  const [choices, setChoices] = useState<OfficeChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceOfficeName, setSourceOfficeName] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // 1. 当該利用者の office assignment 一覧
        const { data: asgn, error: asgnErr } = await supabase
          .from("client_office_assignments")
          .select("office_id")
          .eq("tenant_id", tenantId)
          .eq("client_id", client.id);
        if (asgnErr) throw asgnErr;
        const assignedIds = new Set(
          ((asgn ?? []) as Array<{ office_id: string }>).map((a) => a.office_id),
        );

        // 2. tenant 内のサービス事業所一覧 (target service_type)
        const { data: targetOffices, error: tgtErr } = await supabase
          .from("offices")
          .select("id, name, service_type")
          .eq("tenant_id", tenantId)
          .in("service_type", targetTypes)
          .eq("is_active", true)
          .order("service_type", { ascending: true })
          .order("name", { ascending: true });
        if (tgtErr) throw tgtErr;

        // 3. 送信元 office 名
        const { data: srcOffice } = await supabase
          .from("offices")
          .select("name")
          .eq("id", sourceOfficeId)
          .maybeSingle();
        if (cancelled) return;
        if (srcOffice?.name) setSourceOfficeName(srcOffice.name as string);

        type OfficeRow = { id: string; name: string; service_type: string | null };
        const all: OfficeChoice[] = ((targetOffices ?? []) as OfficeRow[]).map((o) => ({
          id: o.id,
          name: o.name,
          service_type: o.service_type ?? "",
          is_assigned: assignedIds.has(o.id),
        }));
        const assigned = all.filter((c) => c.is_assigned);
        setChoices(all);
        if (assigned.length > 0) {
          setShowAll(false);
          setSelectedId(assigned[0].id);
        } else {
          setShowAll(true);
          setSelectedId(all[0]?.id ?? null);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, tenantId, client.id, sourceOfficeId, targetTypes]);

  const visibleChoices = useMemo(() => {
    const base = showAll ? choices : choices.filter((c) => c.is_assigned);
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.service_type.toLowerCase().includes(q),
    );
  }, [choices, showAll, search]);

  const assignedCount = choices.filter((c) => c.is_assigned).length;

  const handleSend = async () => {
    if (!selectedId) return;
    setSending(true);
    setErrorMsg(null);
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData?.user) throw new Error("ユーザー情報が取得できません");
      const userId = userData.user.id;

      const html = getHtmlSnapshot();
      if (!html) throw new Error("プレビュー DOM が見つかりません");

      // shared_documents INSERT
      const { data: sd, error: sdErr } = await supabase
        .from("shared_documents")
        .insert({
          tenant_id: tenantId,
          client_id: client.id,
          source_office_id: sourceOfficeId,
          target_office_id: selectedId,
          document_type: documentType,
          title,
          html_content: html,
          payload: payload ?? { client_id: client.id, client_name: client.name },
          source_document_id: sourceDocumentId ?? null,
          sent_by: userId,
        })
        .select("id")
        .single();
      if (sdErr || !sd) throw sdErr ?? new Error("shared_documents 作成失敗");

      // notifications INSERT (受信 office の全 staff 宛)
      const { error: ntErr } = await supabase.from("notifications").insert({
        tenant_id: tenantId,
        office_id: selectedId,
        user_id: null,
        type: "document_received",
        ref_table: "shared_documents",
        ref_id: sd.id,
        title: `${title} を受信`,
        body: `${sourceOfficeName || "送信元事業所"} から`,
      });
      if (ntErr) throw ntErr;

      onSuccess();
    } catch (e) {
      // Supabase error は Error instance ではなく { message, details, hint, code } の plain object
      console.error("[SendDocumentModal] 送付失敗", e);
      const msg =
        e instanceof Error
          ? e.message
          : (e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : JSON.stringify(e));
      setErrorMsg(msg);
      onError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4 print:hidden"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">サービス事業所に送付</h3>
          <p className="text-xs text-gray-500 mt-1">
            {client.name} 様 — {title}
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 size={22} className="animate-spin text-blue-500" />
            </div>
          ) : choices.length === 0 ? (
            <p className="text-sm text-red-500">
              tenant 内に対象のサービス事業所が登録されていません
              （対象: {targetTypes.join(" / ")}）
            </p>
          ) : (
            <>
              <div>
                <label className="text-xs text-gray-500 block mb-1.5">送付先</label>
                {assignedCount === 0 && (
                  <p className="text-xs text-amber-600 mb-2">
                    この利用者に紐付くサービス事業所がありません。全候補から手動選択してください。
                  </p>
                )}
                {assignedCount > 0 && (
                  <label className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                    <input
                      type="checkbox"
                      checked={showAll}
                      onChange={(e) => setShowAll(e.target.checked)}
                      className="w-3.5 h-3.5 accent-blue-500"
                    />
                    <span>全サービス事業所から選ぶ</span>
                  </label>
                )}

                <div className="relative mb-2">
                  <Search
                    size={14}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
                  />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="事業所名 / 種別で検索"
                    className="w-full text-sm pl-8 pr-3 py-1.5 border border-gray-200 rounded-lg focus:border-blue-400 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5 max-h-60 overflow-y-auto">
                  {visibleChoices.length === 0 ? (
                    <p className="text-xs text-gray-400 py-2 text-center">
                      該当する事業所がありません
                    </p>
                  ) : (
                    visibleChoices.map((c) => (
                      <label
                        key={c.id}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer ${
                          selectedId === c.id
                            ? "border-blue-400 bg-blue-50"
                            : "border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="target_office"
                          value={c.id}
                          checked={selectedId === c.id}
                          onChange={() => setSelectedId(c.id)}
                          className="accent-blue-500"
                        />
                        <span className="text-sm text-gray-800 flex-1 truncate">
                          {c.name}
                        </span>
                        <span className="text-[10px] text-gray-500 shrink-0 px-1.5 py-0.5 bg-gray-100 rounded">
                          {c.service_type}
                        </span>
                        {c.is_assigned && (
                          <span className="text-[10px] text-blue-600 shrink-0 px-1.5 py-0.5 bg-blue-100 rounded">
                            担当
                          </span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              </div>

              {errorMsg && (
                <div className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {errorMsg}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={sending}
            className="text-sm text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSend}
            disabled={loading || sending || !selectedId}
            className="text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2 rounded-lg flex items-center gap-1.5"
          >
            {sending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            送付確定
          </button>
        </div>
      </div>
    </div>
  );
}
