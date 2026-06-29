// ─── Assessment Context Builder ─────────────────────────────────────────────
// アセスメント (kaigo_assessments.form_data) + 周辺データを fetch して
// ケアプラン AI 生成に渡すための「コンテキスト文字列」を組み立てるユーティリティ。
//
// 利用箇所:
//   - EditFormCarePlan1: 第1表 (= 総合的援助方針 / 課題分析等) の AI 生成
//   - EditFormCarePlan2: 第2表 (= ニーズ / 長期短期目標 / サービス) の AI 生成
//   - assessments-content: 「アセスメントから一括生成」 button
//
// 設計方針:
//   - 取得失敗は throw せず、空文字でフォールバック (UI で「アセスメント未入力」表示)
//   - form_data の各 section は optional (typescript の AssessmentFormData と同じ)
//   - silent failure 防止: 主要 fetch の error は console.error する

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssessmentFormData } from "@/app/(authenticated)/assessments/_types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AssessmentContextUser = {
  id: string;
  name: string;
  gender: string | null;
  birth_date: string | null;
  notes: string | null;
};

export type AssessmentContextCert = {
  care_level: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  care_manager: string | null;
};

export type AssessmentContextData = {
  /** 利用者本体 */
  user: AssessmentContextUser | null;
  /** 介護認定 (最新の認定済み) */
  cert: AssessmentContextCert | null;
  /** kaigo_assessments の最新 1 件 (status は問わない) */
  assessment: {
    id: string;
    assessment_date: string;
    assessor_name: string | null;
    status: string;
    form_data: AssessmentFormData | null;
  } | null;
  /** kaigo_adl_records 最新 1 件 (= 100 点 ADL スコア) */
  adlRecord: Record<string, unknown> | null;
  /** kaigo_medical_history 全件 */
  medicalHistory: Array<{ disease_name: string | null; status: string | null }>;
  /** kaigo_family_contacts 全件 */
  familyContacts: Array<{ name: string | null; relationship: string | null }>;
};

// ─── Fetch ──────────────────────────────────────────────────────────────────

/**
 * 利用者 ID から AI 生成に必要なコンテキストを 1 発で fetch する。
 * 並列で投げる。失敗した個別 query は null/[] にフォールバック。
 */
export async function fetchAssessmentContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase client は browser / server 両用
  supabase: SupabaseClient<any, any, any>,
  userId: string,
): Promise<AssessmentContextData> {
  const [userRes, certRes, assessRes, adlRes, historyRes, familyRes] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, gender, birth_date, notes")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("client_insurance_records")
      .select("care_level, certification_start_date, certification_end_date, care_manager")
      .eq("client_id", userId)
      .eq("certification_status", "認定済み")
      .order("certification_start_date", { ascending: false, nullsFirst: false })
      .limit(1),
    supabase
      .from("kaigo_assessments")
      .select("id, assessment_date, assessor_name, status, form_data")
      .eq("user_id", userId)
      .order("assessment_date", { ascending: false })
      .limit(1),
    supabase
      .from("kaigo_adl_records")
      .select("*")
      .eq("user_id", userId)
      .order("assessment_date", { ascending: false })
      .limit(1),
    supabase
      .from("kaigo_medical_history")
      .select("disease_name, status")
      .eq("user_id", userId),
    supabase
      .from("kaigo_family_contacts")
      .select("name, relationship")
      .eq("user_id", userId),
  ]);

  if (userRes.error) console.error("fetchAssessmentContext: clients fetch failed:", userRes.error.message);
  if (certRes.error) console.error("fetchAssessmentContext: cert fetch failed:", certRes.error.message);
  if (assessRes.error) console.error("fetchAssessmentContext: assessments fetch failed:", assessRes.error.message);
  if (adlRes.error) console.error("fetchAssessmentContext: adl fetch failed:", adlRes.error.message);
  if (historyRes.error) console.error("fetchAssessmentContext: medical_history fetch failed:", historyRes.error.message);
  if (familyRes.error) console.error("fetchAssessmentContext: family fetch failed:", familyRes.error.message);

  const user = (userRes.data ?? null) as AssessmentContextUser | null;
  const cert = (certRes.data?.[0] ?? null) as AssessmentContextCert | null;
  const assess = (assessRes.data?.[0] ?? null) as AssessmentContextData["assessment"];
  const adl = (adlRes.data?.[0] ?? null) as Record<string, unknown> | null;
  const history = (historyRes.data ?? []) as AssessmentContextData["medicalHistory"];
  const family = (familyRes.data ?? []) as AssessmentContextData["familyContacts"];

  return {
    user,
    cert,
    assessment: assess,
    adlRecord: adl,
    medicalHistory: history,
    familyContacts: family,
  };
}

