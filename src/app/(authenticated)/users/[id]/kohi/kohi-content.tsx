"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { AlertTriangle, FileCheck, Pencil, Plus, Save, Trash2, X } from "lucide-react";

/**
 * 公費 (生活保護等) 管理タブ — client_kohi_records の一覧 + 追加/編集/削除。
 *
 * 旧: 介護認定タブ内の kohi_* 1 組 (client_insurance_records)。
 * ほのぼのNEXT互換で独立管理化し、複数公費・期間履歴・給付順位・本人支払額に対応。
 * 請求側は lib/kohi.ts の resolveKohiForMonth が「対象月に有効な優先 1 件」を採用する。
 */

// ─── 型 ──────────────────────────────────────────────────────────────────────

export type KohiRecord = {
  id: string;
  tenant_id: string;
  client_id: string;
  kohi_hobetsu: string;
  futansha_number: string | null;
  jukyusha_number: string | null;
  start_date: string | null;
  end_date: string | null;
  priority: number;
  honnin_futan: number;
  notes: string | null;
};

// 法別番号の既知コード (プルダウン)。これ以外は「その他」で手入力
const HOBETSU_OPTIONS: { code: string; label: string }[] = [
  { code: "12", label: "12: 生活保護" },
  { code: "25", label: "25: 中国残留邦人等" },
  { code: "10", label: "10: 感染症 (結核)" },
  { code: "21", label: "21: 精神通院医療" },
  { code: "54", label: "54: 難病" },
  { code: "19", label: "19: 被爆者" },
];
const KNOWN_HOBETSU = new Set(HOBETSU_OPTIONS.map((o) => o.code));

function hobetsuLabel(code: string): string {
  return HOBETSU_OPTIONS.find((o) => o.code === code)?.label ?? code;
}

type FormData = {
  hobetsuSelect: string; // 既知コード or "other"
  hobetsuCustom: string; // "other" のときの手入力値
  futansha_number: string;
  jukyusha_number: string;
  start_date: string;
  end_date: string;
  priority: string;
  honnin_futan: string;
  notes: string;
};

const EMPTY_FORM: FormData = {
  hobetsuSelect: "12",
  hobetsuCustom: "",
  futansha_number: "",
  jukyusha_number: "",
  start_date: "",
  end_date: "",
  priority: "1",
  honnin_futan: "0",
  notes: "",
};

function recToForm(rec: KohiRecord): FormData {
  const known = KNOWN_HOBETSU.has(rec.kohi_hobetsu);
  return {
    hobetsuSelect: known ? rec.kohi_hobetsu : "other",
    hobetsuCustom: known ? "" : rec.kohi_hobetsu,
    futansha_number: rec.futansha_number ?? "",
    jukyusha_number: rec.jukyusha_number ?? "",
    start_date: rec.start_date ?? "",
    end_date: rec.end_date ?? "",
    priority: String(rec.priority ?? 1),
    honnin_futan: String(rec.honnin_futan ?? 0),
    notes: rec.notes ?? "",
  };
}

function formHobetsu(form: FormData): string {
  return (form.hobetsuSelect === "other" ? form.hobetsuCustom : form.hobetsuSelect).trim();
}

function formatDate(d: string | null) {
  if (!d) return "";
  try {
    return format(parseISO(d), "yyyy/MM/dd");
  } catch {
    return d;
  }
}

/** 期間の重なり判定 (NULL は開放区間扱い) */
function periodsOverlap(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null,
): boolean {
  const s1 = aStart ?? "0000-01-01";
  const e1 = aEnd ?? "9999-12-31";
  const s2 = bStart ?? "0000-01-01";
  const e2 = bEnd ?? "9999-12-31";
  return s1 <= e2 && s2 <= e1;
}

// ─── スタイル定数 (care-cert と揃える) ─────────────────────────────────────────

const inp =
  "w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white";
const labelCls = "block text-xs text-gray-600 mb-0.5";

// ─── メインコンポーネント ──────────────────────────────────────────────────────

