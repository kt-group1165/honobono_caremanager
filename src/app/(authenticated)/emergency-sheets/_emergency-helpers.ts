import type { SupabaseClient } from "@supabase/supabase-js";

export interface EmergencySheet {
  id?: string;
  user_id: string;
  blood_type: string;
  allergies: string;
  doctor_name: string;
  doctor_hospital: string;
  doctor_phone: string;
  doctor_address: string;
  doctor2_name: string;
  doctor2_hospital: string;
  doctor2_phone: string;
  dentist_name: string;
  dentist_hospital: string;
  dentist_phone: string;
  pharmacy_name: string;
  pharmacy_phone: string;
  emergency_contact1_name: string;
  emergency_contact1_relation: string;
  emergency_contact1_phone: string;
  emergency_contact1_address: string;
  emergency_contact2_name: string;
  emergency_contact2_relation: string;
  emergency_contact2_phone: string;
  emergency_contact2_address: string;
  emergency_contact3_name: string;
  emergency_contact3_relation: string;
  emergency_contact3_phone: string;
  medical_history: string;
  current_illness: string;
  adl_mobility: string;
  adl_eating: string;
  adl_toileting: string;
  adl_bathing: string;
  adl_dressing: string;
  adl_communication: string;
  adl_cognition: string;
  adl_notes: string;
  medications: string;
  medication_notes: string;
  emergency_instructions: string;
  hospital_preference: string;
  care_manager_name: string;
  care_manager_office: string;
  care_manager_phone: string;
  notes: string;
  home_phone: string;
  mobile_phone: string;
  family_members: string;
  adl_summary: string;
  current_disease_notes: string;
  oral_medications: string;
  special_situation: string;
  sudden_change_response: string;
  evacuation_place_name: string;
  evacuation_place_address: string;
  evacuation_notes: string;
  emergency_contact4_name: string;
  emergency_contact4_relation: string;
  emergency_contact4_phone: string;
  emergency_contact4_address: string;
  emergency_contact5_name: string;
  emergency_contact5_relation: string;
  emergency_contact5_phone: string;
  emergency_contact5_address: string;
  services_in_use: { service_type: string; provider_name: string; phone: string; schedule: string }[];
  medical_devices: { item: string; provider: string; phone: string; notes: string }[];
}

export interface EmergencyUserInfo {
  name: string;
  name_kana: string;
  birth_date: string | null;
  gender: string | null;
  address: string | null;
  phone: string | null;
}

export const emptySheet = (userId: string): EmergencySheet => ({
  user_id: userId,
  blood_type: "", allergies: "",
  doctor_name: "", doctor_hospital: "", doctor_phone: "", doctor_address: "",
  doctor2_name: "", doctor2_hospital: "", doctor2_phone: "",
  dentist_name: "", dentist_hospital: "", dentist_phone: "",
  pharmacy_name: "", pharmacy_phone: "",
  emergency_contact1_name: "", emergency_contact1_relation: "", emergency_contact1_phone: "", emergency_contact1_address: "",
  emergency_contact2_name: "", emergency_contact2_relation: "", emergency_contact2_phone: "", emergency_contact2_address: "",
  emergency_contact3_name: "", emergency_contact3_relation: "", emergency_contact3_phone: "",
  medical_history: "", current_illness: "",
  adl_mobility: "", adl_eating: "", adl_toileting: "", adl_bathing: "", adl_dressing: "", adl_communication: "", adl_cognition: "", adl_notes: "",
  medications: "", medication_notes: "",
  emergency_instructions: "", hospital_preference: "",
  care_manager_name: "", care_manager_office: "", care_manager_phone: "",
  notes: "",
  home_phone: "", mobile_phone: "", family_members: "",
  adl_summary: "", current_disease_notes: "", oral_medications: "",
  special_situation: "", sudden_change_response: "",
  evacuation_place_name: "", evacuation_place_address: "", evacuation_notes: "",
  emergency_contact4_name: "", emergency_contact4_relation: "", emergency_contact4_phone: "", emergency_contact4_address: "",
  emergency_contact5_name: "", emergency_contact5_relation: "", emergency_contact5_phone: "", emergency_contact5_address: "",
  services_in_use: [], medical_devices: [],
});