// ─── Helpers (AssessmentFormData → 平文要約) ───────────────────────────────

/**
 * form_data から AI に渡せる「平文サマリ」を生成。
 * 巨大な構造体をそのまま渡すと token を浪費 + 重要箇所が埋もれるので、
 * ケアプラン作成に重要な部分だけを抜粋。
 */
export function summarizeAssessmentFormData(form: AssessmentFormData | null | undefined): string {
  if (!form) return "";
  const parts: string[] = [];

  // Tab1 face_sheet: 相談内容 / 生活歴
  const face = form.face_sheet;
  if (face) {
    if (face.consultation_content_user) parts.push(`【利用者の相談内容/意向】 ${face.consultation_content_user}`);
    if (face.consultation_content_family) parts.push(`【家族の相談内容/意向】 ${face.consultation_content_family}`);
    if (face.life_history) parts.push(`【生活歴】 ${face.life_history}`);
  }

  // Tab2 family_support
  const fam = form.family_support;
  if (fam) {
    if (fam.family_care_situation) parts.push(`【家族の介護状況】 ${fam.family_care_situation}`);
    if (Array.isArray(fam.family_members) && fam.family_members.length > 0) {
      const summary = fam.family_members
        .filter((m) => m.name || m.relationship || m.relationship_type)
        .map((m) => {
          const rel = m.relationship_type || m.relationship || "";
          const primary = m.is_primary_caregiver ? "(主介護者)" : "";
          const living = m.living ? `[${m.living}居]` : "";
          return `${rel}${m.name ? `:${m.name}` : ""}${primary}${living}`;
        })
        .join("、");
      if (summary) parts.push(`【家族構成】 ${summary}`);
    }
    if (fam.needed_support?.content) {
      parts.push(`【必要な支援(本人/家族希望)】 ${fam.needed_support.content}`);
    }
  }

  // Tab4 housing
  const hou = form.housing;
  if (hou) {
    const houBits: string[] = [];
    if (hou.type) houBits.push(hou.type);
    if (hou.tenure) houBits.push(hou.tenure);
    if (hou.layout_notes) houBits.push(hou.layout_notes);
    if (hou.notes) houBits.push(hou.notes);
    if (houBits.length > 0) parts.push(`【住居状況】 ${houBits.join(" / ")}`);
  }

  // Tab5 health
  const hl = form.health;
  if (hl) {
    if (hl.medical_history) parts.push(`【既往歴】 ${hl.medical_history}`);
    if (hl.life_considerations) parts.push(`【生活上の配慮事項】 ${hl.life_considerations}`);
    if (hl.special_notes) parts.push(`【健康特記事項】 ${hl.special_notes}`);
  }

  // Tab6① basic_motion
  const bm = form.basic_motion;
  if (bm) {
    if (bm.basic_notes) parts.push(`【基本動作 所見】 ${bm.basic_notes}`);
    if (bm.bathing_notes) parts.push(`【入浴 所見】 ${bm.bathing_notes}`);
    if (bm.rehab_needed) parts.push(`【リハビリ必要性】 ${bm.rehab_needed}`);
    if (bm.communication_notes) parts.push(`【コミュニケーション 所見】 ${bm.communication_notes}`);
  }

  // Tab6② life_function
  const lf = form.life_function;
  if (lf) {
    if (lf.meal_notes) parts.push(`【食事 所見】 ${lf.meal_notes}`);
    if (lf.toilet_notes) parts.push(`【排泄 所見】 ${lf.toilet_notes}`);
    if (lf.outing_notes) parts.push(`【外出 所見】 ${lf.outing_notes}`);
  }

  // Tab6③④ cognition_behavior
  const cb = form.cognition_behavior;
  if (cb) {
    if (cb.family_observation) parts.push(`【認知/行動 家族観察】 ${cb.family_observation}`);
    if (cb.support_wish_user) parts.push(`【本人の支援希望(認知/行動)】 ${cb.support_wish_user}`);
    if (cb.support_wish_family) parts.push(`【家族の支援希望(認知/行動)】 ${cb.support_wish_family}`);
    if (cb.notes) parts.push(`【認知/行動 特記】 ${cb.notes}`);
  }

  // Tab6⑤ social
  const so = form.social;
  if (so?.notes) parts.push(`【社会生活 所見】 ${so.notes}`);

  // Tab6⑥ medical_health
  const mh = form.medical_health;
  if (mh?.notes) parts.push(`【医療健康 所見】 ${mh.notes}`);

  // Tab6医 doctor_opinion
  const dr = form.doctor_opinion;
  if (dr) {
    if (dr.improvement_outlook) parts.push(`【医師意見: 改善見通し】 ${dr.improvement_outlook}`);
    if (dr.nutrition?.notes) parts.push(`【医師意見: 栄養】 ${dr.nutrition.notes}`);
    if (dr.current_risks?.response) parts.push(`【医師意見: 現状リスクへの対応】 ${dr.current_risks.response}`);
  }

  // Tab7まとめ summary
  const sm = form.summary;
  if (sm) {
    if (sm.notes) parts.push(`【全体のまとめ】 ${sm.notes}`);
    if (sm.disaster_response?.needed === "有") {
      parts.push(`【災害時対応】 必要 (個別計画: ${sm.disaster_response.individual_plan || "未確認"})`);
    }
    if (sm.rights_protection?.needed === "有") {
      parts.push(`【権利擁護】 必要 ${sm.rights_protection.notes ? `(${sm.rights_protection.notes})` : ""}`);
    }
  }

  // 旧形式フィールド (= 後方互換)
  if (form.family_situation) parts.push(`【家族状況(旧)】 ${form.family_situation}`);
  if (form.health_condition) parts.push(`【健康状態(旧)】 ${form.health_condition}`);
  if (form.housing_situation) parts.push(`【住居状況(旧)】 ${form.housing_situation}`);

  return parts.join("\n");
}

