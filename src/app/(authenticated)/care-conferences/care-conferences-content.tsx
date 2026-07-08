"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  MessagesSquare,
  Plus,
  Save,
  Trash2,
  Loader2,
  Printer,
  X,
  AlertTriangle,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { useBusinessType } from "@/lib/business-type-context";

// kaigo_care_conferences 行 (migrations/kaigo_care_conferences.sql)
export interface CareConference {
  id: string;
  tenant_id: string;
  office_id: string | null;
  client_id: string;
  held_on: string;
  attendees: string | null;
  agenda: string | null;
  conclusion: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// 共通マスタ clients の subset
export interface UserInfo {
  id: string;
  name: string;
  furigana: string | null;
}

export interface CareConferencesContentProps {
  userId: string;
  initialUser: UserInfo | null;
  initialRecords: CareConference[];
  tableMissing: boolean;
}

/** テーブル未作成 (migration 未適用) を表す PostgREST エラーコード */
function isTableMissingError(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

function toWareki(dateStr: string): string {
  if (!dateStr) return "";
  const d = parseISO(dateStr);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (y > 2019 || (y === 2019 && m >= 5)) return `令和${y - 2018}年${m}月${day}日`;
  if (y >= 1989) return `平成${y - 1988}年${m}月${day}日`;
  return `${y}年${m}月${day}日`;
}

export function CareConferencesContent({
  userId,
  initialUser,
  initialRecords,
  tableMissing: initialTableMissing,
}: CareConferencesContentProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();

  const [selectedUser] = useState<UserInfo | null>(initialUser);
  const [records, setRecords] = useState<CareConference[]>(initialRecords);
  const [tableMissing, setTableMissing] = useState(initialTableMissing);
  const [loading, setLoading] = useState(false);

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    held_on: format(new Date(), "yyyy-MM-dd"),
    attendees: "",
    agenda: "",
    conclusion: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  // 印刷対象 (一覧の 印刷 ボタンで選択 → window.print)
  const [printTarget, setPrintTarget] = useState<CareConference | null>(null);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("kaigo_care_conferences")
      .select("*")
      .eq("client_id", userId)
      .order("held_on", { ascending: false });
    if (error) {
      if (isTableMissingError(error.code)) {
        setTableMissing(true);
      } else {
        toast.error("カンファレンス記録の取得に失敗しました: " + error.message);
      }
    } else {
      setTableMissing(false);
      setRecords((data as CareConference[]) ?? []);
    }
    setLoading(false);
  }, [supabase, userId]);

