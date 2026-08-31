"use client";

/**
 * 勤務形態一覧表 (参考様式1)
 *
 * 2026-09-01 監査是正で新設。実地指導で**最初に提出を求められる**帳票。
 * 人員基準 (訪問介護のサ責は利用者 40 人に 1 人、居宅のケアマネは 35 人に 1 人 等) を
 * 常勤換算数で示すもの。監査で「置き場が無い 6 つ」の最後の 1 つだった。
 *
 * 新しいテーブルは作っていない。素材は既にある:
 *   氏名・職種・資格・雇用形態・入職日 … members
 *   事業所との紐付け・専従/兼務         … member_offices (件数が 2 以上なら兼務)
 *   週の所定勤務時間                    … members.weekly_scheduled_hours (今回追加)
 *   常勤の週所定時間                    … offices.fulltime_weekly_hours (今回追加、既定 40)
 *
 * 常勤換算数 = 週の勤務時間の合計 ÷ 常勤職員が勤務すべき週の時間数
 *
 * ⚠ 「32 時間を下回る場合は 32 として扱う」等の細則は自治体差があるため
 *   **システムでは丸めない**。素の計算値を出して判断は人に残す。
 *   誤った丸めをシステムが「正」としてしまうほうが危険。
 *
 * 保存先: migrations/staff_schedule_hours_v1.sql
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Loader2, Printer, Save, Users } from "lucide-react";
import { useBusinessType } from "@/lib/business-type-context";

type Member = {
  id: string;
  name: string;
  furigana: string | null;
  role: string | null;
  qualifications: string | null;
  employment_type: string | null;
  hire_date: string | null;
  status: string | null;
  weekly_scheduled_hours?: number | null;
};

const isMissingCol = (code?: string) => code === "42703" || code === "42P01" || code === "PGRST205";

export function StaffScheduleContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice } = useBusinessType();
  const officeId = currentOffice?.id ?? null;
  const officeName = currentOffice?.name ?? "";

  const [members, setMembers] = useState<Member[]>([]);
  const [multiOffice, setMultiOffice] = useState<Set<string>>(new Set());
  const [fullTimeHours, setFullTimeHours] = useState<number>(40);
  const [loading, setLoading] = useState(false);
  const [colMissing, setColMissing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!officeId) return;
    setLoading(true);
    setColMissing(false);

    // 1) 自事業所に紐づく職員 (member_offices 経由)
    const { data: mo, error: moErr } = await supabase
      .from("member_offices")
      .select("member_id")
      .eq("office_id", officeId);
    if (moErr) {
      setLoading(false);
      toast.error(`職員の取得に失敗しました: ${moErr.message}`);
      return;
    }
    const ids = Array.from(
      new Set(((mo ?? []) as { member_id: string }[]).map((r) => r.member_id)),
    );
    if (ids.length === 0) {
      setMembers([]);
      setLoading(false);
      return;
    }

    // 2) 兼務判定 = その職員が 2 事業所以上に紐づいているか
    const { data: allMo } = await supabase
      .from("member_offices")
      .select("member_id, office_id")
      .in("member_id", ids);
    const cnt = new Map<string, number>();
    for (const r of (allMo ?? []) as { member_id: string }[]) {
      cnt.set(r.member_id, (cnt.get(r.member_id) ?? 0) + 1);
    }
    setMultiOffice(new Set([...cnt.entries()].filter(([, n]) => n >= 2).map(([id]) => id)));

    // 3) 職員本体。weekly_scheduled_hours は migration 未適用だと 42703 になるので落として再取得
    const base = "id, name, furigana, role, qualifications, employment_type, hire_date, status";
    let rows: Member[] = [];
    const first = await supabase
      .from("members")
      .select(`${base}, weekly_scheduled_hours`)
      .in("id", ids)
      .is("deleted_at", null)
      .order("furigana", { nullsFirst: false });
    if (first.error) {
      if (!isMissingCol(first.error.code)) {
        setLoading(false);
        toast.error(`職員の取得に失敗しました: ${first.error.message}`);
        return;
      }
      setColMissing(true);
      const retry = await supabase
        .from("members")
        .select(base)
        .in("id", ids)
        .is("deleted_at", null)
        .order("furigana", { nullsFirst: false });
      if (retry.error) {
        setLoading(false);
        toast.error(`職員の取得に失敗しました: ${retry.error.message}`);
        return;
      }
      rows = (retry.data ?? []) as Member[];
    } else {
      rows = (first.data ?? []) as Member[];
    }
    // 退職者は一覧から外す (現在の体制を示す帳票なので)
    rows = rows.filter((m) => m.status !== "退職者");
    setMembers(rows);
    setDraft(
      Object.fromEntries(
        rows.map((m) => [m.id, m.weekly_scheduled_hours != null ? String(m.weekly_scheduled_hours) : ""]),
      ),
    );

    // 4) 常勤の週所定時間 (列が無ければ 40)
    const off = await supabase
      .from("offices")
      .select("fulltime_weekly_hours")
      .eq("id", officeId)
      .maybeSingle();
    if (!off.error) {
      const v = (off.data as { fulltime_weekly_hours: number | null } | null)?.fulltime_weekly_hours;
      setFullTimeHours(v != null && v > 0 ? Number(v) : 40);
    }
    setLoading(false);
  }, [supabase, officeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 事業所切替で読み直す
    load();
  }, [load]);

  const saveHours = async () => {
    if (colMissing) {
      toast.error("列が未作成のため保存できません (migration を適用してください)");
      return;
    }
    setSaving(true);
    let ok = 0;
    for (const m of members) {
      const raw = (draft[m.id] ?? "").trim();
      const next = raw === "" ? null : Number(raw);
      if (next != null && !Number.isFinite(next)) continue;
      if ((m.weekly_scheduled_hours ?? null) === next) continue;
      const { error } = await supabase
        .from("members")
        .update({ weekly_scheduled_hours: next })
        .eq("id", m.id);
      if (error) {
        setSaving(false);
        toast.error(`${m.name} の保存に失敗しました: ${error.message}`);
        return;
      }
      ok += 1;
    }
    setSaving(false);
    toast.success(ok > 0 ? `${ok} 名の勤務時間を保存しました` : "変更はありませんでした");
    if (ok > 0) load();
  };

  /** 常勤専従 / 常勤兼務 / 非常勤専従 / 非常勤兼務 */
  const kinmuKubun = (m: Member) => {
    const jokin = m.employment_type === "常勤" ? "常勤" : "非常勤";
    return `${jokin}${multiOffice.has(m.id) ? "兼務" : "専従"}`;
  };

  const totalHours = useMemo(
    () =>
      members.reduce((s, m) => {
        const v = Number(draft[m.id] ?? "");
        return s + (Number.isFinite(v) ? v : 0);
      }, 0),
    [members, draft],
  );
  const kansan = fullTimeHours > 0 ? totalHours / fullTimeHours : 0;
  const unfilled = members.filter((m) => !(draft[m.id] ?? "").trim()).length;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <h1 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Users size={16} /> 勤務形態一覧表
        </h1>
        <label className="text-xs text-gray-600">
          常勤の週所定時間{" "}
          <input
            type="number"
            step="0.5"
            value={fullTimeHours}
            onChange={(e) => setFullTimeHours(Number(e.target.value) || 40)}
            className="w-20 rounded border border-gray-300 px-2 py-1 text-xs"
          />
          <span className="ml-1 text-gray-400">時間</span>
        </label>
        <button
          type="button"
          onClick={saveHours}
          disabled={saving || colMissing}
          className="flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          {saving ? <Loader2 className="animate-spin" size={13} /> : <Save size={13} />} 勤務時間を保存
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="flex items-center gap-1 rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
        >
          <Printer size={13} /> 印刷
        </button>
      </div>

      {colMissing && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 print:hidden">
          ⚠ 勤務時間の列が未作成です。
          <code className="mx-1">migrations/staff_schedule_hours_v1.sql</code>
          を適用すると入力・保存できるようになります。
        </div>
      )}

      <div className="mb-3 text-sm text-gray-700">
        <span className="font-medium">{officeName}</span>
        <span className="ml-3 text-xs text-gray-500">
          常勤換算数{" "}
          <span className="text-base font-semibold text-gray-800">{kansan.toFixed(2)}</span>
          <span className="ml-1">
            （週 {totalHours.toFixed(1)} 時間 ÷ {fullTimeHours} 時間）
          </span>
        </span>
      </div>

      {unfilled > 0 && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          ⚠ 週の勤務時間が未入力の職員が {unfilled} 名います。その分は常勤換算数に含まれていません。
        </div>
      )}

      <p className="mb-4 rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600 print:hidden">
        常勤換算数 = 従業者の週の勤務時間の合計 ÷ 常勤職員が勤務すべき週の時間数。
        <br />
        <span className="text-gray-500">
          ⚠ 「32 時間を下回る場合は 32 として扱う」等の細則は自治体差があるため、
          この画面は<span className="font-medium">素の計算値を出すだけで丸めません</span>。
          提出前に自治体の様式・注意書きを確認してください。
        </span>
      </p>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-gray-300" size={28} />
        </div>
      ) : members.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
          この事業所に紐づく職員がいません
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-xs">
            <thead className="border-b border-gray-200 bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">氏名</th>
                <th className="px-3 py-2 text-left font-medium">職種</th>
                <th className="px-3 py-2 text-left font-medium">勤務形態</th>
                <th className="px-3 py-2 text-left font-medium">資格</th>
                <th className="px-3 py-2 text-left font-medium">入職日</th>
                <th className="px-3 py-2 text-right font-medium">週の勤務時間</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-gray-100">
                  <td className="whitespace-nowrap px-3 py-1.5 text-gray-800">{m.name}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">{m.role || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">{kinmuKubun(m)}</td>
                  <td className="px-3 py-1.5">{m.qualifications || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">{m.hire_date || "—"}</td>
                  <td className="px-3 py-1.5 text-right">
                    <input
                      type="number"
                      step="0.5"
                      disabled={colMissing}
                      value={draft[m.id] ?? ""}
                      onChange={(e) => setDraft({ ...draft, [m.id]: e.target.value })}
                      className="w-20 rounded border border-gray-300 px-2 py-0.5 text-right text-xs disabled:bg-gray-50"
                      placeholder="—"
                    />
                  </td>
                </tr>
              ))}
              <tr className="bg-gray-50 font-medium">
                <td className="px-3 py-2" colSpan={5}>
                  合計 {members.length} 名
                </td>
                <td className="px-3 py-2 text-right">{totalHours.toFixed(1)} 時間</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
