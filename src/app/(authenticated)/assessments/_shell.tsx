"use client";

import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { formKindForCareLevel, type KaigoFormKind } from "@/lib/yobo-kubun";
import {
  AssessmentsContent,
  type Assessment,
  type Certification,
  type KaigoUser,
} from "./assessments-content";
import { YoboContent, type YoboAssessment } from "./yobo/yobo-content";

// ─────────────────────────────────────────────────────────────────────────────
// アセスメントの単一入口。
//
// 「介護版 / 予防版」は操作者が選ぶものではなく認定期間の care_level で一意に
// 決まる (要介護 → 介護版 / 要支援・事業対象者 → 予防版) ので、メニューを 2 本に
// 分けず認定期間タブを様式のスイッチとして使う。
//
// 例外的に、認定区分と違う様式のレコードが実在する場合 (旧データ・取込み由来) は
// その組合せのときだけ「予防様式を表示」チップを出して到達できるようにする
// (= データを画面から消さないための安全弁)。
// ─────────────────────────────────────────────────────────────────────────────

export interface AssessmentsShellProps {
  userId: string;
  initialUser: KaigoUser | null;
  initialCertifications: Certification[];
  /** server が prefetch した組合せ (これと一致する間だけ initialAssessments を使える) */
  serverKind: KaigoFormKind;
  serverCertId: string | null;
  initialAssessments: Assessment[];
}

const comboKey = (certId: string | null, kind: KaigoFormKind) => `${certId ?? "_"}|${kind}`;

export function AssessmentsShell({
  userId,
  initialUser,
  initialCertifications,
  serverKind,
  serverCertId,
  initialAssessments,
}: AssessmentsShellProps) {
  const supabase = useMemo(() => createClient(), []);

  const [selectedCertId, setSelectedCertId] = useState<string | null>(serverCertId);
  // 認定区分から導出した様式に対する手動上書き。認定期間を切り替えたら解除する
  const [kindOverride, setKindOverride] = useState<KaigoFormKind | null>(null);

  const selectedCert = useMemo(
    () => initialCertifications.find((c) => c.id === selectedCertId) ?? null,
    [initialCertifications, selectedCertId],
  );
  const derivedKind = formKindForCareLevel(selectedCert?.care_level);
  const kind: KaigoFormKind = kindOverride ?? derivedKind;
  const otherKind: KaigoFormKind = kind === "kaigo" ? "yobo" : "kaigo";

  // (認定期間 × 様式) にレコードが存在するかの索引。
  // 認定区分と違う様式のデータが残っている組合せを検出して切替チップを出すためだけに使う。
  const [existing, setExisting] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("kaigo_assessments")
        .select("certification_id, assessment_type")
        .eq("user_id", userId);
      if (error) {
        // 索引が取れなくても本体表示は続行 (切替チップが出ないだけ)
        console.error("kaigo_assessments index fetch failed:", error.message);
        return;
      }
      if (cancelled) return;
      const rows = (data ?? []) as Array<{
        certification_id: string | null;
        assessment_type: string | null;
      }>;
      setExisting(
        new Set(
          rows.map((r) =>
            comboKey(r.certification_id ?? null, r.assessment_type === "yobo" ? "yobo" : "kaigo"),
          ),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId]);

  const otherHasData = existing?.has(comboKey(selectedCertId, otherKind)) ?? false;
  // 上書き中は必ず戻せるようにチップを出す
  const showSwap = kindOverride !== null || otherHasData;

  const accent =
    kind === "yobo"
      ? { tab: "border-emerald-600 text-emerald-700 bg-emerald-50", badge: "bg-emerald-100 text-emerald-700" }
      : { tab: "border-blue-600 text-blue-700 bg-blue-50", badge: "bg-blue-100 text-blue-700" };

  const certTabs = (
    <div className="space-y-2">
      {initialCertifications.length > 0 ? (
        <div className="border-b overflow-x-auto">
          <div className="flex gap-1 min-w-max">
            {initialCertifications.map((cert) => {
              const fmt = (d: string) => format(parseISO(d), "yyyy/M/d");
              const isActive = selectedCertId === cert.id;
              return (
                <button
                  key={cert.id}
                  onClick={() => {
                    setSelectedCertId(cert.id);
                    setKindOverride(null);
                  }}
                  className={cn(
                    "flex flex-col px-4 py-2 text-xs border-b-2 whitespace-nowrap transition-colors",
                    isActive
                      ? cn(accent.tab, "font-semibold")
                      : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50",
                  )}
                  title={`${cert.care_level} — ${formKindForCareLevel(cert.care_level) === "yobo" ? "予防様式" : "介護様式"}`}
                >
                  <span className="font-bold">{cert.care_level}</span>
                  <span className="text-[10px] text-gray-500">
                    {fmt(cert.start_date)} 〜 {fmt(cert.end_date)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          介護認定情報が登録されていません。先に利用者情報で認定情報を登録してください。
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn("rounded-full px-2 py-0.5 font-semibold", accent.badge)}>
          {kind === "yobo" ? "予防様式" : "介護様式"}
        </span>
        {kindOverride ? (
          <span className="text-amber-700">
            認定区分 ({selectedCert?.care_level ?? "未登録"}) と異なる様式を表示しています
          </span>
        ) : (
          <span className="text-gray-500">
            {selectedCert
              ? `${selectedCert.care_level} の認定期間に対応する様式です`
              : "認定期間が未選択のため介護様式を表示しています"}
          </span>
        )}
        {showSwap && (
          <button
            onClick={() => setKindOverride(kindOverride ? null : otherKind)}
            className="rounded border px-2 py-0.5 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            {kindOverride
              ? "認定区分の様式に戻す"
              : `${otherKind === "yobo" ? "予防" : "介護"}様式のデータを表示`}
          </button>
        )}
      </div>
    </div>
  );

  // server prefetch と同じ組合せのときだけ initial データを渡す (それ以外は子が fetch)
  const isServerCombo = kind === serverKind && selectedCertId === serverCertId;

  if (kind === "yobo") {
    return (
      <YoboContent
        userId={userId}
        initialUser={initialUser}
        selectedCertId={selectedCertId}
        certTabs={certTabs}
        initialAssessments={isServerCombo ? (initialAssessments as unknown as YoboAssessment[]) : null}
      />
    );
  }

  return (
    <AssessmentsContent
      userId={userId}
      initialUser={initialUser}
      selectedCertId={selectedCertId}
      certTabs={certTabs}
      initialAssessments={isServerCombo ? initialAssessments : null}
    />
  );
}
