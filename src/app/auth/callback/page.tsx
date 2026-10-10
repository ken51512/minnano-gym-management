"use client";

import { useEffect, useState } from "react";
import { appPath } from "@/lib/app-path";
import { runRecoveryPkceCallback } from "@/lib/recovery-core";
import { createRecoveryBrowserClient } from "@/lib/supabase-browser";

const RECOVERY_MARKER = "minnano-recovery-flow";

export default function RecoveryCallbackPage() {
  const [message, setMessage] = useState("再設定リンクを確認しています。");

  useEffect(() => {
    let active = true;
    const client = createRecoveryBrowserClient();
    const code = new URLSearchParams(window.location.search).get("code");
    void runRecoveryPkceCallback(
      code,
      (authCode) => client.auth.exchangeCodeForSession(authCode),
      async () => {
        const { data, error } = await client.auth.getUser();
        if (error || !data.user) throw new Error("Recovery session is unavailable");
      },
    ).then((result) => {
      if (!active) return;
      if (result.stage === "ready") {
        window.sessionStorage.setItem(RECOVERY_MARKER, "active");
        window.location.replace(appPath("/auth/reset-password/"));
      } else {
        window.location.replace(appPath("/auth/recovery/?state=invalid"));
      }
    }).catch(() => { if (active) setMessage("再設定リンクを確認できませんでした。"); });
    return () => { active = false; };
  }, []);

  return <main className="login-screen"><section className="login-card"><p role="status">{message}</p></section></main>;
}