export function KohiContent({
  userId,
  initialRecords,
  tableMissing,
  loadError,
}: {
  userId: string;
  initialRecords: KohiRecord[];
  tableMissing: boolean;
  loadError: string | null;
}) {
  const supabase = createClient();

  const [records, setRecords] = useState<KohiRecord[]>(initialRecords);
  // editingId: null = フォーム非表示 / "new" = 新規 / それ以外 = 編集対象 id
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const setField = <K extends keyof FormData>(key: K, value: FormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // ── 再取得 (mutation 後) ───────────────────────────────────────────────────
  const fetchRecords = async () => {
    const { data, error } = await supabase
      .from("client_kohi_records")
      .select("*")
      .eq("client_id", userId)
      .order("priority", { ascending: true })
      .order("start_date", { ascending: false, nullsFirst: false });
    if (error) {
      console.error("公費情報の取得に失敗:", error.message);
      toast.error(`公費情報の取得に失敗: ${error.message}`);
      return;
    }
    setRecords((data ?? []) as KohiRecord[]);
  };

  // ── 期間重複の注意 (同一法別で期間が重なる。保存はブロックしない) ────────────
  const overlapWarning = useMemo(() => {
    if (editingId === null) return null;
    const hobetsu = formHobetsu(form);
    if (!hobetsu) return null;
    const others = records.filter(
      (r) => r.id !== editingId && r.kohi_hobetsu === hobetsu,
    );
    const hit = others.find((r) =>
      periodsOverlap(form.start_date || null, form.end_date || null, r.start_date, r.end_date),
    );
    if (!hit) return null;
    return `同一法別 (${hobetsu}) で期間が重なるレコードがあります (${formatDate(hit.start_date) || "開始なし"} 〜 ${formatDate(hit.end_date) || "継続"})。給付順位・期間を確認してください (保存は可能です)。`;
  }, [editingId, form, records]);

  // ── 保存 (新規 INSERT / 既存 UPDATE) ──────────────────────────────────────
  const handleSave = async () => {
    const hobetsu = formHobetsu(form);
    if (!hobetsu) {
      toast.error("法別番号は必須です");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        kohi_hobetsu: hobetsu,
        futansha_number: form.futansha_number.trim() || null,
        jukyusha_number: form.jukyusha_number.trim() || null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        priority: Number(form.priority) || 1,
        honnin_futan: Number(form.honnin_futan) || 0,
        notes: form.notes.trim() || null,
      };

      if (editingId && editingId !== "new") {
        const { error } = await supabase
          .from("client_kohi_records")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", editingId);
        if (error) throw error;
        toast.success("保存しました");
      } else {
        // tenant_id は clients から補完 (client_kohi_records.tenant_id NOT NULL)
        const { data: clientRow, error: clientErr } = await supabase
          .from("clients")
          .select("tenant_id")
          .eq("id", userId)
          .single();
        if (clientErr) throw clientErr;
        payload.tenant_id = clientRow?.tenant_id ?? "kt-group";
        payload.client_id = userId;
        const { error } = await supabase
          .from("client_kohi_records")
          .insert(payload);
        if (error) throw error;
        toast.success("登録しました");
      }
      setEditingId(null);
      setForm(EMPTY_FORM);
      await fetchRecords();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("公費の保存に失敗:", msg);
      toast.error(`保存に失敗しました: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  // ── 削除 ──────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!confirm("この公費情報を削除しますか？")) return;
    const { error } = await supabase
      .from("client_kohi_records")
      .delete()
      .eq("id", id);
    if (error) {
      console.error("公費の削除に失敗:", error.message);
      toast.error(`削除に失敗しました: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    if (editingId === id) {
      setEditingId(null);
      setForm(EMPTY_FORM);
    }
    await fetchRecords();
  };

  // ── レンダリング ──────────────────────────────────────────────────────────

  return (
    <div className="rounded-b-lg border border-t-0 bg-white shadow-sm">
      {/* テーブル未作成バナー */}
      {tableMissing && (
        <div className="m-4 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">公費テーブル (client_kohi_records) が未作成です</p>
            <p className="mt-0.5">
              <code className="rounded bg-amber-100 px-1">migrations/client_kohi_records.sql</code>{" "}
              を Supabase SQL Editor で実行してください (既存の介護認定タブの公費情報も自動移行されます)。
              適用までの間、請求側は旧方式 (介護認定レコードの公費欄) で動作します。
            </p>
          </div>
        </div>
      )}
      {loadError && (
        <div className="m-4 rounded border border-red-300 bg-red-50 p-3 text-xs text-red-700">
          公費情報の取得に失敗しました: {loadError}
        </div>
      )}

      {/* ヘッダー */}
      <div className="bg-gray-100 border-b border-gray-200 px-4 py-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-700">
          公費 (生活保護等) 一覧 — 複数公費・期間履歴対応
        </span>
        <button
          onClick={() => {
            setEditingId("new");
            setForm(EMPTY_FORM);
          }}
          disabled={saving || tableMissing}
          className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40 transition-colors"
        >
          <Plus size={11} />
          追加
        </button>
      </div>

      {/* 一覧 */}
      {records.length === 0 ? (
        <div className="flex flex-col items-center py-10 text-gray-400">
          <FileCheck size={32} className="mb-2 opacity-30" />
          <p className="text-xs">公費情報がありません (該当する方だけ登録します)</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-600">
                <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">法別</th>
                <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">負担者番号</th>
                <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">受給者番号</th>
                <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium whitespace-nowrap">適用期間</th>
                <th className="border-b border-gray-200 px-3 py-1.5 text-center font-medium whitespace-nowrap">順位</th>
                <th className="border-b border-gray-200 px-3 py-1.5 text-right font-medium whitespace-nowrap">本人支払額/月</th>
                <th className="border-b border-gray-200 px-3 py-1.5 text-left font-medium">備考</th>
                <th className="border-b border-gray-200 px-2 py-1.5 text-center font-medium whitespace-nowrap w-16"></th>
              </tr>
            </thead>
            <tbody>
              {records.map((rec) => {
                const isEditing = rec.id === editingId;
                return (
                  <tr
                    key={rec.id}
                    className={`transition-colors ${isEditing ? "bg-blue-50 border-l-2 border-l-blue-500" : "hover:bg-gray-50"}`}
                  >
                    <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                      <span className="inline-block rounded bg-purple-100 px-1.5 py-0.5 text-xs font-medium text-purple-800">
                        {hobetsuLabel(rec.kohi_hobetsu)}
                      </span>
                    </td>
                    <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap font-mono text-gray-700">
                      {rec.futansha_number ?? "—"}
                    </td>
                    <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap font-mono text-gray-700">
                      {rec.jukyusha_number ?? "—"}
                    </td>
                    <td className="border-b border-gray-100 px-3 py-1.5 whitespace-nowrap text-gray-700">
                      {formatDate(rec.start_date) || "—"} 〜 {formatDate(rec.end_date) || "継続"}
                    </td>
                    <td className="border-b border-gray-100 px-3 py-1.5 text-center text-gray-700">
                      {rec.priority}
                    </td>
                    <td className="border-b border-gray-100 px-3 py-1.5 text-right text-gray-700">
                      {rec.honnin_futan > 0 ? `${rec.honnin_futan.toLocaleString()}円` : "なし"}
                    </td>
                    <td className="border-b border-gray-100 px-3 py-1.5 text-gray-500">
                      {rec.notes ?? ""}
                    </td>
                    <td className="border-b border-gray-100 px-2 py-1.5 text-center whitespace-nowrap">
                      <button
                        onClick={() => {
                          setEditingId(rec.id);
                          setForm(recToForm(rec));
                        }}
                        className="rounded p-1 text-blue-400 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                        title="編集"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => handleDelete(rec.id)}
                        className="rounded p-1 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                        title="削除"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 入力フォーム (追加 / 編集) */}
      {editingId !== null && (
        <div className="border-t border-gray-200">
          <div className="bg-gray-100 border-b border-gray-200 px-4 py-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">
              {editingId === "new" ? "公費 新規登録" : "公費 編集"}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_FORM);
                }}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
              >
                <X size={11} />
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                <Save size={11} />
                {editingId === "new" ? "登録" : "保存"}
              </button>
            </div>
          </div>

          <div className="p-4 space-y-3">
            {overlapWarning && (
              <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{overlapWarning}</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <label className={labelCls}>法別番号 (必須)</label>
                <select
                  value={form.hobetsuSelect}
                  onChange={(e) => setField("hobetsuSelect", e.target.value)}
                  className={inp}
                >
                  {HOBETSU_OPTIONS.map((o) => (
                    <option key={o.code} value={o.code}>{o.label}</option>
                  ))}
                  <option value="other">その他 (手入力)</option>
                </select>
                {form.hobetsuSelect === "other" && (
                  <input
                    type="text"
                    inputMode="numeric"
                    value={form.hobetsuCustom}
                    onChange={(e) =>
                      setField("hobetsuCustom", e.target.value.replace(/[^0-9]/g, "").slice(0, 2))
                    }
                    className={`${inp} mt-1`}
                    placeholder="法別番号 (2桁)"
                  />
                )}
              </div>
              <div>
                <label className={labelCls}>公費負担者番号 (8桁)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.futansha_number}
                  onChange={(e) =>
                    setField("futansha_number", e.target.value.replace(/[^0-9]/g, "").slice(0, 8))
                  }
                  className={inp}
                  placeholder="00000000"
                />
              </div>
              <div>
                <label className={labelCls}>公費受給者番号 (7桁)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.jukyusha_number}
                  onChange={(e) =>
                    setField("jukyusha_number", e.target.value.replace(/[^0-9]/g, "").slice(0, 7))
                  }
                  className={inp}
                  placeholder="0000000"
                />
              </div>
              <div>
                <label className={labelCls}>給付順位 (小さいほど優先)</label>
                <input
                  type="number"
                  min={1}
                  value={form.priority}
                  onChange={(e) => setField("priority", e.target.value)}
                  className={inp}
                />
              </div>
              <div>
                <label className={labelCls}>適用開始 (介護券の有効期間)</label>
                <input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => setField("start_date", e.target.value)}
                  className={inp}
                />
              </div>
              <div>
                <label className={labelCls}>適用終了 (空欄 = 継続)</label>
                <input
                  type="date"
                  value={form.end_date}
                  onChange={(e) => setField("end_date", e.target.value)}
                  className={inp}
                />
              </div>
              <div>
                <label className={labelCls}>本人支払額/月 (介護券記載。0 = なし)</label>
                <input
                  type="number"
                  min={0}
                  value={form.honnin_futan}
                  onChange={(e) => setField("honnin_futan", e.target.value)}
                  className={inp}
                />
              </div>
              <div>
                <label className={labelCls}>備考</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setField("notes", e.target.value)}
                  className={inp}
                />
              </div>
            </div>

            <p className="text-[10px] text-gray-500">
              請求 (訪問介護集計 / 居宅の様式第一・第七 / 国保連伝送) では、対象月に有効な公費のうち
              給付順位が最も小さい 1 件が使用されます。法別 12 (生活保護) は利用者負担分が公費請求へ
              振替えられます。複数公費の併用按分と本人支払額の金額反映は現状未対応です。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
