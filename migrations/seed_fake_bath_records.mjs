// 訪問入浴 サンプルデータ投入 (dry-run 付き)
//   node migrations/seed_fake_bath_records.mjs            # DRY RUN
//   node migrations/seed_fake_bath_records.mjs --execute  # 本番
//
// 対象: Ｈａｎａ訪問入浴花見川。利用者4名を client_office_assignments で割当(marker付) +
//       2026-07 の入浴記録を複数投入。すべて marker 付きで後から削除可能。
//
// クリーンアップ SQL:
//   DELETE FROM kaigo_bath_visit_records WHERE notes LIKE '%[fake 訪問入浴サンプル-2026-07]%';
//   DELETE FROM client_office_assignments WHERE service_notes = '[fake 訪問入浴サンプル]';

import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = "8456a0f3-1882-48a7-9b79-71e8dc389df1"; // Ｈａｎａ訪問入浴花見川
const TENANT = "kt-group";
const REC_MARKER = "[fake 訪問入浴サンプル-2026-07]";
const ASSIGN_MARKER = "[fake 訪問入浴サンプル]";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
const SB_URL = /NEXT_PUBLIC_SUPABASE_URL=(\S+)/.exec(env)[1].trim();
const KEY = /SUPABASE_SERVICE_ROLE_KEY=(\S+)/.exec(env)[1].trim();

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path} :: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function resolveBathCode(bathType, staffOnly) {
  if (bathType === "全身浴") return staffOnly ? "121121" : "121111";
  return staffOnly ? "121122" : "121112";
}

const main = async () => {
  // 割当対象 = 訪問介護用の架空サンプル利用者 (user_number OY001..OY004)
  // (seed_fake_houmonkaigo_clients.mjs で作成した fake 10 名のうち先頭 4 名)
  const wantNos = ["OY001", "OY002", "OY003", "OY004"];
  const pool = await rest(
    `clients?tenant_id=eq.${TENANT}&user_number=in.(${wantNos.join(",")})&select=id,name,furigana,user_number`
  );
  const clients = wantNos.map((no) => pool.find((c) => c.user_number === no)).filter(Boolean);
  if (clients.length < 1) {
    throw new Error("架空サンプル利用者(OY001-OY004)が見つかりません。先に seed_fake_houmonkaigo_clients.mjs を実行してください。");
  }
  // 従事職員 3名
  const staff = await rest(`members?status=eq.active&select=id,name&order=name&limit=3`);
  const staffIds = staff.map((s) => s.id);

  console.log(`office=Ｈａｎａ訪問入浴花見川 / 利用者 ${clients.length}名 / 職員 ${staff.length}名`);
  console.log("利用者:", clients.map((c) => c.name).join("、"));

  // 割当 payload
  const assignments = clients.map((c) => ({
    tenant_id: TENANT,
    client_id: c.id,
    office_id: OFFICE_ID,
    start_date: "2026-07-01",
    service_notes: ASSIGN_MARKER,
  }));

  // 入浴記録 payload: 各利用者に 3回 (3,10,17日)
  const days = [3, 10, 17];
  const records = [];
  clients.forEach((c, ci) => {
    days.forEach((d, di) => {
      const bathType = di === 1 ? "部分浴" : "全身浴";
      const staffOnly = ci % 3 === 2; // 一部を職員のみ
      records.push({
        client_id: c.id,
        office_id: OFFICE_ID,
        tenant_id: TENANT,
        visit_date: `2026-07-${String(d).padStart(2, "0")}`,
        start_time: "10:00",
        end_time: "10:45",
        bath_type: bathType,
        staff_only: staffOnly,
        service_code: resolveBathCode(bathType, staffOnly),
        staff_ids: staffIds,
        vital_temperature: 36.2 + ((ci + di) % 5) * 0.1,
        vital_bp_sys: 120 + ci * 4,
        vital_bp_dia: 72 + di * 2,
        vital_pulse: 68 + di,
        vital_spo2: 97,
        water_temp: 40 + (di % 2),
        condition_before: "入浴前の状態安定。",
        condition_after: "入浴後、爽快感あり。皮膚トラブルなし。",
        skin_notes: "背部に軽度の乾燥。保湿剤塗布。",
        addon_shokai: di === 0 && ci === 0,
        addon_ninchi: ci === 1 ? "I" : null,
        addon_chuusankan: false,
        notes: `サンプル入浴記録。${REC_MARKER}`,
        status: "confirmed",
      });
    });
  });

  console.log(`\n投入予定: 割当 ${assignments.length}件 / 入浴記録 ${records.length}件`);
  if (!EXECUTE) {
    console.log("\n[DRY RUN] 実際には投入していません。--execute で本番投入。");
    console.log("記録サンプル(先頭):", JSON.stringify(records[0], null, 2));
    return;
  }

  // 冪等性: 既存のマーカー分を先に削除
  await rest(`kaigo_bath_visit_records?office_id=eq.${OFFICE_ID}&notes=like.*${encodeURIComponent(REC_MARKER)}*`, { method: "DELETE" });
  await rest(`client_office_assignments?office_id=eq.${OFFICE_ID}&service_notes=eq.${encodeURIComponent(ASSIGN_MARKER)}`, { method: "DELETE" });

  const insAssign = await rest("client_office_assignments", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(assignments),
  });
  const insRec = await rest("kaigo_bath_visit_records", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(records),
  });
  console.log(`\n[OK] 割当 ${insAssign.length}件 / 入浴記録 ${insRec.length}件 を投入しました。`);
};

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