/**
 * ADL レコードを「食事:自立 移乗:見守り …」形式の 1 行に整形。
 * 旧 EditFormCarePlan2 の handleAiGenerate と同じ formatter。
 */
export function summarizeAdl(adl: Record<string, unknown> | null | undefined): string {
  if (!adl) return "";
  const total = adl.total_score != null ? ` 合計:${adl.total_score}/100` : "";
  return `食事:${adl.eating ?? "?"} 移乗:${adl.transfer ?? "?"} 整容:${adl.grooming ?? "?"} トイレ:${adl.toilet ?? "?"} 入浴:${adl.bathing ?? "?"} 移動:${adl.mobility ?? "?"} 階段:${adl.stairs ?? "?"} 更衣:${adl.dressing ?? "?"} 排便:${adl.bowel ?? "?"} 排尿:${adl.bladder ?? "?"}${total}`;
}

/**
 * userInfo オブジェクト (= /api/ai/generate-care-plan の入力フォーマット) を組み立てる。
 * 既存の handleAiGenerate と互換 + アセスメント要約を含む拡張版。
 */
export function buildAiUserInfo(
  ctx: AssessmentContextData,
): {
  name: string;
  age: string;
  gender: string;
  careLevel: string;
  medicalHistory: string;
  adlSummary: string;
  familySituation: string;
  notes: string;
  assessmentSummary: string;
  hasAssessment: boolean;
} {
  const { user, cert, assessment, adlRecord, medicalHistory, familyContacts } = ctx;
  const age = user?.birth_date
    ? String(yearDiff(user.birth_date))
    : "";
  const adlSummary = summarizeAdl(adlRecord);
  const histStr = medicalHistory
    .map((h) => `${h.disease_name ?? ""}${h.status ? `(${h.status})` : ""}`)
    .filter((s) => s.length > 0)
    .join("、");
  const famStr = familyContacts
    .map((f) => `${f.relationship ?? ""}${f.name ? `:${f.name}` : ""}`)
    .filter((s) => s.length > 0)
    .join("、");
  const assessmentSummary = summarizeAssessmentFormData(assessment?.form_data ?? null);

  return {
    name: user?.name ?? "",
    age,
    gender: user?.gender ?? "",
    careLevel: cert?.care_level ?? "",
    medicalHistory: histStr,
    adlSummary,
    familySituation: famStr,
    notes: user?.notes ?? "",
    assessmentSummary,
    hasAssessment: !!assessment,
  };
}

function yearDiff(birthDate: string): number {
  try {
    const b = new Date(birthDate);
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    const m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
    return age;
  } catch {
    return 0;
  }
}
