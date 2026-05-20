"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { isValidLoginId } from "@/lib/login_id";
import { ensureDeviceId, detectDeviceLabel } from "@/lib/device_id";

export default function LoginPage() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const router = useRouter();

  function isResolvableIdentifier(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.includes("@")) return true; // 実 email
    return isValidLoginId(trimmed);
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isResolvableIdentifier(identifier)) {
      toast.error("ログイン ID または メールアドレスの形式が正しくありません");
      return;
    }
    setLoading(true);
    setInfo(null);
    try {
      // Phase 11c: device_id と一緒に /api/login へ送信 (trust check 用)
      const deviceId = ensureDeviceId();
      const deviceLabel = detectDeviceLabel();
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: identifier.trim(),
          password,
          device_id: deviceId,
          device_label: deviceLabel,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        status?: "approval_required" | "device_revoked";
        message?: string;
      };

      if (res.ok && data.ok) {
        router.push("/");
        router.refresh();
        return;
      }
      // 202: 承認待ち
      if (res.status === 202 || data.status === "approval_required") {
        setInfo(
          data.message ??
            "新しい端末からのログインです。管理者の承認をお待ちください。"
        );
        return;
      }
      // 403: 端末失効 等
      if (res.status === 403) {
        toast.error(
          data.message ??
            "この端末は無効化されています。管理者に連絡してください。"
        );
        return;
      }
      // 401: 認証失敗 (or その他)
      toast.error(data.message ?? "ログインに失敗しました");
    } catch {
      toast.error("ログインに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-blue-700">介護管理システム</h1>
          <p className="mt-2 text-sm text-gray-500">
            ログインしてください
          </p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              ログイン ID または メールアドレス
            </label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoComplete="username"
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="staff001 または name@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              パスワード
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="パスワード"
            />
          </div>
          {info && (
            <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {info}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "ログイン中..." : "ログイン"}
          </button>
        </form>
      </div>
    </div>
  );
}
