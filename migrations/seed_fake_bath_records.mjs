// 訪問入浴 サンプルデータ投入 (dry-run 付き)
//   node migrations/seed_fake_bath_records.mjs            # DRY RUN
//   node migrations/seed_fake_bath_records.mjs --execute  # 本番
//
// 対象: 訪問入浴 5 事業所すべて。訪問介護用の架空サンプル利用者(OY001-010)を
//       2 名ずつ client_office_assignments で割当(marker付) + 2026-07 の入浴記録を投入。
//       すべて marker 付きで後から削除可能。
//
// クリーンアップ SQL:
//   DELETE FROM kaigo_bath_visit_records WHERE notes LIKE '%[fake 訪問入浴サンプル-2026-07]%';
//   DELETE FROM client_office_assignments WHERE service_notes = '[fake 訪問入浴サンプル]';

import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
// 訪問入浴 5 事業所 (どこを開いてもサンプルが見えるように全てへ投入)
const OFFICES = [
  { id: "8456a0f3-1882-48a7-9b79-71e8dc389df1", name: "Ｈａｎａ訪問入浴花見川" },
  { id: "e00a3a11-92ac-4876-80ff-b0023201c7aa", name: "リンクス訪問入浴" },
  { id: "a55c7870-9af8-4140-b3c1-84d44207441b", name: "リンクス訪問入浴茂原" },
  { id: "52a60486-70a4-43d4-b786-82f4afa464c4", name: "Ｈａｎａ訪問入浴" },
  { id: "ec87a203-53e2-40a5-b706-7fea402cde16", name: "ムツミ訪問入浴" },
];
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
  // 訪問介護用の架空サンプル利用者 (OY001..OY010)
  const wantNos = Array.from({ length: 10 }, (_, i) => `OY${String(i + 1).padStart(3, "0")}`);
  const pool = await rest(
    `clients?tenant_id=eq.${TENANT}&user_number=in.(${wantNos.join(",")})&select=id,name,furigana,user_number`
  );
  const fakeClients = wantNos.map((no) => pool.find((c) => c.user_number === no)).filter(Boolean);
  if (fakeClients.length < 1) {
    throw new Error("架空サンプル利用者(OY001-)が見つかりません。先に seed_fake_houmonkaigo_clients.mjs を実行してください。");
  }
  const staff = await rest(`members?status=eq.active&select=id,name&order=name&limit=3`);
  const staffIds = staff.map((s) => s.id);

  const days = [3, 10, 17];
  const assignments = [];
  const records = [];

  OFFICES.forEach((office, oi) => {
    // 各事業所に 2 名ずつ (利用者が足りなければ巡回)
    const clients = [0, 1].map((k) => fakeClients[(oi * 2 + k) % fakeClients.length]);
    clients.forEach((c, ci) => {
      assignments.push({ tenant_id: TENANT, client_id: c.id, office_id: office.id, start_date: "2026-07-01", service_notes: ASSIGN_MARKER });
      days.forEach((d, di) => {
        const bathType = di === 1 ? "部分浴" : "全身浴";
        const staffOnly = (oi + ci) % 3 === 2;
        records.push({
          client_id: c.id,
          office_id: office.id,
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
  });

  console.log(`対象 ${OFFICES.length}事業所 / 架空利用者 ${fakeClients.length}名 / 職員 ${staff.length}名`);
  OFFICES.forEach((o, oi) => {
    const cs = [0, 1].map((k) => fakeClients[(oi * 2 + k) % fakeClients.length].name);
    console.log(`  ${o.name}: ${cs.join("、")}`);
  });
  console.log(`\n投入予定: 割当 ${assignments.length}件 / 入浴記録 ${records.length}件`);

  if (!EXECUTE) {
    console.log("\n[DRY RUN] 実際には投入していません。--execute で本番投入。");
    return;
  }

  // 冪等性: 既存のマーカー分を全事業所で先に削除
  await rest(`kaigo_bath_visit_records?notes=like.*${encodeURIComponent(REC_MARKER)}*`, { method: "DELETE" });
  await rest(`client_office_assignments?service_notes=eq.${encodeURIComponent(ASSIGN_MARKER)}`, { method: "DELETE" });

  const insAssign = await rest("client_office_assignments", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(assignments) });
  const insRec = await rest("kaigo_bath_visit_records", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(records) });
  console.log(`\n[OK] 割当 ${insAssign.length}件 / 入浴記録 ${insRec.length}件 を投入しました。`);
};

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
