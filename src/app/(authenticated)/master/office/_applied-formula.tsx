"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { validToday } from "@/lib/service-code-valid";

// ─── 適用加算 (事業所単位の処遇改善加算等の選択) ───────────────────────────
// 旧: settings/page.tsx (currentOffice 依存) → 自事業所管理の編集フォームに移設。
// 編集対象の officeId / tenantId / serviceType を props で受ける。
interface FormulaCandidate {
  service_code: string;
  service_category: string;
  service_name: string;
  system: string; // "介護" | "障害"
  formula: { type: string; numerator?: number; denominator?: number } | null;
}

interface AppliedFormulaProps {
  officeId: string;
  tenantId: string;
  serviceType: string | null;
}

export function AppliedFormulaSection({ officeId, tenantId, serviceType }: AppliedFormulaProps) {
  const supabase = useMemo(() => createClient(), []);
  const [formulaCodes, setFormulaCodes] = useState<FormulaCandidate[]>([]);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [savedCodes, setSavedCodes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // 編集対象事業所の category prefix を service_type から判定
  const officeCategory = useMemo(() => {
    const t = serviceType ?? "";
    if (t === "訪問介護") return "11";
    if (t === "訪問入浴介護") return "12";
    if (t === "訪問看護") return "13";
    if (t === "訪問リハビリテーション") return "14";
    if (t === "通所介護") return "15";
    if (t === "通所リハビリテーション") return "16";
    if (t === "短期入所生活介護") return "21";
    if (t === "居宅介護支援") return "43";
    return null;
  }, [serviceType]);

  // 当該 category の formula コードを fetch
  useEffect(() => {
    if (!officeCategory) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 依存変更で初期化
      setFormulaCodes([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      // 有効期間: 今日時点で有効な世代のみ (改定跨ぎの同一コード複数世代ヒット防止)
      const kaigoQ = validToday(
        supabase
          .from("kaigo_service_codes")
          .select("service_code, service_category, service_name, system, formula")
          .eq("system", "介護")
          .eq("service_category", officeCategory)
          .not("formula", "is", null),
      ).order("service_code");
      // 障害福祉 (居宅介護=11 / 重度訪問介護=12) は訪問介護事業所のみ候補に含める
      const shogaiQ =
        officeCategory === "11"
          ? validToday(
              supabase
                .from("kaigo_service_codes")
                .select("service_code, service_category, service_name, system, formula")
                .eq("system", "障害")
                .in("service_category", ["11", "12"])
                .not("formula", "is", null),
            ).order("service_code")
          : null;
      const [kaigoRes, shogaiRes] = await Promise.all([
        kaigoQ,
        shogaiQ ?? Promise.resolve({ data: [] as FormulaCandidate[] }),
      ]);
      if (!cancelled) {
        setFormulaCodes([
          ...((kaigoRes.data ?? []) as FormulaCandidate[]),
          ...((shogaiRes.data ?? []) as FormulaCandidate[]),
        ]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, officeCategory]);

  // 編集対象事業所の applied_formula_codes を supabase から読込 (currentOffice 非依存)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("offices")
        .select("applied_formula_codes")
        .eq("id", officeId)
        .single();
      if (cancelled) return;
      if (error) {
        toast.error("適用加算の読込に失敗: " + error.message);
        return;
      }
      const codes =
        (data as { applied_formula_codes?: string[] } | null)?.applied_formula_codes ?? [];
      setApplied(new Set(codes));
      setSavedCodes(codes);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, officeId]);

  const toggle = (code: string) => {
    setApplied((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const arr = Array.from(applied);
      const { error } = await supabase
        .from("offices")
        .update({ applied_formula_codes: arr })
        .eq("id", officeId);
      if (error) throw error;
      setSavedCodes(arr);
      toast.success("適用加算を保存しました (画面再読込で反映)");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("保存に失敗: " + msg);
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    JSON.stringify(Array.from(applied).sort()) !==
    JSON.stringify([...savedCodes].sort());

  const kaigoCodes = formulaCodes.filter((f) => f.system !== "障害");
  const shogaiCodes = formulaCodes.filter((f) => f.system === "障害");

  const renderList = (list: FormulaCandidate[]) => (
    <ul className="divide-y divide-gray-100">
      {list.map((f) => {
        const pct =
          f.formula?.type === "monthly_aggregate" && f.formula.numerator && f.formula.denominator
            ? ((f.formula.numerator / f.formula.denominator) * 100).toFixed(1).replace(/\.0$/, "")
            : null;
        return (
          <li key={f.service_code}>
            <label className="flex items-center gap-2 py-2 cursor-pointer hover:bg-gray-50 rounded px-2">
              <input
                type="checkbox"
                checked={applied.has(f.service_code)}
                onChange={() => toggle(f.service_code)}
                className="accent-blue-600"
              />
              <span className="flex-1 text-sm text-gray-800">
                {f.service_name}
              </span>
              {pct && (
                <span className="text-xs text-purple-600 font-medium">月計 × {pct}%</span>
              )}
              <span className="text-[10px] text-gray-400 font-mono">{f.service_code}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="rounded-xl border bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-sm font-bold text-gray-700">適用加算 (事業所単位)</h2>
          <p className="text-xs text-gray-500 mt-1">
            この事業所が取得している加算 (処遇改善等) を選択。サービス提供表 (実績) で月計から自動計算されます。
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? "保存中..." : dirty ? "変更を保存" : "保存済"}
        </button>
      </div>
      {!officeCategory ? (
        <p className="text-sm text-gray-500 py-4">
          この事業所の service_type ({serviceType || "未設定"}) に対応する加算がありません
        </p>
      ) : loading ? (
        <p className="text-sm text-gray-400 py-4">読込中...</p>
      ) : formulaCodes.length === 0 ? (
        <p className="text-sm text-gray-500 py-4">
          サービス種類 ({serviceType}) に該当する加算 (formula 系) はマスタにありません
        </p>
      ) : (
        <div className="mt-2 space-y-4">
          <section>
            <h3 className="text-xs font-semibold text-gray-600 bg-gray-50 rounded px-2 py-1 mb-1">
              介護保険の加算 ({serviceType || "介護"})
            </h3>
            {kaigoCodes.length === 0 ? (
              <p className="text-sm text-gray-400 py-1 px-2">該当する加算はありません</p>
            ) : (
              renderList(kaigoCodes)
            )}
          </section>
          {shogaiCodes.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-600 bg-gray-50 rounded px-2 py-1 mb-1">
                障害福祉の加算 (居宅介護・重度訪問介護)
              </h3>
              {renderList(shogaiCodes)}
            </section>
          )}
        </div>
      )}
      <AddonPeriodsBlock
        candidates={formulaCodes}
        officeId={officeId}
        tenantId={tenantId}
        serviceType={serviceType}
      />
    </div>
  );
}

// ─── 適用加算の期間指定 (期中の区分変更を月単位で管理) ─────────────────────
interface AddonPeriodRow {
  id: string;
  formula_code: string;
  start_month: string | null;
  end_month: string | null;
  notes: string | null;
}

function AddonPeriodsBlock({
  candidates,
  officeId,
  tenantId,
  serviceType,
}: {
  candidates: FormulaCandidate[];
  officeId: string;
  tenantId: string;
  serviceType: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [periods, setPeriods] = useState<AddonPeriodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tableMissing, setTableMissing] = useState(false);

  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of candidates) m.set(c.service_code, c.service_name);
    return m;
  }, [candidates]);

  // 登録済み行を code の system で振り分け (候補に無い code は介護保険側に出す)
  const shogaiCodeSet = useMemo(
    () => new Set(candidates.filter((c) => c.system === "障害").map((c) => c.service_code)),
    [candidates],
  );
  const kaigoCandidates = candidates.filter((c) => c.system !== "障害");
  const shogaiCandidates = candidates.filter((c) => c.system === "障害");
  const kaigoRows = periods.filter((p) => !shogaiCodeSet.has(p.formula_code));
  const shogaiRows = periods.filter((p) => shogaiCodeSet.has(p.formula_code));

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("kaigo_office_addon_periods")
      .select("id, formula_code, start_month, end_month, notes")
      .eq("office_id", officeId)
      .order("start_month", { ascending: true, nullsFirst: true });
    if (error) {
      // テーブル未作成 (42P01 / PGRST205) → 表示して続行 (それ以外は toast)
      if (error.code === "42P01" || error.code === "PGRST205") {
        setTableMissing(true);
      } else {
        toast.error("期間指定の読込に失敗: " + error.message);
      }
      setPeriods([]);
      setLoading(false);
      return;
    }
    setTableMissing(false);
    setPeriods((data ?? []) as AddonPeriodRow[]);
    setLoading(false);
  }, [supabase, officeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (依存変更で再読込)
    load();
  }, [load]);

  const handleAdd = async (code: string, start: string, end: string): Promise<boolean> => {
    const { error } = await supabase.from("kaigo_office_addon_periods").insert({
      office_id: officeId,
      formula_code: code,
      start_month: start || null,
      end_month: end || null,
      tenant_id: tenantId,
    });
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") {
        setTableMissing(true);
        toast.error("テーブル (kaigo_office_addon_periods) が未作成です");
      } else {
        toast.error("追加に失敗: " + error.message);
      }
      return false;
    }
    toast.success("期間指定を追加しました");
    await load();
    return true;
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase
      .from("kaigo_office_addon_periods")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error("削除に失敗: " + error.message);
      return;
    }
    toast.success("期間指定を削除しました");
    await load();
  };

  return (
    <div className="mt-5 border-t pt-4">
      <h3 className="text-sm font-semibold text-gray-900">期間指定 (詳細)</h3>
      <p className="text-xs text-gray-500 mt-1 mb-3">
        期間指定があるとその月はこちらが優先されます。期中に処遇改善の区分を変更した場合に使います
        (例: 5月まで処遇改善Ⅱ・6月からⅡ2)。開始月・終了月が空欄の行は「最初から」「無期限」扱いです。
      </p>
      {tableMissing ? (
        <p className="text-sm text-amber-700 bg-amber-50 rounded px-3 py-2">
          テーブル (kaigo_office_addon_periods) が未作成です。migration 適用後に利用できます。
        </p>
      ) : loading ? (
        <p className="text-sm text-gray-400 py-2">読込中...</p>
      ) : (
        <div className="space-y-5">
          <AddonPeriodGroup
            title={`介護保険 (${serviceType || "介護"})`}
            candidates={kaigoCandidates}
            rows={kaigoRows}
            nameByCode={nameByCode}
            onAdd={handleAdd}
            onDelete={handleDelete}
          />
          {shogaiCandidates.length > 0 && (
            <AddonPeriodGroup
              title="障害福祉 (居宅介護・重度訪問介護)"
              candidates={shogaiCandidates}
              rows={shogaiRows}
              nameByCode={nameByCode}
              onAdd={handleAdd}
              onDelete={handleDelete}
            />
          )}
        </div>
      )}
    </div>
  );
}

