"use client";

import { useState, useEffect, useCallback, use } from "react";
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

// /emergency/[token] : 災害時の安否確認モバイル画面（未認証アクセス可）。
//
// データアクセスは全て /api/emergency/[token]/* 経由（service_role）。
// 直接 Supabase を叩く実装からの書換（Phase 2-6a）。

// ─── Types ────────────────────────────────────────────────────────────────────

interface CareManager {
  id: string;
  name: string;
}

interface UserWithStatus {
  id: string;
  name: string;
  name_kana: string;
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
  sheet: Record<string, unknown> | null;
}

const STATUS_OPTIONS = ["", "◯", "△", "×"];
const STATUS_COLORS: Record<string, string> = {
  "◯": "bg-green-100 text-green-700 border-green-300",
  "△": "bg-yellow-100 text-yellow-700 border-yellow-300",
  "×": "bg-red-100 text-red-700 border-red-300",
  "": "bg-gray-50 text-gray-400 border-gray-200",
};

type Params = { token: string };

// presentational helpers (module scope に置いて react-hooks/static-components rule
// を満たす。closure 依存なし)
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex py-1.5 border-b border-gray-100">
      <span className="text-gray-500 w-24 shrink-0 text-xs">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}
function SectionTitle({ children, color }: { children: React.ReactNode; color: string }) {
  return <h3 className={`text-sm font-bold px-3 py-2 rounded-lg mt-4 mb-2 ${color}`}>{children}</h3>;
}