// 基本情報から自動反映（client/server 両方の supabase で動く）
export async function autoFillFromBaseData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, "public", any>,
  userId: string,
  baseSheet: EmergencySheet,
): Promise<EmergencySheet> {
  const s = { ...baseSheet };
  const [{ data: userData }, { data: historyData }, { data: familyData }] = await Promise.all([
    supabase.from("clients").select("phone").eq("id", userId).single(),
    supabase.from("kaigo_medical_history").select("disease_name, onset_date, status, hospital, doctor, notes").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("kaigo_assessments").select("form_data").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  // 第2表から利用中サービスを取得して services_in_use を完全上書き
  {
    const collected: { service_type: string; provider_name: string; phone: string; schedule: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addSvc = (svc: any) => {
      if (!svc) return;
      if (!(svc.type || svc.provider)) return;
      const dup = collected.find((c) => c.service_type === (svc.type || "") && c.provider_name === (svc.provider || ""));
      if (!dup) {
        collected.push({
          service_type: svc.type || "",
          provider_name: svc.provider || "",
          phone: "",
          schedule: svc.frequency || "",
        });
      }
    };

    const { data: reportDocs } = await supabase
      .from("kaigo_report_documents")
      .select("content, updated_at")
      .eq("user_id", userId)
      .eq("report_type", "care-plan-2")
      .order("updated_at", { ascending: false })
      .limit(1);
    for (const doc of (reportDocs || [])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content = doc.content as any;
      const blockArr = Array.isArray(content?.needs_blocks) ? content.needs_blocks
        : Array.isArray(content?.blocks) ? content.blocks
        : null;
      if (blockArr) {
        for (const block of blockArr) {
          for (const goal of (block.goals || [])) {
            for (const svc of (goal.services || [])) addSvc(svc);
          }
        }
      } else if (Array.isArray(content?.services)) {
        for (const svc of content.services) addSvc(svc);
      }
    }

    if (collected.length > 0) {
      const providerNames = collected.map((c) => c.provider_name).filter(Boolean);
      if (providerNames.length > 0) {
        const { data: provRows } = await supabase
          .from("kaigo_service_providers")
          .select("provider_name, phone")
          .in("provider_name", providerNames);
        const phoneMap = new Map<string, string>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (provRows || []).forEach((p: any) => phoneMap.set(p.provider_name, p.phone || ""));
        collected.forEach((c) => { if (!c.phone && phoneMap.has(c.provider_name)) c.phone = phoneMap.get(c.provider_name)!; });
      }
    }
    s.services_in_use = collected;
  }

  if (userData?.phone && !s.home_phone) s.home_phone = userData.phone;

  if (historyData && historyData.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withDoctor = historyData.filter((h: any) => h.doctor || h.hospital);
    if (withDoctor.length > 0 && !s.doctor_name && !s.doctor_hospital) {
      s.doctor_name = withDoctor[0].doctor || "";
      s.doctor_hospital = withDoctor[0].hospital || "";
    }
    if (withDoctor.length > 1 && !s.doctor2_name && !s.doctor2_hospital) {
      s.doctor2_name = withDoctor[1].doctor || "";
      s.doctor2_hospital = withDoctor[1].hospital || "";
    }
    if (!s.current_disease_notes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s.current_disease_notes = historyData.map((h: any) =>
        `${h.disease_name}${h.status ? ` (${h.status})` : ""}${h.hospital ? ` - ${h.hospital}` : ""}`
      ).join("\n");
    }
  }

  if (familyData?.form_data) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fd = familyData.form_data as any;
    const members = fd?.tab2?.family_members || [];
    let contactIdx = 0;
    for (const m of members) {
      if (!m.name || contactIdx >= 5) break;
      const key = String(contactIdx + 1);
      const nameField = `emergency_contact${key}_name` as keyof EmergencySheet;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(s as any)[nameField]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s as any)[nameField] = m.name || "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s as any)[`emergency_contact${key}_relation`] = m.relationship || m.relationship_detail || "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s as any)[`emergency_contact${key}_phone`] = m.phone || "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s as any)[`emergency_contact${key}_address`] = m.address || "";
      }
      contactIdx++;
    }
  }

  return s;
}
