"use client";

import { useState, useEffect, useCallback } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { toast } from "sonner";
import {
  ChevronLeft,
  AlertTriangle,
  User,
  Phone,
  Hospital,
  Pill,
  Heart,
  Loader2,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { use } from "react";

function createAnonClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CareManager {
  id: string;
  name: string;
}

interface UserWithStatus {
  id: string;
  name: string;
  name_kana: string;
  care_manager_name: string | null;
  safety_status: string;
  service_status: string;
}

interface SheetData {
  user_name: string;
  user_kana: string;
  birth_date: string | null;
  gender: string | null;
  address: string | null;
  phone: string | null;
  sheet: Record<string, string> | null;
}

const STATUS_OPTIONS = ["", "◯", "△", "×"];
const STATUS_COLORS: Record<string, string> = {
  "◯": "bg-green-100 text-green-700 border-green-300",
  "△": "bg-yellow-100 text-yellow-700 border-yellow-300",
  "×": "bg-red-100 text-red-700 border-red-300",
  "": "bg-gray-50 text-gray-400 border-gray-200",
};

// ─── Main Page ───────────────────────────────────────────────────────────────

type Params = { token: string };

export default function EmergencyMobilePage({ params }: { params: Promise<Params> }) {
  const { token } = use(params);
  const supabase = createAnonClient();

  const [valid, setValid] = useState<boolean | null>(null);
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");

  // Screens: "managers" → "users" → "sheet"
  const [screen, setScreen] = useState<"managers" | "users" | "sheet">("managers");
  const [managers, setManagers] = useState<CareManager[]>([]);
  const [selectedManager, setSelectedManager] = useState<CareManager | null>(null);
  const [users, setUsers] = useState<UserWithStatus[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [sheetData, setSheetData] = useState<SheetData | null>(null);
  const [loadingSheet, setLoadingSheet] = useState(false);

  // Validate token
  useEffect(() => {
    const validate = async () => {
      const { data } = await supabase
        .from("kaigo_emergency_tokens")
        .select("id, name")
        .eq("token", token)
        .single();
      if (data) {
        setValid(true);
        setTokenId(data.id);
        setTokenName(data.name);
      } else {
        setValid(false);
      }
    };
    validate();
  }, [token, supabase]);

  // Fetch care managers (distinct from kaigo_users.care_manager_name or staff)
  useEffect(() => {
    if (!valid) return;
    const fetch = async () => {
      // Get staff as care managers
      const { data } = await supabase
        .from("kaigo_staff")
        .select("id, name")
        .eq("status", "active")
        .order("name");
      setManagers(data || []);
    };
    fetch();
  }, [valid, supabase]);

  // Fetch users for selected manager
  const fetchUsers = useCallback(async (managerId: string) => {
    setLoadingUsers(true);
    // Get all active users (filter by care_manager if available, else show all)
    const { data: usersData } = await supabase
      .from("kaigo_users")
      .select("id, name, name_kana")
      .eq("status", "active")
      .order("name_kana");

    // Get existing statuses
    const { data: statusData } = await supabase
      .from("kaigo_emergency_status")
      .select("user_id, safety_status, service_status")
      .eq("token_id", tokenId);

    const statusMap = new Map<string, { safety: string; service: string }>();
    (statusData || []).forEach((s: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      statusMap.set(s.user_id, { safety: s.safety_status || "", service: s.service_status || "" });
    });

    const merged: UserWithStatus[] = (usersData || []).map((u: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      id: u.id,
      name: u.name,
      name_kana: u.name_kana,
      care_manager_name: null,
      safety_status: statusMap.get(u.id)?.safety ?? "",
      service_status: statusMap.get(u.id)?.service ?? "",
    }));

    setUsers(merged);
    setLoadingUsers(false);
  }, [supabase, tokenId]);

  // Update status
  const updateStatus = async (userId: string, field: "safety_status" | "service_status", value: string) => {
    // Optimistic update
    setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, [field === "safety_status" ? "safety_status" : "service_status"]: value } : u));

    const { data: existing } = await supabase
      .from("kaigo_emergency_status")
      .select("id")
      .eq("user_id", userId)
      .eq("token_id", tokenId)
      .single();

    if (existing) {
      await supabase.from("kaigo_emergency_status").update({ [field]: value, updated_at: new Date().toISOString() }).eq("id", existing.id);
    } else {
      await supabase.from("kaigo_emergency_status").insert({
        user_id: userId, token_id: tokenId, [field]: value,
      });
    }
  };

  // Fetch sheet
  const openSheet = async (userId: string) => {
    setLoadingSheet(true);
    const [{ data: userData }, { data: sheetRow }] = await Promise.all([
      supabase.from("kaigo_users").select("name, name_kana, birth_date, gender, address, phone").eq("id", userId).single(),
      supabase.from("kaigo_emergency_sheets").select("*").eq("user_id", userId).single(),
    ]);
    setSheetData({
      user_name: userData?.name ?? "",
      user_kana: userData?.name_kana ?? "",
      birth_date: userData?.birth_date,
      gender: userData?.gender,
      address: userData?.address,
      phone: userData?.phone,
      sheet: sheetRow as Record<string, string> | null,
    });
    setScreen("sheet");
    setLoadingSheet(false);
  };

  // ─── Loading / Invalid ──────────────────────────────────────────────────────

  if (valid === null) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 size={28} className="animate-spin text-blue-500" /></div>;
  }
  if (!valid) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="text-center">
          <AlertTriangle size={48} className="mx-auto mb-3 text-red-400" />
          <h1 className="text-lg font-bold text-gray-900">無効なURLです</h1>
          <p className="mt-1 text-sm text-gray-500">このリンクは有効ではありません</p>
        </div>
      </div>
    );
  }

  // ─── Sheet View ─────────────────────────────────────────────────────────────

  if (screen === "sheet" && sheetData) {
    const s = sheetData.sheet || {} as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const svcs = (s.services_in_use || []) as { service_type: string; provider_name: string; phone: string; schedule: string }[];
    const devs = (s.medical_devices || []) as { item: string; provider: string; phone: string; notes: string }[];
    const Row = ({ label, value }: { label: string; value: string | null | undefined }) => {
      if (!value) return null;
      return <div className="flex py-1.5 border-b border-gray-100"><span className="text-gray-500 w-24 shrink-0 text-xs">{label}</span><span className="text-sm font-medium">{value}</span></div>;
    };
    const SectionTitle = ({ children, color }: { children: React.ReactNode; color: string }) => (
      <h3 className={`text-sm font-bold px-3 py-2 rounded-lg mt-4 mb-2 ${color}`}>{children}</h3>
    );

    return (
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-white border-b px-4 py-3 shadow-sm">
          <button onClick={() => { setScreen("users"); setSheetData(null); }} className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 active:bg-gray-200">
            <ChevronLeft size={20} />
          </button>
          <div>
            <h1 className="text-base font-bold text-gray-900">{sheetData.user_name}</h1>
            <p className="text-xs text-gray-500">緊急時シート</p>
          </div>
        </div>

        <div className="p-4 max-w-lg mx-auto">
          {/* 基本情報 */}
          <div className="rounded-xl border-2 border-red-200 bg-red-50 p-4 mb-4">
            <h2 className="text-base font-bold text-red-800 flex items-center gap-2 mb-2">
              <AlertTriangle size={16} />居宅緊急時シート
            </h2>
            <Row label="氏名" value={sheetData.user_name} />
            <Row label="フリガナ" value={sheetData.user_kana} />
            <Row label="生年月日" value={sheetData.birth_date} />
            <Row label="性別" value={sheetData.gender} />
            <Row label="住所" value={sheetData.address} />
            <Row label="固定電話" value={s.home_phone || sheetData.phone} />
            <Row label="携帯電話" value={s.mobile_phone} />
            <Row label="同居家族" value={s.family_members} />
            <Row label="血液型" value={s.blood_type} />
            <Row label="アレルギー" value={s.allergies} />
          </div>

          {/* ADL */}
          {s.adl_summary && (
            <><SectionTitle color="bg-green-50 text-green-800"><User size={14} className="inline mr-1" />ADL（簡潔に）</SectionTitle>
            <div className="bg-white rounded-xl border p-3"><p className="text-sm whitespace-pre-wrap">{s.adl_summary}</p></div></>
          )}

          {/* 現病と注意点 */}
          {s.current_disease_notes && (
            <><SectionTitle color="bg-purple-50 text-purple-800"><Heart size={14} className="inline mr-1" />現病と注意点</SectionTitle>
            <div className="bg-white rounded-xl border p-3"><p className="text-sm whitespace-pre-wrap">{s.current_disease_notes}</p></div></>
          )}

          {/* 内服薬 */}
          {s.oral_medications && (
            <><SectionTitle color="bg-yellow-50 text-yellow-800"><Pill size={14} className="inline mr-1" />内服薬</SectionTitle>
            <div className="bg-white rounded-xl border p-3"><p className="text-sm whitespace-pre-wrap">{s.oral_medications}</p></div></>
          )}

          {/* 特別な状況 */}
          {s.special_situation && (
            <><SectionTitle color="bg-blue-50 text-blue-800">特別な状況</SectionTitle>
            <div className="bg-white rounded-xl border p-3"><p className="text-sm whitespace-pre-wrap">{s.special_situation}</p></div></>
          )}

          {/* 急変時の対応 */}
          {s.sudden_change_response && (
            <><SectionTitle color="bg-red-50 text-red-800"><AlertTriangle size={14} className="inline mr-1" />急変時の対応</SectionTitle>
            <div className="bg-white rounded-xl border p-3"><p className="text-sm whitespace-pre-wrap">{s.sudden_change_response}</p></div></>
          )}

          {/* 避難場所 */}
          {(s.evacuation_place_name || s.evacuation_place_address) && (
            <><SectionTitle color="bg-orange-50 text-orange-800">避難場所</SectionTitle>
            <div className="bg-white rounded-xl border p-3">
              <Row label="名称" value={s.evacuation_place_name} />
              <Row label="住所" value={s.evacuation_place_address} />
              {s.evacuation_notes && <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap">{s.evacuation_notes}</p>}
            </div></>
          )}

          {/* 緊急連絡先（5件まで） */}
          <SectionTitle color="bg-orange-50 text-orange-800"><Phone size={14} className="inline mr-1" />緊急連絡先</SectionTitle>
          <div className="bg-white rounded-xl border p-3 space-y-0">
            {[1, 2, 3, 4, 5].map((n) => {
              const name = s[`emergency_contact${n}_name`];
              if (!name) return null;
              return (
                <div key={n}>
                  {n > 1 && <hr className="my-2" />}
                  <Row label={`氏名${n}`} value={name} />
                  <Row label="続柄" value={s[`emergency_contact${n}_relation`]} />
                  <Row label="所在地" value={s[`emergency_contact${n}_address`]} />
                  <Row label="連絡先" value={s[`emergency_contact${n}_phone`]} />
                </div>
              );
            })}
          </div>

          {/* 主治医 */}
          <SectionTitle color="bg-blue-50 text-blue-800"><Hospital size={14} className="inline mr-1" />主治医</SectionTitle>
          <div className="bg-white rounded-xl border p-3">
            <Row label="医療機関" value={s.doctor_hospital} />
            <Row label="氏名" value={s.doctor_name} />
            <Row label="連絡先" value={s.doctor_phone} />
            {s.doctor2_name && <><hr className="my-2" /><Row label="医療機関②" value={s.doctor2_hospital} /><Row label="氏名" value={s.doctor2_name} /><Row label="連絡先" value={s.doctor2_phone} /></>}
          </div>

          {/* 利用中サービス */}
          {svcs.length > 0 && (
            <><SectionTitle color="bg-green-50 text-green-800">利用中サービス</SectionTitle>
            <div className="bg-white rounded-xl border divide-y">
              {svcs.map((svc, i) => (
                <div key={i} className="p-3 text-sm">
                  <div className="font-medium">{svc.service_type}</div>
                  <div className="text-gray-600">{svc.provider_name}</div>
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>{svc.phone}</span><span>{svc.schedule}</span>
                  </div>
                </div>
              ))}
            </div></>
          )}

          {/* 電動医療・介護機器 */}
          {devs.length > 0 && (
            <><SectionTitle color="bg-yellow-50 text-yellow-800">充電式を含む電動の医療・介護機器</SectionTitle>
            <div className="bg-white rounded-xl border divide-y">
              {devs.map((dev, i) => (
                <div key={i} className="p-3 text-sm">
                  <div className="font-medium">{dev.item}</div>
                  <div className="text-gray-600">{dev.provider}</div>
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>{dev.phone}</span>{dev.notes && <span>{dev.notes}</span>}
                  </div>
                </div>
              ))}
            </div></>
          )}

          {/* 担当ケアマネ */}
          <SectionTitle color="bg-gray-100 text-gray-800"><Shield size={14} className="inline mr-1" />担当ケアマネジャー</SectionTitle>
          <div className="bg-white rounded-xl border p-3">
            <Row label="事業所" value={s.care_manager_office} />
            <Row label="氏名" value={s.care_manager_name} />
            <Row label="連絡先" value={s.care_manager_phone} />
          </div>

          <div className="h-8" />
        </div>
      </div>
    );
  }

  // ─── Users List ─────────────────────────────────────────────────────────────

  if (screen === "users" && selectedManager) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-white border-b px-4 py-3 shadow-sm">
          <button onClick={() => { setScreen("managers"); setSelectedManager(null); }} className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 active:bg-gray-200">
            <ChevronLeft size={20} />
          </button>
          <div>
            <h1 className="text-base font-bold text-gray-900">{selectedManager.name}</h1>
            <p className="text-xs text-gray-500">担当利用者一覧</p>
          </div>
        </div>

        {loadingUsers ? (
          <div className="flex h-40 items-center justify-center"><Loader2 size={24} className="animate-spin text-blue-500" /></div>
        ) : (
          <div className="p-4">
            {/* ヘッダー */}
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-t-xl text-xs font-bold text-gray-600">
              <span className="flex-1">利用者名</span>
              <span className="w-16 text-center">安否確認</span>
              <span className="w-16 text-center">サービス</span>
            </div>

            <div className="bg-white rounded-b-xl border divide-y divide-gray-100">
              {users.map((u) => (
                <div key={u.id} className="flex items-center gap-2 px-3 py-2.5">
                  {/* 名前（タップでシート表示） */}
                  <button
                    onClick={() => openSheet(u.id)}
                    className="flex-1 text-left text-sm font-medium text-blue-700 active:text-blue-900"
                    disabled={loadingSheet}
                  >
                    {u.name}
                    <span className="block text-[10px] text-gray-400">{u.name_kana}</span>
                  </button>

                  {/* 安否確認 */}
                  <div className="w-16">
                    <select
                      value={u.safety_status}
                      onChange={(e) => updateStatus(u.id, "safety_status", e.target.value)}
                      className={cn("w-full text-center text-sm font-bold rounded-lg border py-1.5 appearance-none cursor-pointer", STATUS_COLORS[u.safety_status] || STATUS_COLORS[""])}
                    >
                      {STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o || "—"}</option>)}
                    </select>
                  </div>

                  {/* サービス調整 */}
                  <div className="w-16">
                    <select
                      value={u.service_status}
                      onChange={(e) => updateStatus(u.id, "service_status", e.target.value)}
                      className={cn("w-full text-center text-sm font-bold rounded-lg border py-1.5 appearance-none cursor-pointer", STATUS_COLORS[u.service_status] || STATUS_COLORS[""])}
                    >
                      {STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o || "—"}</option>)}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Manager Selection ──────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white border-b px-4 py-4 shadow-sm text-center">
        <h1 className="text-lg font-bold text-gray-900 flex items-center justify-center gap-2">
          <AlertTriangle size={20} className="text-red-500" />
          緊急時シート
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">{tokenName}</p>
      </div>

      <div className="p-4 max-w-lg mx-auto">
        <p className="text-sm text-gray-600 mb-4">担当ケアマネを選択してください</p>
        <div className="space-y-2">
          {managers.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                setSelectedManager(m);
                setScreen("users");
                fetchUsers(m.id);
              }}
              className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white border border-gray-200 shadow-sm active:bg-gray-50 transition-colors"
            >
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                <User size={20} className="text-blue-600" />
              </div>
              <span className="text-base font-semibold text-gray-900">{m.name}</span>
              <ChevronLeft size={16} className="ml-auto text-gray-400 rotate-180" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
