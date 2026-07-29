// 出勤簿まわり (payroll-app から移植したコード) 用の supabase client shim。
// payroll-app は `import { supabase } from "@/lib/supabase"` の singleton 流儀なので、
// kaigo-app の createClient() をそのまま singleton として輸出して差分を吸収する。
"use client";

import { createClient } from "@/lib/supabase/client";

export const supabase = createClient();
