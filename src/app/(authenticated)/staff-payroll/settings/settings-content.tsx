"use client";

/**
 * パート給与 設定 — サービス類型 (時給) と、実績 service_type → 類型 の割当 (事業所別)。
 * kaigo_wage_categories / kaigo_service_wage_mappings を CRUD する。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Plus, Trash2, Tag } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";

interface Category {
  id: string;
  name: string;
  hourly_rate: number;
  sort_order: number;
  is_active: boolean;
}

const isMissing = (code?: string) =>
  code === "42P01" || code === "PGRST205" || code === "42703";

export function WageSettingsContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice } = useBusinessType();
  const officeId = currentOffice?.id ?? null;

  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [mappings, setMappings] = useState<Map<string, string | null>>(new Map());
  const [serviceTypes, setServiceTypes] = useState<string[]>([]);

  // 手当設定
  const [cancelUnitPrice, setCancelUnitPrice] = useState<string>("0");
  const [allowanceMissing, setAllowanceMissing] = useState(false);
  const [partStaff, setPartStaff] = useState<
    { id: string; name: string; socialInsurance: boolean }[]
  >([]);

  // 新規類型フォーム
  const [newName, setNewName] = useState("");
  const [newRate, setNewRate] = useState("");

  const load = useCallback(async () => {
    if (!officeId) return;
    setLoading(true);
    try {
      const { data: cats, error: ce } = await supabase
        .from("kaigo_wage_categories")
        .select("id, name, hourly_rate, sort_order, is_active")
        .eq("office_id", officeId)
        .order("sort_order")
        .order("name");
      if (ce) {
        if (isMissing(ce.code)) {
          setMissing(true);
          setLoading(false);
          return;
        }
        throw new Error(ce.message);
      }
      setMissing(false);
      setCategories((cats ?? []) as Category[]);

      const { data: maps } = await supabase
        .from("kaigo_service_wage_mappings")
        .select("service_type, category_id")
        .eq("office_id", officeId);
      const mm = new Map<string, string | null>();
      for (const m of (maps ?? []) as {
        service_type: string;
        category_id: string | null;
      }[]) {
        mm.set(m.service_type, m.category_id);
      }
      setMappings(mm);

      // 実績に出現する service_type (割当候補)
      const { data: sch } = await supabase
        .from("kaigo_visit_schedule")
        .select("service_type")
        .eq("office_id", officeId)
        .limit(5000);
      const set = new Set<string>();
      for (const r of (sch ?? []) as { service_type: string | null }[]) {
        if (r.service_type) set.add(r.service_type);
      }
      for (const k of mm.keys()) set.add(k);
      setServiceTypes([...set].sort((a, b) => a.localeCompare(b, "ja")));

      // ── 手当設定 (v2) ──
      const { data: os, error: oe } = await supabase
        .from("kaigo_payroll_office_settings")
        .select("cancel_unit_price")
        .eq("office_id", officeId)
        .maybeSingle();
      if (oe && isMissing(oe.code)) {
        setAllowanceMissing(true);
      } else {
        setAllowanceMissing(false);
        setCancelUnitPrice(String((os as { cancel_unit_price?: number } | null)?.cancel_unit_price ?? 0));

        // 自事業所のパート職員
        const { data: mem } = await supabase
          .from("members")
          .select("id, name, furigana, employment_type, member_offices!inner(office_id)")
          .eq("employment_type", "パート")
          .eq("member_offices.office_id", officeId)
          .eq("status", "active")
          .is("deleted_at", null);
        const members = (mem ?? []) as { id: string; name: string }[];
        const ids = members.map((m) => m.id);
        const siMap = new Map<string, boolean>();
        if (ids.length > 0) {
          const { data: ss } = await supabase
            .from("kaigo_payroll_staff_settings")
            .select("member_id, social_insurance")
            .in("member_id", ids);
          for (const s of (ss ?? []) as {
            member_id: string;
            social_insurance: boolean;
          }[]) {
            siMap.set(s.member_id, s.social_insurance);
          }
        }
        setPartStaff(
          members
            .map((m) => ({
              id: m.id,
              name: m.name,
              socialInsurance: siMap.get(m.id) ?? false,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "ja")),
        );
      }
    } catch (e) {
      toast.error("設定の取得に失敗: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [supabase, officeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 事業所変更時の fetch
    load();
  }, [load]);

  const addCategory = async () => {
    if (!officeId) return;
    const name = newName.trim();
    if (!name) {
      toast.warning("類型名を入力してください");
      return;
    }
    const rate = Number(newRate);
    if (!Number.isFinite(rate) || rate < 0) {
      toast.warning("時給は 0 以上の数値で入力してください");
      return;
    }
    const { error } = await supabase.from("kaigo_wage_categories").insert({
      office_id: officeId,
      name,
      hourly_rate: Math.round(rate),
      sort_order: categories.length,
    });
    if (error) {
      toast.error("追加に失敗: " + error.message);
      return;
    }
    setNewName("");
    setNewRate("");
    toast.success(`類型「${name}」を追加しました`);
    load();
  };

  const updateCategory = async (
    id: string,
    patch: Partial<Pick<Category, "name" | "hourly_rate" | "is_active">>,
  ) => {
    const { error } = await supabase
      .from("kaigo_wage_categories")
      .update(patch)
      .eq("id", id);
    if (error) {
      toast.error("更新に失敗: " + error.message);
      return;
    }
    setCategories((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
  };

  const deleteCategory = async (id: string, name: string) => {
    if (!window.confirm(`類型「${name}」を削除しますか？ (割当も解除されます)`)) return;
    const { error } = await supabase
      .from("kaigo_wage_categories")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error("削除に失敗: " + error.message);
      return;
    }
    toast.success("削除しました");
    load();
  };

  const setMapping = async (serviceType: string, categoryId: string | null) => {
    if (!officeId) return;
    const { error } = await supabase
      .from("kaigo_service_wage_mappings")
      .upsert(
        { office_id: officeId, service_type: serviceType, category_id: categoryId },
        { onConflict: "office_id,service_type" },
      );
    if (error) {
      toast.error("割当の保存に失敗: " + error.message);
      return;
    }
    setMappings((prev) => new Map(prev).set(serviceType, categoryId));
  };

  const saveCancelUnitPrice = async () => {
    if (!officeId) return;
    const price = Math.round(Number(cancelUnitPrice));
    if (!Number.isFinite(price) || price < 0) {
      toast.warning("キャンセル単価は 0 以上の数値で入力してください");
      return;
    }
    const { error } = await supabase
      .from("kaigo_payroll_office_settings")
      .upsert(
        { office_id: officeId, cancel_unit_price: price },
        { onConflict: "office_id" },
      );
    if (error) {
      toast.error("キャンセル単価の保存に失敗: " + error.message);
      return;
    }
    toast.success("キャンセル単価を保存しました");
  };

  const toggleSocialInsurance = async (memberId: string, value: boolean) => {
    const { error } = await supabase
      .from("kaigo_payroll_staff_settings")
      .upsert(
        { member_id: memberId, social_insurance: value },
        { onConflict: "member_id" },
      );
    if (error) {
      toast.error("社会保険の保存に失敗: " + error.message);
      return;
    }
    setPartStaff((prev) =>
      prev.map((p) => (p.id === memberId ? { ...p, socialInsurance: value } : p)),
    );
  };

  if (!officeId) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 text-center text-sm text-gray-500">
        事業所を選択してください。
      </div>
    );
  }

  const unassignedCount = serviceTypes.filter(
    (s) => !mappings.get(s),
  ).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <Link
          href="/staff-payroll"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft size={15} /> パート給与
        </Link>
        <span className="text-gray-300">/</span>
        <h1 className="flex items-center gap-1.5 text-lg font-bold text-gray-900">
          <Tag size={18} className="text-indigo-600" /> 時給・サービス類型 設定
        </h1>
        <span className="text-xs text-gray-500">（{currentOffice?.name}）</span>
      </div>

      {missing ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          設定テーブルが未作成です。
          <code className="mx-1 rounded bg-amber-100 px-1">
            migrations/kaigo_part_time_wage_v1.sql
          </code>
          を適用してください。
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
          <Loader2 className="animate-spin" size={20} /> 読込中…
        </div>
      ) : (
        <div className="space-y-6">
          {/* ① サービス類型 (時給) */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-gray-800">
              ① サービス類型と時給
            </h2>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-600">
                    <th className="px-3 py-1.5 text-left">類型名</th>
                    <th className="px-3 py-1.5 text-right">時給 (円/時)</th>
                    <th className="px-3 py-1.5 text-center">有効</th>
                    <th className="px-3 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="px-3 py-1.5">
                        <input
                          defaultValue={c.name}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== c.name) updateCategory(c.id, { name: v });
                          }}
                          className="w-full rounded border px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          type="number"
                          defaultValue={c.hourly_rate}
                          onBlur={(e) => {
                            const v = Math.round(Number(e.target.value));
                            if (Number.isFinite(v) && v >= 0 && v !== c.hourly_rate)
                              updateCategory(c.id, { hourly_rate: v });
                          }}
                          className="w-28 rounded border px-2 py-1 text-right font-mono"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={c.is_active}
                          onChange={(e) =>
                            updateCategory(c.id, { is_active: e.target.checked })
                          }
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => deleteCategory(c.id, c.name)}
                          className="text-gray-400 hover:text-red-600"
                          title="削除"
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {categories.length === 0 && (
                    <tr className="border-t">
                      <td colSpan={4} className="px-3 py-4 text-center text-gray-400">
                        類型がまだありません。下で追加してください。
                      </td>
                    </tr>
                  )}
                  {/* 新規追加 */}
                  <tr className="border-t bg-gray-50">
                    <td className="px-3 py-1.5">
                      <input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="例: 身体介護"
                        className="w-full rounded border px-2 py-1"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <input
                        type="number"
                        value={newRate}
                        onChange={(e) => setNewRate(e.target.value)}
                        placeholder="1500"
                        className="w-28 rounded border px-2 py-1 text-right font-mono"
                      />
                    </td>
                    <td></td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={addCategory}
                        className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
                      >
                        <Plus size={14} /> 追加
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* ② サービス割当 */}
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-gray-800">
              ② サービス → 類型 の割当
              {unassignedCount > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                  未割当 {unassignedCount}
                </span>
              )}
            </h2>
            <p className="mb-2 text-xs text-gray-500">
              実績 (kaigo_visit_schedule) に出現するサービス名ごとに、時給の類型を割り当てます。未割当のサービスは給与に計上されません。
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-600">
                    <th className="px-3 py-1.5 text-left">サービス名 (実績の値)</th>
                    <th className="px-3 py-1.5 text-left">類型 (時給)</th>
                  </tr>
                </thead>
                <tbody>
                  {serviceTypes.map((st) => {
                    const catId = mappings.get(st) ?? "";
                    return (
                      <tr key={st} className="border-t">
                        <td className="px-3 py-1.5 font-mono text-gray-800">{st}</td>
                        <td className="px-3 py-1.5">
                          <select
                            value={catId ?? ""}
                            onChange={(e) =>
                              setMapping(st, e.target.value || null)
                            }
                            className={`rounded border px-2 py-1 ${
                              catId ? "" : "border-amber-300 bg-amber-50"
                            }`}
                          >
                            <option value="">（未割当）</option>
                            {categories
                              .filter((c) => c.is_active)
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}（{c.hourly_rate.toLocaleString()}円）
                                </option>
                              ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                  {serviceTypes.length === 0 && (
                    <tr className="border-t">
                      <td colSpan={2} className="px-3 py-4 text-center text-gray-400">
                        この事業所の実績にサービスがまだありません。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ③ 手当設定 (キャンセル・通信) */}
          <section>
            <h2 className="mb-2 text-sm font-bold text-gray-800">③ 手当設定</h2>
            {allowanceMissing ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                手当設定テーブルが未作成です。
                <code className="mx-1 rounded bg-amber-100 px-1">
                  migrations/kaigo_part_time_wage_v2_allowances.sql
                </code>
                を適用してください。
              </div>
            ) : (
              <div className="space-y-4">
                {/* キャンセル単価 */}
                <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm">
                  <span className="font-medium text-gray-700">キャンセル手当 単価</span>
                  <input
                    type="number"
                    value={cancelUnitPrice}
                    onChange={(e) => setCancelUnitPrice(e.target.value)}
                    className="w-28 rounded border px-2 py-1 text-right font-mono"
                  />
                  <span className="text-gray-500">円 / 件</span>
                  <button
                    type="button"
                    onClick={saveCancelUnitPrice}
                    className="ml-1 rounded bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
                  >
                    保存
                  </button>
                  <span className="text-xs text-gray-400">
                    キャンセル手当 = キャンセル件数 × 単価
                  </span>
                </div>

                {/* 社会保険 (通信手当) */}
                <div>
                  <div className="mb-1 text-xs text-gray-500">
                    通信手当は社保<span className="font-semibold">未加入</span>の職員のみ支給（実働50h超=1000円 / 0h超=500円）。加入者はチェックを入れてください。
                  </div>
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[360px] text-sm">
                      <thead>
                        <tr className="bg-gray-50 text-gray-600">
                          <th className="px-3 py-1.5 text-left">パート職員</th>
                          <th className="px-3 py-1.5 text-center">社会保険 加入</th>
                        </tr>
                      </thead>
                      <tbody>
                        {partStaff.map((p) => (
                          <tr key={p.id} className="border-t">
                            <td className="px-3 py-1.5 text-gray-800">{p.name}</td>
                            <td className="px-3 py-1.5 text-center">
                              <input
                                type="checkbox"
                                checked={p.socialInsurance}
                                onChange={(e) =>
                                  toggleSocialInsurance(p.id, e.target.checked)
                                }
                              />
                            </td>
                          </tr>
                        ))}
                        {partStaff.length === 0 && (
                          <tr className="border-t">
                            <td colSpan={2} className="px-3 py-4 text-center text-gray-400">
                              この事業所のパート職員がいません。
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