// 期間指定の1グループ (介護保険 / 障害福祉)。追加フォームの state はグループごとに持つ
function AddonPeriodGroup({
  title,
  candidates,
  rows,
  nameByCode,
  onAdd,
  onDelete,
}: {
  title: string;
  candidates: FormulaCandidate[];
  rows: AddonPeriodRow[];
  nameByCode: Map<string, string>;
  onAdd: (code: string, start: string, end: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [newCode, setNewCode] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!newCode) {
      toast.error("加算コードを選択してください");
      return;
    }
    if (newStart && newEnd && newStart > newEnd) {
      toast.error("開始月が終了月より後になっています");
      return;
    }
    setAdding(true);
    const ok = await onAdd(newCode, newStart, newEnd);
    setAdding(false);
    if (ok) {
      setNewCode("");
      setNewStart("");
      setNewEnd("");
    }
  };

  return (
    <section>
      <h4 className="text-xs font-semibold text-gray-600 bg-gray-50 rounded px-2 py-1 mb-2">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 py-1 mb-2">
          期間指定はありません (上のチェックの加算が常に適用されます)
        </p>
      ) : (
        <table className="w-full text-sm mb-3">
          <thead>
            <tr className="bg-gray-50 border-y">
              <th className="px-2 py-1.5 text-left text-xs text-gray-600">加算</th>
              <th className="px-2 py-1.5 text-left text-xs text-gray-600">開始月</th>
              <th className="px-2 py-1.5 text-left text-xs text-gray-600">終了月</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="px-2 py-1.5">
                  <span className="text-gray-800">
                    {nameByCode.get(p.formula_code) ?? p.formula_code}
                  </span>{" "}
                  <span className="text-[10px] text-gray-400 font-mono">{p.formula_code}</span>
                  {p.notes && (
                    <span className="ml-1 text-[10px] text-gray-400">({p.notes})</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-gray-700">{p.start_month ?? "最初から"}</td>
                <td className="px-2 py-1.5 text-gray-700">{p.end_month ?? "無期限"}</td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => onDelete(p.id)}
                    className="text-xs text-red-500 hover:text-red-700 inline-flex items-center gap-1"
                  >
                    <Trash2 size={12} /> 削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-gray-500">加算コード</span>
          <select
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            className="rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none max-w-xs"
          >
            <option value="">選択...</option>
            {candidates.map((c) => (
              <option key={c.service_code} value={c.service_code}>
                {c.service_name} ({c.service_code})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-gray-500">開始月 (空=最初から)</span>
          <input
            type="month"
            value={newStart}
            onChange={(e) => setNewStart(e.target.value)}
            className="rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-gray-500">終了月 (空=無期限)</span>
          <input
            type="month"
            value={newEnd}
            onChange={(e) => setNewEnd(e.target.value)}
            className="rounded border px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={handleAdd}
          disabled={adding || !newCode}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 inline-flex items-center gap-1"
        >
          <Plus size={14} /> {adding ? "追加中..." : "行追加"}
        </button>
      </div>
    </section>
  );
}