export default function EmergencyMobilePage({ params }: { params: Promise<Params> }) {
  const { token } = use(params);
  const apiBase = `/api/emergency/${encodeURIComponent(token)}`;

  const [valid, setValid] = useState<boolean | null>(null);
  const [tokenName, setTokenName] = useState("");

  // Screens: "managers" → "users" → "sheet"
  const [screen, setScreen] = useState<"managers" | "users" | "sheet">("managers");
  const [managers, setManagers] = useState<CareManager[]>([]);
  const [selectedManager, setSelectedManager] = useState<CareManager | null>(null);
  const [users, setUsers] = useState<UserWithStatus[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [sheetData, setSheetData] = useState<SheetData | null>(null);
  const [loadingSheet, setLoadingSheet] = useState(false);

  // Validate token + fetch managers in one effect after token check
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(apiBase, { cache: "no-store" });
      if (cancelled) return;
      if (!res.ok) {
        setValid(false);
        return;
      }
      const data = (await res.json()) as { name: string };
      setValid(true);
      setTokenName(data.name);

      const mgrRes = await fetch(`${apiBase}/managers`, { cache: "no-store" });
      if (cancelled) return;
      if (mgrRes.ok) {
        const mgrJson = (await mgrRes.json()) as { managers: CareManager[] };
        setManagers(mgrJson.managers ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  // Fetch users for selected manager
  const fetchUsers = useCallback(async (managerId: string) => {
    setLoadingUsers(true);
    try {
      const res = await fetch(
        `${apiBase}/users?manager=${encodeURIComponent(managerId)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const json = (await res.json()) as { users: UserWithStatus[] };
        setUsers(json.users ?? []);
      } else {
        setUsers([]);
      }
    } finally {
      setLoadingUsers(false);
    }
  }, [apiBase]);

  // Update status (optimistic + server PATCH)
  const updateStatus = async (
    userId: string,
    field: "safety_status" | "service_status",
    value: string
  ) => {
    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, [field]: value } : u))
    );
    await fetch(`${apiBase}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, field, value }),
    });
  };

  // Fetch sheet（merge は API 側で実施）
  const openSheet = async (userId: string) => {
    setLoadingSheet(true);
    try {
      const res = await fetch(
        `${apiBase}/sheet?user=${encodeURIComponent(userId)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const json = (await res.json()) as SheetData;
        setSheetData(json);
        setScreen("sheet");
      }
    } finally {
      setLoadingSheet(false);
    }
  };

  // ─── Loading / Invalid ──────────────────────────────────────────────────────

  if (valid === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 size={28} className="animate-spin text-blue-500" />
      </div>
    );
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
    const s = (sheetData.sheet ?? {}) as Record<string, string | undefined> & {
      services_in_use?: { service_type: string; provider_name: string; phone: string; schedule: string }[];
      medical_devices?: { item: string; provider: string; phone: string; notes: string }[];
    };
    const svcs = s.services_in_use ?? [];
    const devs = s.medical_devices ?? [];

    return (
      <div className="min-h-screen bg-gray-50">
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-white border-b px-4 py-3 shadow-sm">
          <button
            onClick={() => {
              setScreen("users");
              setSheetData(null);
            }}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 active:bg-gray-200"
          >
            <ChevronLeft size={20} />
          </button>
          <div>
            <h1 className="text-base font-bold text-gray-900">{sheetData.user_name}</h1>
            <p className="text-xs text-gray-500">緊急時シート</p>
          </div>
        </div>

        <div className="p-4 max-w-lg mx-auto">
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

          {s.adl_summary && (
            <>
              <SectionTitle color="bg-green-50 text-green-800">
                <User size={14} className="inline mr-1" />ADL（簡潔に）
              </SectionTitle>
              <div className="bg-white rounded-xl border p-3">
                <p className="text-sm whitespace-pre-wrap">{s.adl_summary}</p>
              </div>
            </>
          )}

          {s.current_disease_notes && (
            <>
              <SectionTitle color="bg-purple-50 text-purple-800">
                <Heart size={14} className="inline mr-1" />現病と注意点
              </SectionTitle>
              <div className="bg-white rounded-xl border p-3">
                <p className="text-sm whitespace-pre-wrap">{s.current_disease_notes}</p>
              </div>
            </>
          )}

          {s.oral_medications && (
            <>
              <SectionTitle color="bg-yellow-50 text-yellow-800">
                <Pill size={14} className="inline mr-1" />内服薬
              </SectionTitle>
              <div className="bg-white rounded-xl border p-3">
                <p className="text-sm whitespace-pre-wrap">{s.oral_medications}</p>
              </div>
            </>
          )}

          {s.special_situation && (
            <>
              <SectionTitle color="bg-blue-50 text-blue-800">特別な状況</SectionTitle>
              <div className="bg-white rounded-xl border p-3">
                <p className="text-sm whitespace-pre-wrap">{s.special_situation}</p>
              </div>
            </>
          )}

          {s.sudden_change_response && (
            <>
              <SectionTitle color="bg-red-50 text-red-800">
                <AlertTriangle size={14} className="inline mr-1" />急変時の対応
              </SectionTitle>
              <div className="bg-white rounded-xl border p-3">
                <p className="text-sm whitespace-pre-wrap">{s.sudden_change_response}</p>
              </div>
            </>
          )}

          {(s.evacuation_place_name || s.evacuation_place_address) && (
            <>
              <SectionTitle color="bg-orange-50 text-orange-800">避難場所</SectionTitle>
              <div className="bg-white rounded-xl border p-3">
                <Row label="名称" value={s.evacuation_place_name} />
                <Row label="住所" value={s.evacuation_place_address} />
                {s.evacuation_notes && (
                  <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap">{s.evacuation_notes}</p>
                )}
              </div>
            </>
          )}

          <SectionTitle color="bg-orange-50 text-orange-800">
            <Phone size={14} className="inline mr-1" />緊急連絡先
          </SectionTitle>
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

          <SectionTitle color="bg-blue-50 text-blue-800">
            <Hospital size={14} className="inline mr-1" />主治医
          </SectionTitle>
          <div className="bg-white rounded-xl border p-3">
            <Row label="医療機関" value={s.doctor_hospital} />
            <Row label="氏名" value={s.doctor_name} />
            <Row label="連絡先" value={s.doctor_phone} />
            {s.doctor2_name && (
              <>
                <hr className="my-2" />
                <Row label="医療機関②" value={s.doctor2_hospital} />
                <Row label="氏名" value={s.doctor2_name} />
                <Row label="連絡先" value={s.doctor2_phone} />
              </>
            )}
          </div>

          {svcs.length > 0 && (
            <>
              <SectionTitle color="bg-green-50 text-green-800">利用中サービス</SectionTitle>
              <div className="bg-white rounded-xl border divide-y">
                {svcs.map((svc, i) => (
                  <div key={i} className="p-3 text-sm">
                    <div className="font-medium">{svc.service_type}</div>
                    <div className="text-gray-600">{svc.provider_name}</div>
                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                      <span>{svc.phone}</span>
                      <span>{svc.schedule}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {devs.length > 0 && (
            <>
              <SectionTitle color="bg-yellow-50 text-yellow-800">
                充電式を含む電動の医療・介護機器
              </SectionTitle>
              <div className="bg-white rounded-xl border divide-y">
                {devs.map((dev, i) => (
                  <div key={i} className="p-3 text-sm">
                    <div className="font-medium">{dev.item}</div>
                    <div className="text-gray-600">{dev.provider}</div>
                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                      <span>{dev.phone}</span>
                      {dev.notes && <span>{dev.notes}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <SectionTitle color="bg-gray-100 text-gray-800">
            <Shield size={14} className="inline mr-1" />担当ケアマネジャー
          </SectionTitle>
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
          <button
            onClick={() => {
              setScreen("managers");
              setSelectedManager(null);
            }}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 active:bg-gray-200"
          >
            <ChevronLeft size={20} />
          </button>
          <div>
            <h1 className="text-base font-bold text-gray-900">{selectedManager.name}</h1>
            <p className="text-xs text-gray-500">担当利用者一覧</p>
          </div>
        </div>

        {loadingUsers ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        ) : (
          <div className="p-4">
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-t-xl text-xs font-bold text-gray-600">
              <span className="flex-1">利用者名</span>
              <span className="w-16 text-center">安否確認</span>
              <span className="w-16 text-center">サービス</span>
            </div>

            <div className="bg-white rounded-b-xl border divide-y divide-gray-100">
              {users.map((u) => (
                <div key={u.id} className="flex items-center gap-2 px-3 py-2.5">
                  <button
                    onClick={() => openSheet(u.id)}
                    className="flex-1 text-left text-sm font-medium text-blue-700 active:text-blue-900"
                    disabled={loadingSheet}
                  >
                    {u.name}
                    <span className="block text-[10px] text-gray-400">{u.name_kana}</span>
                  </button>

                  <div className="w-16">
                    <select
                      value={u.safety_status}
                      onChange={(e) => updateStatus(u.id, "safety_status", e.target.value)}
                      className={cn(
                        "w-full text-center text-sm font-bold rounded-lg border py-1.5 appearance-none cursor-pointer",
                        STATUS_COLORS[u.safety_status] || STATUS_COLORS[""]
                      )}
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o} value={o}>{o || "—"}</option>
                      ))}
                    </select>
                  </div>

                  <div className="w-16">
                    <select
                      value={u.service_status}
                      onChange={(e) => updateStatus(u.id, "service_status", e.target.value)}
                      className={cn(
                        "w-full text-center text-sm font-bold rounded-lg border py-1.5 appearance-none cursor-pointer",
                        STATUS_COLORS[u.service_status] || STATUS_COLORS[""]
                      )}
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o} value={o}>{o || "—"}</option>
                      ))}
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
