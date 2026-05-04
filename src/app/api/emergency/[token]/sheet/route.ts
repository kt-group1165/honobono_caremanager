import { NextResponse } from "next/server";
import { loadEmergencyToken } from "@/lib/emergency-token";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/emergency/[token]/sheet?user=<client_id>
//
// 利用者の緊急時シートを返す。kaigo_emergency_sheets を base に、
// kaigo_medical_history（既往歴）/ kaigo_assessments（家族情報）/
// kaigo_report_documents の care-plan-2 第2表（利用中サービス）/
// kaigo_service_providers（事業所連絡先）から自動補完。
//
// 全クエリは ctx.tenant_id にスコープし、別 tenant の漏洩を防ぐ。

type Sheet = Record<string, unknown>;

type ServiceEntry = {
  service_type: string;
  provider_name: string;
  phone: string;
  schedule: string;
};

type CarePlan2Service = {
  type?: string;
  provider?: string;
  frequency?: string;
};

type CarePlan2Goal = { services?: CarePlan2Service[] };
type CarePlan2Block = { goals?: CarePlan2Goal[] };
type CarePlan2Content = {
  needs_blocks?: CarePlan2Block[];
  blocks?: CarePlan2Block[];
  services?: CarePlan2Service[];
};

type FamilyMember = {
  name?: string;
  relationship?: string;
  relationship_detail?: string;
  phone?: string;
  address?: string;
};

type AssessmentForm = {
  tab2?: { family_members?: FamilyMember[] };
};

type MedicalHistoryRow = {
  disease_name: string | null;
  status: string | null;
  hospital: string | null;
  doctor: string | null;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const ctx = await loadEmergencyToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get("user");
  if (!userId) {
    return NextResponse.json({ error: "user_required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // user_id が token の tenant に属するか検証
  const { data: userData } = await admin
    .from("clients")
    .select("name, name_kana:furigana, birth_date, gender, address, phone")
    .eq("id", userId)
    .eq("tenant_id", ctx.tenant_id)
    .maybeSingle();
  if (!userData) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const user = userData as {
    name: string | null;
    name_kana: string | null;
    birth_date: string | null;
    gender: string | null;
    address: string | null;
    phone: string | null;
  };

  const [{ data: sheetRow }, { data: historyData }, { data: assessmentRow }, { data: reportDocs }] = await Promise.all([
    admin
      .from("kaigo_emergency_sheets")
      .select("*")
      .eq("user_id", userId)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle(),
    admin
      .from("kaigo_medical_history")
      .select("disease_name, status, hospital, doctor")
      .eq("user_id", userId)
      .eq("tenant_id", ctx.tenant_id)
      .order("created_at", { ascending: false }),
    admin
      .from("kaigo_assessments")
      .select("form_data")
      .eq("user_id", userId)
      .eq("tenant_id", ctx.tenant_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("kaigo_report_documents")
      .select("content, updated_at")
      .eq("user_id", userId)
      .eq("tenant_id", ctx.tenant_id)
      .eq("report_type", "care-plan-2")
      .order("updated_at", { ascending: false })
      .limit(1),
  ]);

  // ── merge ロジック（旧 page.tsx の openSheet 互換）────────────────
  const merged: Sheet = { ...((sheetRow ?? {}) as Sheet) };

  // 電話番号
  if (user.phone && !merged.home_phone) merged.home_phone = user.phone;

  // 既往歴 → 主治医（最新 2 件）+ 現病メモ
  const history = (historyData ?? []) as MedicalHistoryRow[];
  if (history.length > 0) {
    const withDoctor = history.filter((h) => h.doctor || h.hospital);
    if (withDoctor.length > 0 && !merged.doctor_name && !merged.doctor_hospital) {
      merged.doctor_name = withDoctor[0].doctor ?? "";
      merged.doctor_hospital = withDoctor[0].hospital ?? "";
    }
    if (withDoctor.length > 1 && !merged.doctor2_name && !merged.doctor2_hospital) {
      merged.doctor2_name = withDoctor[1].doctor ?? "";
      merged.doctor2_hospital = withDoctor[1].hospital ?? "";
    }
    if (!merged.current_disease_notes) {
      merged.current_disease_notes = history
        .map((h) =>
          `${h.disease_name ?? ""}${h.status ? ` (${h.status})` : ""}${h.hospital ? ` - ${h.hospital}` : ""}`
        )
        .join("\n");
    }
  }

  // アセスメント家族情報 → 緊急連絡先 1〜5
  const fd = (assessmentRow as { form_data?: AssessmentForm } | null)?.form_data;
  const familyMembers = fd?.tab2?.family_members ?? [];
  let idx = 0;
  for (const m of familyMembers) {
    if (!m.name || idx >= 5) break;
    const k = String(idx + 1);
    if (!merged[`emergency_contact${k}_name`]) {
      merged[`emergency_contact${k}_name`] = m.name ?? "";
      merged[`emergency_contact${k}_relation`] = m.relationship ?? m.relationship_detail ?? "";
      merged[`emergency_contact${k}_phone`] = m.phone ?? "";
      merged[`emergency_contact${k}_address`] = m.address ?? "";
    }
    idx++;
  }

  // 第2表（care-plan-2）→ services_in_use を完全置換
  const collected: ServiceEntry[] = [];
  const addSvc = (svc: CarePlan2Service | null | undefined) => {
    if (!svc) return;
    if (!(svc.type || svc.provider)) return;
    const dup = collected.find(
      (c) => c.service_type === (svc.type ?? "") && c.provider_name === (svc.provider ?? "")
    );
    if (!dup) {
      collected.push({
        service_type: svc.type ?? "",
        provider_name: svc.provider ?? "",
        phone: "",
        schedule: svc.frequency ?? "",
      });
    }
  };

  for (const doc of (reportDocs ?? []) as { content: CarePlan2Content }[]) {
    const content = doc.content;
    const blockArr = Array.isArray(content?.needs_blocks)
      ? content.needs_blocks
      : Array.isArray(content?.blocks)
      ? content.blocks
      : null;
    if (blockArr) {
      for (const block of blockArr) {
        for (const goal of block.goals ?? []) {
          for (const svc of goal.services ?? []) addSvc(svc);
        }
      }
    } else if (Array.isArray(content?.services)) {
      for (const svc of content.services) addSvc(svc);
    }
  }

  if (collected.length > 0) {
    const names = collected.map((c) => c.provider_name).filter(Boolean);
    if (names.length > 0) {
      const { data: provRows } = await admin
        .from("kaigo_service_providers")
        .select("provider_name, phone")
        .eq("tenant_id", ctx.tenant_id)
        .in("provider_name", names);
      const phoneMap = new Map<string, string>();
      for (const p of (provRows ?? []) as { provider_name: string; phone: string | null }[]) {
        phoneMap.set(p.provider_name, p.phone ?? "");
      }
      for (const c of collected) {
        if (!c.phone && phoneMap.has(c.provider_name)) {
          c.phone = phoneMap.get(c.provider_name) ?? "";
        }
      }
    }
  }
  merged.services_in_use = collected;

  return NextResponse.json({
    user_name: user.name ?? "",
    user_kana: user.name_kana ?? "",
    birth_date: user.birth_date,
    gender: user.gender,
    address: user.address,
    phone: user.phone,
    sheet: merged,
  });
}
