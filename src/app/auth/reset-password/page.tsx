"use client";

import { useEffect, useState, type FormEvent } from "react";
import { appPath } from "@/lib/app-path";
import { hasRecoveryProof, recoveryPasswordsMatch, updatePasswordWithRecoveryProof } from "@/lib/recovery-core";
import { createRecoveryBrowserClient } from "@/lib/supabase-browser";

type ViewState = "checking" | "ready" | "invalid" | "done";
const RECOVERY_MARKER = "minnano-recovery-flow";

export default function ResetPasswordPage() {
  const [state, setState] = useState<ViewState>("checking");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void createRecoveryBrowserClient().auth.getUser().then(({ data, error }) => {
      if (!active) return;
      const proof = hasRecoveryProof(window.sessionStorage.getItem(RECOVERY_MARKER) ?? undefined, Boolean(data.user) && !error);
      setState(proof ? "ready" : "invalid");
    }).catch(() => { if (active) setState("invalid"); });
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !recoveryPasswordsMatch(password, confirmation)) {
      setMessage("新しいパスワードが一致しません。");
      return;
    }
    setPending(true); setMessage("");
    const client = createRecoveryBrowserClient();
    const { data, error } = await client.auth.getUser();
    const result = await updatePasswordWithRecoveryProof(
      hasRecoveryProof(window.sessionStorage.getItem(RECOVERY_MARKER) ?? undefined, Boolean(data.user) && !error),
      () => client.auth.updateUser({ password }),
    );
    if (result.status === "updated") {
      window.sessionStorage.removeItem(RECOVERY_MARKER);
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      setPassword(""); setConfirmation(""); setState("done");
      setMessage("パスワードを更新しました。ログイン画面から新しいパスワードでログインしてください。");
    } else if (result.status === "recovery_required") {
      setState("invalid");
    } else {
      setMessage("更新できませんでした。通信状態を確認して、必要なら再設定メールを依頼してください。");
    }
    setPending(false);
  };

  return <main className="login-screen"><section className="login-card" aria-labelledby="reset-title">
    <div className="brand-mark brand-mark--large" aria-hidden="true">MG</div>
    <p className="eyebrow">ACCOUNT RECOVERY</p><h1 id="reset-title">新しいパスワード</h1>
    {state === "checking" && <p role="status">再設定リンクを確認しています。</p>}
    {state === "invalid" && <><p role="status">再設定リンクが無効か、有効期限が切れています。</p><p><a href={appPath("/auth/recovery/")}>新しい再設定メールを依頼</a></p></>}
    {state === "ready" && <form className="login-form" onSubmit={submit}>
      <label className="field"><span>新しいパスワード</span><input type="password" autoComplete="new-password" required maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending} /></label>
      <label className="field"><span>新しいパスワード（確認）</span><input type="password" autoComplete="new-password" required maxLength={1024} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={pending} /></label>
      <button className="primary-button" type="submit" disabled={pending}>{pending ? "更新中" : "パスワードを更新"}</button>
    </form>}
    {message && <p role="status" className="save-feedback">{message}</p>}
    {(state === "done" || state === "invalid") && <p className="field-help"><a href={appPath("/")}>ログイン画面へ戻る</a></p>}
  </section></main>;
}
