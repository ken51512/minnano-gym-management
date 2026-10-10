"use client";

import { useEffect, useState, type FormEvent } from "react";
import { createRecoveryBrowserClient } from "@/lib/supabase-browser";
import { appAbsoluteUrl, appPath } from "@/lib/app-path";
import { checkRecoveryAuthSettings, classifyRecoveryRequestFailure, recoveryAttemptedAfterFailure, recoveryEmailRequestDisabled, type RecoveryServiceDisplayState } from "@/lib/recovery-core";

export default function RecoveryPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState("");
  const [serviceState, setServiceState] = useState<RecoveryServiceDisplayState>("checking");

  useEffect(() => {
    let active = true;
    void checkRecoveryAuthSettings(fetch, process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
      .then((state) => { if (active) setServiceState(state); });
    const query = new URLSearchParams(window.location.search);
    if (query.get("state") === "invalid") {
      setNotice("リンクを確認できないか、有効期限が切れています。新しい再設定メールを依頼してください。");
      window.history.replaceState(null, "", appPath("/auth/recovery/"));
    }
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || attempted) return;
    setPending(true);
    setAttempted(true);
    try {
      const { error } = await createRecoveryBrowserClient().auth.resetPasswordForEmail(email.trim(), { redirectTo: appAbsoluteUrl(window.location.origin, "/auth/callback/") });
      setNotice(error
        ? requestFailureNotice(classifyRecoveryRequestFailure(error))
        : "該当するアカウントがある場合、再設定メールを送信しました。受信した端末・ブラウザでリンクを開いてください。");
      if (error) setAttempted(recoveryAttemptedAfterFailure(classifyRecoveryRequestFailure(error)));
    } catch (error) {
      const failure = classifyRecoveryRequestFailure(error);
      setNotice(requestFailureNotice(failure));
      setAttempted(recoveryAttemptedAfterFailure(failure));
    } finally {
      setPending(false);
    }
  };

  return <main className="login-screen"><section className="login-card" aria-labelledby="recovery-title">
    <div className="brand-mark brand-mark--large" aria-hidden="true">MG</div>
    <p className="eyebrow">ACCOUNT RECOVERY</p>
    <h1 id="recovery-title">パスワード再設定</h1>
    <p className="login-description">登録したメールアドレスを入力してください。該当アカウントの有無は画面に表示しません。</p>
    <p className="field-help" role="status">{recoveryServiceNotice(serviceState)}</p>
    <form className="login-form" onSubmit={submit}>
      <label className="field"><span>メールアドレス</span><input type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} disabled={recoveryEmailRequestDisabled(pending, attempted)} /></label>
      <button className="primary-button" type="submit" disabled={recoveryEmailRequestDisabled(pending, attempted)}>{pending ? "送信中" : "再設定メールを依頼"}</button>
    </form>
    {notice && <p className="save-feedback" role="status">{notice}</p>}
    <p className="field-help"><a href={appPath("/")}>ログイン画面へ戻る</a></p>
  </section></main>;
}

function recoveryServiceNotice(state: RecoveryServiceDisplayState): string {
  if (state === "checking") return "Authサービス接続を確認しています。";
  if (state === "ready") return "Authサービスへ接続できます。ログイン状態の確認は不要です。";
  if (state === "not_configured") return "Authの公開設定を読み込めません。";
  if (state === "public_config_rejected") return "Authの公開接続設定を確認してください。";
  if (state === "unavailable") return "Authサービスが一時的に利用できません。";
  return "Authサービスへの通信状態を確認できません。";
}

function requestFailureNotice(code: ReturnType<typeof classifyRecoveryRequestFailure>): string {
  if (code === "client_not_ready") return "Authクライアントを初期化できません。設定を確認してください。（client_not_ready）";
  if (code === "request_rejected") return "Authサービスが依頼を受け付けませんでした。（request_rejected）";
  if (code === "public_config_rejected") return "Authサービスが公開接続設定を拒否しました。（public_config_rejected）";
  if (code === "unavailable") return "Authサービスが一時的に利用できません。重複依頼を避けるため、この画面を再読み込みしてから再試行してください。（unavailable）";
  return "送信結果を確認できません。重複依頼を避けるため、この画面を再読み込みしてから再試行してください。（network）";
}