  // initial render は server からの initialRecords を使用、内部 mutation 後の refetch のみ
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    fetchRecords();
  }, [fetchRecords]);

  const openNew = () => {
    setEditingId(null);
    setForm({
      held_on: format(new Date(), "yyyy-MM-dd"),
      attendees: "",
      agenda: "",
      conclusion: "",
      notes: "",
    });
    setShowForm(true);
  };

  const openEdit = (rec: CareConference) => {
    setEditingId(rec.id);
    setForm({
      held_on: rec.held_on,
      attendees: rec.attendees ?? "",
      agenda: rec.agenda ?? "",
      conclusion: rec.conclusion ?? "",
      notes: rec.notes ?? "",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.held_on) {
      toast.error("開催日は必須です");
      return;
    }

    setSaving(true);
    try {
      // tenant_id は共有マスタ clients から解決 (kaigo_* table は tenant_id NOT NULL)
      const { data: clientRow, error: clientErr } = await supabase
        .from("clients")
        .select("tenant_id")
        .eq("id", userId)
        .single();
      if (clientErr) throw clientErr;

      const payload = {
        tenant_id: (clientRow as { tenant_id: string | null })?.tenant_id ?? "kt-group",
        office_id: currentOfficeId ?? null,
        client_id: userId,
        held_on: form.held_on,
        attendees: form.attendees.trim() || null,
        agenda: form.agenda.trim() || null,
        conclusion: form.conclusion.trim() || null,
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      };

      if (editingId) {
        const { error } = await supabase
          .from("kaigo_care_conferences")
          .update(payload)
          .eq("id", editingId);
        if (error) throw error;
        toast.success("更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_care_conferences")
          .insert(payload);
        if (error) throw error;
        toast.success("カンファレンス記録を登録しました");
      }

      setShowForm(false);
      fetchRecords();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (isTableMissingError(code)) {
        setTableMissing(true);
        setShowForm(false);
        return;
      }
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("このカンファレンス記録を削除しますか？")) return;
    const { error } = await supabase
      .from("kaigo_care_conferences")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error("削除に失敗しました: " + error.message);
      return;
    }
    toast.success("削除しました");
    fetchRecords();
  };

  const handlePrint = (rec: CareConference) => {
    setPrintTarget(rec);
    // 印刷 root の描画を待ってから print dialog
    setTimeout(() => window.print(), 60);
  };

  const fmtDate = (d: string | null) => {
    if (!d) return "—";
    try {
      return format(parseISO(d), "yyyy年M月d日(E)", { locale: ja });
    } catch {
      return d;
    }
  };

  const inp =
    "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <>
      {/* ── Print styles ── */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          #care-conference-print-root { display: block !important; }
          #care-conference-print-root { position: fixed; inset: 0; background: white; font-family: "MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif; }
          @page { size: A4 portrait; margin: 12mm; }
          .no-print { display: none !important; }
        }
        @media screen {
          #care-conference-print-root { display: none; }
        }
      `}</style>

      <div className="flex-1 overflow-y-auto p-6 no-print">
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessagesSquare className="text-blue-600" size={24} />
              <h1 className="text-xl font-bold text-gray-900">
                カンファレンス記録
              </h1>
              {selectedUser && (
                <span className="text-gray-500 text-sm">
                  — {selectedUser.name} 様
                </span>
              )}
            </div>
            <button
              onClick={openNew}
              disabled={tableMissing}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <Plus size={16} />
              新規作成
            </button>
          </div>

          {tableMissing && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                カンファレンス記録テーブル (kaigo_care_conferences) が未作成です。
                <code className="mx-1 rounded bg-amber-100 px-1 py-0.5 text-xs">
                  migrations/kaigo_care_conferences.sql
                </code>
                を Supabase SQL Editor で適用してください。
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 size={24} className="animate-spin text-blue-500" />
            </div>
          ) : !tableMissing && records.length === 0 ? (
            <div className="rounded-lg border bg-white py-16 text-center text-sm text-gray-500">
              <MessagesSquare size={40} className="mx-auto mb-3 text-gray-300" />
              まだカンファレンス記録がありません
              <div className="mt-3">
                <button
                  onClick={openNew}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  <Plus size={12} />
                  新規作成
                </button>
              </div>
            </div>
          ) : !tableMissing ? (
            <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-semibold text-gray-600 whitespace-nowrap">開催日</th>
                    <th className="px-4 py-2.5 text-left font-semibold text-gray-600">出席者</th>
                    <th className="px-4 py-2.5 text-left font-semibold text-gray-600">検討内容</th>
                    <th className="px-4 py-2.5 text-left font-semibold text-gray-600">結論</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {records.map((rec) => (
                    <tr key={rec.id} className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-2.5 font-medium whitespace-nowrap">
                        {fmtDate(rec.held_on)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 max-w-[180px]">
                        <span className="line-clamp-2 whitespace-pre-wrap">{rec.attendees ?? "—"}</span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 max-w-xs">
                        <span className="line-clamp-2 whitespace-pre-wrap">{rec.agenda ?? "—"}</span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 max-w-xs">
                        <span className="line-clamp-2 whitespace-pre-wrap">{rec.conclusion ?? "—"}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex gap-1">
                          <button
                            onClick={() => handlePrint(rec)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                            title="印刷"
                          >
                            <Printer size={13} />
                          </button>
                          <button
                            onClick={() => openEdit(rec)}
                            className="rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600"
                            title="編集"
                          >
                            <Save size={13} />
                          </button>
                          <button
                            onClick={() => handleDelete(rec.id)}
                            className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                            title="削除"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        {showForm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setShowForm(false)}
          >
            <div
              className="w-full max-w-2xl rounded-lg bg-white shadow-xl max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b px-5 py-3">
                <h2 className="text-sm font-semibold text-gray-900">
                  {editingId ? "カンファレンス記録を編集" : "カンファレンス記録を作成"}
                </h2>
                <button
                  onClick={() => setShowForm(false)}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div className="max-w-[200px]">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    開催日 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={form.held_on}
                    onChange={(e) => setForm({ ...form, held_on: e.target.value })}
                    className={inp}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    出席者
                  </label>
                  <textarea
                    value={form.attendees}
                    onChange={(e) => setForm({ ...form, attendees: e.target.value })}
                    className={inp + " resize-y"}
                    rows={2}
                    placeholder="サ責 山田、ヘルパー 佐藤、ケアマネ 鈴木 等"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    検討内容
                  </label>
                  <textarea
                    value={form.agenda}
                    onChange={(e) => setForm({ ...form, agenda: e.target.value })}
                    className={inp + " resize-y"}
                    rows={5}
                    placeholder="議題・討議内容"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    結論
                  </label>
                  <textarea
                    value={form.conclusion}
                    onChange={(e) => setForm({ ...form, conclusion: e.target.value })}
                    className={inp + " resize-y"}
                    rows={4}
                    placeholder="決定事項・対応方針"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    備考
                  </label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    className={inp + " resize-y"}
                    rows={2}
                    placeholder="残された課題・次回開催予定 等"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t bg-gray-50 px-5 py-3">
                <button
                  onClick={() => setShowForm(false)}
                  className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  {editingId ? "更新" : "登録"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── PRINT VERSION (A4縦、シンプル様式) ── */}
      <div id="care-conference-print-root">
        {printTarget && selectedUser && (
          <div
            style={{
              padding: "4mm",
              fontFamily: '"MS Mincho", "ＭＳ 明朝", "Noto Serif JP", serif',
              fontSize: "10pt",
              color: "#000",
              background: "#fff",
            }}
          >
            <div
              style={{
                textAlign: "center",
                fontSize: "14pt",
                fontWeight: "bold",
                letterSpacing: "0.2em",
                marginBottom: "6mm",
              }}
            >
              ケアカンファレンス記録（個別援助会議）
            </div>

            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "10pt",
              }}
            >
              <tbody>
                <tr>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      width: "24%",
                      background: "#f2f2f2",
                      textAlign: "left",
                    }}
                  >
                    利用者名
                  </th>
                  <td style={{ border: "1pt solid #333", padding: "2mm", width: "43%" }}>
                    {selectedUser.name}　様
                  </td>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      width: "10%",
                      background: "#f2f2f2",
                      textAlign: "left",
                    }}
                  >
                    開催日
                  </th>
                  <td style={{ border: "1pt solid #333", padding: "2mm" }}>
                    {toWareki(printTarget.held_on)}
                  </td>
                </tr>
                <tr>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      background: "#f2f2f2",
                      textAlign: "left",
                      verticalAlign: "top",
                    }}
                  >
                    出席者
                  </th>
                  <td
                    colSpan={3}
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      whiteSpace: "pre-wrap",
                      minHeight: "14mm",
                    }}
                  >
                    {printTarget.attendees ?? ""}
                  </td>
                </tr>
                <tr>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      background: "#f2f2f2",
                      textAlign: "left",
                      verticalAlign: "top",
                    }}
                  >
                    検討内容
                  </th>
                  <td
                    colSpan={3}
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      whiteSpace: "pre-wrap",
                      height: "80mm",
                      verticalAlign: "top",
                    }}
                  >
                    {printTarget.agenda ?? ""}
                  </td>
                </tr>
                <tr>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      background: "#f2f2f2",
                      textAlign: "left",
                      verticalAlign: "top",
                    }}
                  >
                    結論
                  </th>
                  <td
                    colSpan={3}
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      whiteSpace: "pre-wrap",
                      height: "50mm",
                      verticalAlign: "top",
                    }}
                  >
                    {printTarget.conclusion ?? ""}
                  </td>
                </tr>
                <tr>
                  <th
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      background: "#f2f2f2",
                      textAlign: "left",
                      verticalAlign: "top",
                    }}
                  >
                    備考
                  </th>
                  <td
                    colSpan={3}
                    style={{
                      border: "1pt solid #333",
                      padding: "2mm",
                      whiteSpace: "pre-wrap",
                      height: "24mm",
                      verticalAlign: "top",
                    }}
                  >
                    {printTarget.notes ?? ""}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
