"use client";

import { useEffect, useRef, useState } from "react";
import type { MonthlyChange } from "@/lib/monthly-service-core";
import { closingReadiness } from "@/lib/monthly-query-core";
import { sumEnteredExpenseAmounts } from "@/lib/expense-total-core";
import { canRegisterExpenseItem, canSaveExpenseAmount, expenseItemLimit } from "@/lib/expense-item-core";
import { isValidTargetYear, loadRememberedTargetYear, saveRememberedTargetYear, targetPeriod } from "@/lib/target-year-core";
import { fetchMonthlySnapshot, fetchSimulationHistory, fetchVerifiedSession, postMonthlyMutation, resolveVerifiedSession, signInWithBrowserPassword, signOutBrowserSession } from "@/lib/monthly-ui-client";
import type { SimulationMonth } from "@/lib/simulator-core";
import { calculateSimulation, eligibleSimulationMonths, monthlyMetrics } from "@/lib/simulator-core";
import { appPath } from "@/lib/app-path";
import {
  createPendingMonthlyRequest,
  isPendingMonthlyRequest,
  pendingMonthlyRequestBelongsToActor,
  PENDING_MONTHLY_REQUEST_KEY,
  readPendingMonthlyRequest,
  type PendingMonthlyRequest,
  type MonthlyMutationBody,
} from "@/lib/monthly-request-core";

type Role = "ALBA_ADMIN" | "EARNES" | null;
type Screen = "login" | "dashboard" | "entry" | "expenses" | "review" | "comparison" | "history" | "management";
type ScreenLink = { id: Screen; label: string; shortLabel?: string; group?: string };

const screens: readonly Screen[] = ["login", "dashboard", "entry", "expenses", "review", "comparison", "history", "management"];

function requestedScreen(value: string | undefined): Screen {
  return value && screens.includes(value as Screen) ? value as Screen : "dashboard";
}

type AuthState = "checking" | "signed_out" | "ready" | "reauth_required" | "unavailable";
type SaveState = "idle" | "unsaved" | "saving" | "saved" | "failed" | "outcome_unknown";
type ApiSnapshot = {
  period: { year: number; month: number }; exists: boolean; closed: boolean;
  revenueEntries: { id: string; description: string; amount: number }[];
  expenseEntries: { id: string; categoryId: string; categoryName: string; description: string; amount: number; expenseItemId: string | null }[];
  expenseItems: { id: string; categoryId: string; categoryName: string; name: string; expenseEntryId: string | null; amount: number | null }[];
  expenseCategories: { id: string; name: string }[];
  membershipStats: { memberCount: number | null; newMembers: number | null; cancellations: number | null } | null;
};
function isApiSnapshot(value: unknown, requestedPeriod: string): value is ApiSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const match = /^(\d{4})-(\d{2})$/.exec(requestedPeriod);
  if (!match || !snapshot.period || typeof snapshot.period !== "object" || Array.isArray(snapshot.period)) return false;
  const period = snapshot.period as Record<string, unknown>;
  if (period.year !== Number(match[1]) || period.month !== Number(match[2]) || typeof snapshot.exists !== "boolean" || typeof snapshot.closed !== "boolean" || (!snapshot.exists && snapshot.closed)) return false;
  const objectRows = (key: string) => { const rows = snapshot[key]; return Array.isArray(rows) && rows.every((row) => !!row && typeof row === "object" && !Array.isArray(row)); };
  if (!objectRows("revenueEntries") || !objectRows("expenseEntries") || !objectRows("expenseItems") || !objectRows("expenseCategories")) return false;
  const membership = snapshot.membershipStats;
  if (membership !== null && (!membership || typeof membership !== "object" || Array.isArray(membership) || !["memberCount", "newMembers", "cancellations"].every((key) => {
    const count = (membership as Record<string, unknown>)[key];
    return count === null || (typeof count === "number" && Number.isSafeInteger(count));
  }))) return false;
  return true;
}

const primaryLinks: ScreenLink[] = [
  { id: "dashboard", label: "ホーム", shortLabel: "ホーム", group: "日々の管理" },
  { id: "entry", label: "月次入力", shortLabel: "入力" },
  { id: "expenses", label: "経費明細" },
  { id: "review", label: "月次確認" },
  { id: "comparison", label: "比較・年間", shortLabel: "推移", group: "振り返り" },
  { id: "history", label: "変更履歴" },
];

function ScreenButton({ link, active, onClick, disabled = false, compact = false }: {
  link: ScreenLink;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`screen-link${active ? " is-active" : ""}${compact ? " is-compact" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={disabled ? `${link.label}。ALBA_ADMINの認証が必要です` : link.label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="screen-link-mark" aria-hidden="true">{link.id === "dashboard" ? "⌂" : link.id === "entry" ? "＋" : link.id === "expenses" ? "▤" : link.id === "review" ? "✓" : link.id === "comparison" ? "↗" : link.id === "history" ? "◷" : link.id === "management" ? "⚙" : "↪"}</span>
      <span>{compact ? (link.shortLabel ?? link.label) : link.label}</span>
      {disabled && <span className="screen-link-lock">ALBA</span>}
    </button>
  );
}

function StatusBadge({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "warning" | "success" }) {
  return <span className={`status-badge status-badge--${tone}`}><span className="status-dot" aria-hidden="true" />{children}</span>;
}

function UnavailableValue({ reason = "データ未接続", large = false }: { reason?: string; large?: boolean }) {
  return <span className={`unavailable-value${large ? " is-large" : ""}`} aria-label={`未取得。${reason}`}>—<small>{reason}</small></span>;
}

function PanelHeading({ title, hint, aside }: { title: string; hint?: string; aside?: React.ReactNode }) {
  return (
    <div className="panel-heading">
      <div className="panel-heading-copy">
        <h2>{title}</h2>
        {hint && <p className="text-muted">{hint}</p>}
      </div>
      {aside}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">···</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function ConnectionNotice() { return null; }


function TargetMonth({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [year, setYear] = useState(value.slice(0, 4));
  const [month, setMonth] = useState(value.slice(5, 7));
  const initialized = useRef(false);
  useEffect(() => {
    if (/^\d{4}-\d{2}$/.test(value)) {
      const selectedYear = value.slice(0, 4);
      setYear(selectedYear);
      setMonth(value.slice(5, 7));
      saveRememberedTargetYear(selectedYear);
    } else if (!initialized.current) {
      setYear(loadRememberedTargetYear());
    }
    initialized.current = true;
  }, [value]);
  const update = (nextYear: string, nextMonth: string) => {
    onChange(targetPeriod(nextYear, nextMonth) ?? "");
  };
  return (
    <div className="month-picker">
      <span>{"\u5bfe\u8c61\u6708"}</span>
      <input className="month-year-input" type="text" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={year} disabled={disabled} onChange={(event) => { const next = event.target.value.replace(/\D/g, "").slice(0, 4); setYear(next); if (isValidTargetYear(next)) saveRememberedTargetYear(next); update(next, month); }} aria-label={"\u5bfe\u8c61\u5e74\u30924\u6841\u3067\u5165\u529b"} placeholder="YYYY" />
      <select value={month} disabled={disabled} onChange={(event) => { setMonth(event.target.value); update(year, event.target.value); }} aria-label={"\u5bfe\u8c61\u6708\u3092\u9078\u629e"}><option value="">{"\u6708"}</option>{Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map((item) => <option key={item} value={item}>{item}{"\u6708"}</option>)}</select>
    </div>
  );
}
function PeriodState({ month }: { month: string }) {
  return (
    <div className="period-state" aria-live="polite">
      <div><span className="state-label">{"\u5bfe\u8c61\u6708"}</span><strong>{month || "\u672a\u9078\u629e"}</strong></div>
      <div><span className="state-label">{"\u30c7\u30fc\u30bf"}</span><StatusBadge>{month ? "\u4e0a\u90e8\u306e\u72b6\u614b\u3092\u78ba\u8a8d" : "\u5bfe\u8c61\u6708\u3092\u9078\u629e"}</StatusBadge></div>
      <div><span className="state-label">{"\u4fdd\u5b58"}</span><span className="save-state">{"\u4e0a\u90e8\u306e\u72b6\u614b\u3092\u78ba\u8a8d"}</span></div>
    </div>
  );
}
function ScreenTitle({ eyebrow, title, description, month }: { eyebrow: string; title: string; description: string; month: string }) {
  return (
    <header className="screen-title">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="screen-description">{description}</p></div>
      <PeriodState month={month} />
    </header>
  );
}

const dashboardMetrics = [
  { label: "売上", unit: "円", icon: "↗", kind: "money" },
  { label: "経費", unit: "円", icon: "↘", kind: "money" },
  { label: "粗利", unit: "円", icon: "＝", kind: "money" },
  { label: "EarneS報酬", unit: "円", icon: "◇", kind: "money" },
  { label: "会員数", unit: "人", icon: "♧", kind: "count" },
] as const;

function Dashboard({ month, navigate, snapshot, authState }: { month: string; navigate: (screen: Screen) => void; snapshot: ApiSnapshot | null; authState: AuthState }) {
  const revenueEntered = (snapshot?.revenueEntries.length ?? 0) > 0;
  const expensesEntered = (snapshot?.expenseEntries.length ?? 0) > 0;
  const stats = snapshot?.membershipStats;
  const actual = snapshot?.exists ? monthlyMetrics({ year: snapshot.period.year, month: snapshot.period.month, memberCount: stats?.memberCount ?? null, revenueAmounts: snapshot.revenueEntries.map((entry) => entry.amount), expenseAmounts: snapshot.expenseEntries.map((entry) => entry.amount), expenseCategoryAmounts: snapshot.expenseEntries.map((entry) => ({ categoryName: entry.categoryName, amount: entry.amount })), cancellations: stats?.cancellations ?? null }) : null;
  const format = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString();
  const moneyValues = [actual?.revenue ?? null, actual?.expense ?? null, actual?.operatingProfit ?? null, actual?.albaReward ?? null, actual?.earnesReward ?? null];
  return (
    <div className="screen-stack">
      <ScreenTitle eyebrow="概要" title="ホーム" description="選択した月の保存済みデータを表示します。" month={month} />
      {authState === "ready" && !month && <section className="connection-notice" role="status"><strong>月を選択してください</strong><p>選択した月の保存済みデータを読み込みます。月や数値は自動入力しません。</p></section>}
      {authState === "ready" && month && !snapshot && <p className="connection-notice" role="status">月次データを読み込んでいます。表示されない場合は月次入力画面で再取得してください。</p>}
      {snapshot && !snapshot.exists && <p className="connection-notice" role="status">この月の保存済みレコードはありません。データは作成していません。</p>}
      {authState !== "ready" && <p className="connection-notice" role="status">認証済みセッションを確認すると、月次データを表示できます。</p>}
      <section className="section-block" aria-labelledby="dashboard-finance-title">
        <PanelHeading title="月次サマリー" hint={snapshot?.exists ? "選択月の保存済み明細から集計しています。" : "保存済みレコードがある月を選択してください。"} aside={<span className="unit-note">金額：円</span>} />
        <div className="metric-grid dashboard-metrics">
          {[
            { label: "売上", icon: "↗" }, { label: "経費", icon: "↘" }, { label: "営業利益", icon: "＝" }, { label: "ALBA報酬", icon: "◇" }, { label: "EarneS報酬", icon: "◇" },
          ].map((metric, index) => (
            <article className="metric-card" key={metric.label}>
              <div className="metric-card-top"><span className="metric-icon" aria-hidden="true">{metric.icon}</span><span className="metric-label">{metric.label}</span></div>
              <strong className="unavailable-value is-large">{snapshot?.exists ? format(moneyValues[index]) : "—"}</strong>
              <span className="metric-unit">円</span>
            </article>
          ))}
          <article className="metric-card"><div className="metric-card-top"><span className="metric-label">会員数（前月末）</span></div><strong className="unavailable-value is-large">{snapshot?.exists ? format(stats?.memberCount) : "—"}</strong><span className="metric-unit">人</span></article>
        </div>
      </section>
      <section className="section-block" aria-label="会員数と入退会">
        <div className="metric-grid secondary-metrics">
          <article className="metric-card compact-metric"><span className="metric-label">新規入会</span><strong>{snapshot?.exists ? format(stats?.newMembers) : "—"}</strong><span className="metric-unit">人</span></article>
          <article className="metric-card compact-metric"><span className="metric-label">退会</span><strong>{snapshot?.exists ? format(stats?.cancellations) : "—"}</strong><span className="metric-unit">人</span></article>
          <article className="metric-card compact-metric"><span className="metric-label">人件費率</span><strong>{snapshot?.exists && actual?.laborRate !== null && actual?.laborRate !== undefined ? `${(actual.laborRate * 100).toFixed(1)}%` : "—"}</strong></article>
          <article className="metric-card compact-metric"><span className="metric-label">広告費率</span><strong>{snapshot?.exists && actual?.advertisingRate !== null && actual?.advertisingRate !== undefined ? `${(actual.advertisingRate * 100).toFixed(1)}%` : "—"}</strong></article>
          <article className="metric-card compact-metric"><span className="metric-label">営業利益率</span><strong>{snapshot?.exists && actual?.operatingMargin !== null && actual?.operatingMargin !== undefined ? `${(actual.operatingMargin * 100).toFixed(1)}%` : "—"}</strong></article>
          <article className="metric-card compact-metric"><span className="metric-label">退会率</span><strong>{snapshot?.exists && actual?.cancellationRate !== null && actual?.cancellationRate !== undefined ? `${(actual.cancellationRate * 100).toFixed(2)}%` : "—"}</strong></article>
        </div>
      </section>
      <div className="dashboard-lower-grid">
        <section className="panel"><PanelHeading title="入力状況" hint="選択月の保存済みデータ" /><ul className="status-list">{[["売上", revenueEntered], ["経費", expensesEntered], ["会員数", stats?.memberCount != null], ["新規入会", stats?.newMembers != null], ["退会", stats?.cancellations != null]].map(([label, entered]) => <li key={String(label)}><span>{label}</span><StatusBadge tone={entered ? "success" : "warning"}>{entered ? "入力済み" : "未入力"}</StatusBadge></li>)}</ul><button type="button" className="text-action" onClick={() => navigate("entry")}>月次入力を開く <span aria-hidden="true">→</span></button></section>
        <section className="panel"><PanelHeading title="月次確認" hint="保存済みの入力内容を確認" /><button type="button" className="text-action" onClick={() => navigate("review")}>確定要件を確認 <span aria-hidden="true">→</span></button></section>
      </div>
    </div>
  );
}
function DisabledField({ id, label, helper, type = "text", role = null, value = "", onChange }: {
  id: string;
  label: string;
  helper: string;
  type?: "text" | "number";
  role?: Role;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const allowed = id.startsWith("member-") ? role === "EARNES" || role === "ALBA_ADMIN" : role === "ALBA_ADMIN";
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} disabled={!allowed} onChange={(event) => onChange?.(event.target.value)} aria-describedby={`${id}-help`} />
      <p className="field-help" id={`${id}-help`}>{helper}</p>
    </div>
  );
}

function LoginFrame({ onLogin, authState, authMessage }: { onLogin: (email: string, password: string) => Promise<void>; authState: AuthState; authMessage: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try { await onLogin(email, password); setPassword(""); } finally { setPending(false); }
  };
  return <div className="login-screen"><section className="login-card" aria-labelledby="login-title">
    <div className="brand-mark brand-mark--large" aria-hidden="true">MG</div><p className="eyebrow">MINNANO GYM</p>
    <h1 id="login-title">ログイン</h1><p className="login-description">許可された管理者アカウントでログインしてください。</p>
    <form className="login-form" onSubmit={submit}>
      <label className="field"><span>メールアドレス</span><input type="email" autoComplete="username" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending} /></label>
      <label className="field"><span>パスワード</span><input type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending} /></label>
      <button className="primary-button" type="submit" disabled={pending || authState === "checking"}>{pending ? "確認中…" : "ログイン"}</button>
    </form>
    <p className="field-help"><a href={appPath("/auth/recovery/")}>パスワードを再設定</a></p>
    <p className="field-help">自由なアカウント作成はできません。</p>
    {authMessage && <p className="save-feedback" role="status">{authMessage}</p>}
  </section><p className="login-footnote">パスワードはこの画面のメモリ内でのみ扱います。</p></div>;
}

function SessionCheckingFrame() {
  return <div className="login-screen"><section className="login-card" aria-live="polite">
    <div className="brand-mark brand-mark--large" aria-hidden="true">MG</div>
    <p className="eyebrow">MINNANO GYM</p><h1>ログイン状態を確認中</h1>
    <p className="login-description">保存済みのSupabase sessionを確認しています。</p>
  </section></div>;
}

function ConnectedMonthlyEntry({ month, role, snapshot, refresh, submitMembership, createMonth, saveChange, values, setValues, saveState, saveMessage, expenseProps }: {
  month: string; role: Role; snapshot: ApiSnapshot | null; refresh: () => Promise<void>;
  submitMembership: () => Promise<void>; createMonth: () => Promise<void>; saveChange: (change: MonthlyChange) => Promise<boolean>; values: { memberCount: string; newMembers: string; cancellations: string };
  setValues: (value: { memberCount: string; newMembers: string; cancellations: string }) => void;
  saveState: SaveState; saveMessage: string;
  expenseProps: Omit<React.ComponentProps<typeof ConnectedExpenseDetails>, "month" | "role" | "compact">;
}) {
  const [otherDescription, setOtherDescription] = useState("");
  const [otherAmount, setOtherAmount] = useState("");
  const [draftRevenueAmounts, setDraftRevenueAmounts] = useState<Record<string, string>>({});
  useEffect(() => setDraftRevenueAmounts({}), [month]);
  const editRole = snapshot?.exists && !snapshot.closed && saveState !== "saving" && saveState !== "outcome_unknown" ? role : null;
  const submitOtherRevenue = async () => {
    if (!otherDescription.trim() || !/^-?\d+$/.test(otherAmount) || !Number.isSafeInteger(Number(otherAmount)) || Number(otherAmount) < -2147483648 || Number(otherAmount) > 2147483647) return;
    if (await saveChange({ type: "revenueEntry", operation: "create", description: otherDescription.trim(), amount: Number(otherAmount) })) { setOtherDescription(""); setOtherAmount(""); }
  };
  const readField = (key: keyof typeof values, id: string, label: string) => <DisabledField
    id={id} label={label} helper="0と未入力は区別されます。" type="number" role={editRole} value={values[key]}
    onChange={(value) => setValues({ ...values, [key]: value })} />;
  const revenueSubtotal = snapshot ? snapshot.revenueEntries.reduce((total, entry) => {
    const raw = Object.hasOwn(draftRevenueAmounts, entry.id) ? draftRevenueAmounts[entry.id] : String(entry.amount);
    return /^-?\d+$/.test(raw) ? total + Number(raw) : total;
  }, 0) + (/^-?\d+$/.test(otherAmount) ? Number(otherAmount) : 0) : null;
  const periodNotice = !month
    ? "\u5bfe\u8c61\u6708\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002"
    : !snapshot
      ? saveMessage || "\u5bfe\u8c61\u6708\u306e\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059\u3002"
      : !snapshot.exists
        ? "\u3053\u306e\u6708\u306e\u30ec\u30b3\u30fc\u30c9\u306f\u672a\u4f5c\u6210\u3067\u3059\u3002\u3053\u306e\u753b\u9762\u3067\u4f5c\u6210\u3057\u3066\u304b\u3089\u58f2\u4e0a\u3068\u7d4c\u8cbb\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002"
        : snapshot.closed
          ? "\u3053\u306e\u6708\u306f\u78ba\u5b9a\u6e08\u307f\u3067\u3059\u3002\u901a\u5e38\u7de8\u96c6\u306f\u3067\u304d\u307e\u305b\u3093\u3002"
          : "\u672a\u78ba\u5b9a\u306e\u6708\u3067\u3059\u3002\u58f2\u4e0a\u30fb\u7d4c\u8cbb\u3092\u5165\u529b\u3067\u304d\u307e\u3059\u3002";
  return <div className="screen-stack">
    <ScreenTitle eyebrow="月次入力" title="月次入力" description="確認済みの担当権限で月次データを入力・編集します。" month={month} />
      <p className="connection-notice" role="status">{periodNotice}</p>
    {snapshot && !snapshot.exists && role === "ALBA_ADMIN" && <section className="panel" aria-label="月次データの作成"><PanelHeading title="この月のデータを作成" hint="作成後、売上・経費・会員数を入力できます。作成時点では未入力です。" /><button type="button" className="primary-button" onClick={() => void createMonth()} disabled={!month || saveState === "saving" || saveState === "outcome_unknown"}>{saveState === "saving" ? "作成中…" : "この月を作成"}</button></section>}
    {snapshot?.exists && !snapshot.closed && role === "ALBA_ADMIN" && <section className="panel">
      <PanelHeading title={"\u58f2\u4e0a\u660e\u7d30"} hint={"\u5b9f\u969b\u306e\u5165\u91d1\u3092\u884c\u3054\u3068\u306b\u767b\u9332\u3057\u307e\u3059\u3002"} aside={<span className="role-pill">{"\u7ba1\u7406\u8005"}</span>} />
      {snapshot.revenueEntries.map((entry) => <ExistingEntryEditor key={entry.id} kind="revenueEntry" entry={entry} role={editRole} saveChange={saveChange} busy={saveState === "saving" || saveState === "outcome_unknown"} onDraftChange={(value) => setDraftRevenueAmounts((current) => ({ ...current, [entry.id]: value }))} />)}
      <div className="field-grid field-grid--two">
        <label className="field"><span>{"\u5165\u91d1\u5185\u5bb9"}</span><input value={otherDescription} onChange={(event) => setOtherDescription(event.target.value)} maxLength={200} placeholder="Sugram 1 / Sugram 2 / \u305d\u306e\u4ed6" /></label>
        <label className="field"><span>{"\u5165\u91d1\u984d\uff08\u7a0e\u8fbc\u30fb\u5186\uff09"}</span><input type="number" step="1" value={otherAmount} onChange={(event) => setOtherAmount(event.target.value)} /></label>
        <button type="button" className="primary-button" disabled={!otherDescription.trim() || !/^-?\d+$/.test(otherAmount) || !Number.isSafeInteger(Number(otherAmount)) || Number(otherAmount) < -2147483648 || Number(otherAmount) > 2147483647 || saveState === "saving" || saveState === "outcome_unknown"} onClick={() => void submitOtherRevenue()}>{"\u58f2\u4e0a\u3092\u8ffd\u52a0"}</button>
      </div>
      <p className="field-help">{"Sugram 1\u30fbSugram 2\u3068\u305d\u306e\u4ed6\u306e\u5165\u91d1\u3092\u3001\u5185\u5bb9\u3068\u91d1\u984d\u3067\u8a18\u9332\u3057\u307e\u3059\u3002\u305d\u306e\u4ed6\u306f\u8907\u6570\u884c\u767b\u9332\u3067\u304d\u307e\u3059\u3002"}</p>
      <div className="expense-subtotal" aria-live="polite"><span>売上小計</span><strong>{revenueSubtotal === null ? "—" : `¥${revenueSubtotal.toLocaleString()}`}</strong></div>
    </section>}
    <ConnectedExpenseDetails {...expenseProps} month={month} role={role} compact />
    <section className="panel"><PanelHeading title="会員数集計" hint="対象月の前月末時点の会員数を入力します。" aside={<span className="role-pill role-pill--blue">入力担当：ALBA_ADMIN / EarneS</span>} />
      <p>基準日: {month || "対象月を選択してください"} の前月末</p>
      {snapshot?.membershipStats && <p className="field-help">現在保存済み: 会員 {snapshot.membershipStats.memberCount ?? "未入力"} / 新規 {snapshot.membershipStats.newMembers ?? "未入力"} / 退会 {snapshot.membershipStats.cancellations ?? "未入力"}</p>}
      <div className="field-grid field-grid--three">{readField("memberCount", "member-count", "会員数（前月末）")}{readField("newMembers", "member-new", "新規入会数")}{readField("cancellations", "member-cancel", "退会数")}</div>
      {(role === "EARNES" || role === "ALBA_ADMIN") && <div className="panel-actions"><button type="button" className="secondary-button" onClick={() => void refresh()} disabled={!month || saveState === "saving"}>最新状態を再取得</button><button type="button" className="primary-button" onClick={() => void submitMembership()} disabled={editRole !== "EARNES" && editRole !== "ALBA_ADMIN"}>{saveState === "saving" ? "保存中…" : "会員数を保存"}</button></div>}
      <p className="save-feedback" role="status">{saveMessage || (saveState === "saved" ? "保存済み" : "")}</p>
    </section>
  </div>;
}

function ExistingEntryEditor({ kind, entry, role, saveChange, busy, onDraftChange }: {
  kind: "revenueEntry" | "expenseEntry";
  entry: { id: string; description: string; amount: number; categoryId?: string; categoryName?: string };
  role: Role; saveChange: (change: MonthlyChange) => Promise<boolean>; busy: boolean; onDraftChange?: (value: string) => void;
}) {
  const [description, setDescription] = useState(entry.description);
  const [amount, setAmount] = useState(String(entry.amount));
  const roleAllowed = role === "ALBA_ADMIN";
  const submit = async () => {
    if (!/^-?\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) < -2147483648 || Number(amount) > 2147483647 || !description.trim()) return;
    const saved = await saveChange({ type: kind, operation: "update", id: entry.id, description: description.trim(), amount: Number(amount) });
    if (saved) { setAmount(String(Number(amount))); onDraftChange?.(String(Number(amount))); }
  };
  return <div className="field-grid field-grid--two">
    {kind === "expenseEntry" && <p className="field-label">{entry.categoryName}</p>}
    <label className="field"><span>内容</span><input value={description} onChange={(event) => setDescription(event.target.value)} disabled={!roleAllowed || busy} maxLength={200} /></label>
    <label className="field"><span>金額（税込・円）</span><input type="number" step="1" value={amount} onChange={(event) => { setAmount(event.target.value); onDraftChange?.(event.target.value); }} disabled={!roleAllowed || busy} /></label>
    <button type="button" className="secondary-button" onClick={() => void submit()} disabled={!roleAllowed || busy}>この明細を保存</button>
  </div>;
}

function ExpenseAmountRow({ rowKey, month, label, amount, canEdit, busy, saveState, saveAmount, deleteAmount, deleteItem, nameControl, onDraftChange }: {
  rowKey: string; month: string; label: string; amount: number | null; canEdit: boolean; busy: boolean; saveState: SaveState;
  saveAmount: (amount: number) => Promise<boolean>; deleteAmount?: () => Promise<boolean>; deleteItem?: () => Promise<boolean>; nameControl?: React.ReactNode; onDraftChange?: (value: string) => void;
}) {
  const savedValue = amount === null ? "" : String(amount);
  const [value, setValue] = useState(savedValue);
  useEffect(() => setValue(savedValue), [rowKey, month, savedValue]);
  const numericValue = Number(value);
  const changed = value !== savedValue;
  const canSave = canSaveExpenseAmount({ canEdit, busy, changed, value });
  const status = busy ? saveState === "saving" ? "\u4fdd\u5b58\u4e2d" : "\u7d50\u679c\u78ba\u8a8d\u4e2d" : changed ? "\u672a\u4fdd\u5b58" : amount === null ? "\u672a\u5165\u529b" : "\u4fdd\u5b58\u6e08\u307f";
  const submit = async () => {
    if (!canSave) return;
    if (await saveAmount(numericValue)) setValue(String(numericValue));
  };
  const remove = async () => {
    if (!deleteAmount || amount === null || busy) return;
    const confirmed = window.confirm(`${month.slice(0, 4)}年${Number(month.slice(5, 7))}月／${label}／${amount.toLocaleString()}円 を削除して未入力に戻しますか？`);
    if (!confirmed) return;
    if (await deleteAmount()) { setValue(""); onDraftChange?.(""); }
  };
  const removeItem = async () => {
    if (!deleteItem || busy) return;
    if (!window.confirm("この経費項目を削除しますか？\n過去月の実績は残ります。")) return;
    await deleteItem();
  };
  return <div className="expense-list-row">
    <div className="expense-list-name" title={label}>{label}{nameControl}<span className={`expense-row-status${changed ? " is-dirty" : ""}`}>{status}</span></div>
    <input className="expense-list-amount" type="number" step="1" inputMode="decimal" aria-label={`${label}の金額（円）`} value={value} onChange={(event) => { setValue(event.target.value); onDraftChange?.(event.target.value); }} disabled={!canEdit || busy} />
    <div className="expense-row-actions"><button type="button" className="expense-row-save" onClick={() => void submit()} disabled={!canSave}>{amount === null ? "保存" : "修正"}</button>{deleteAmount && amount !== null && <button type="button" className="expense-row-delete" onClick={() => void remove()} disabled={!canEdit || busy}>金額削除</button>}{deleteItem && <button type="button" className="expense-row-delete expense-item-delete" onClick={() => void removeItem()} disabled={!canEdit || busy}>項目削除</button>}</div>
  </div>;
}

function NamedExpenseAmountRow({ itemId, month, label, amount, canEdit, busy, saveState, saveAmount, deleteAmount, deleteItem, renameItem, onDraftChange }: {
  itemId: string; month: string; label: string; amount: number | null; canEdit: boolean; busy: boolean; saveState: SaveState;
  saveAmount: (amount: number) => Promise<boolean>; deleteAmount: () => Promise<boolean>; deleteItem: () => Promise<boolean>; renameItem: (name: string) => Promise<boolean>; onDraftChange?: (value: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(label);
  useEffect(() => { setName(label); setRenaming(false); }, [itemId, month, label]);
  const nameChanged = name.trim() !== label;
  const nameControl = !canEdit ? null : !renaming
    ? <button type="button" className="expense-rename-link" disabled={busy} onClick={() => setRenaming(true)}>名前変更</button>
    : <>
        <input className="expense-rename-input" aria-label={`${label}の新しい項目名`} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} disabled={busy} />
        <span className="expense-rename-effective">対象月以降</span>
        <button type="button" className="expense-rename-save" disabled={busy || !nameChanged || !name.trim()} onClick={async () => { if (await renameItem(name.trim())) setRenaming(false); }}>名前を保存</button>
        <button type="button" className="expense-rename-cancel" disabled={busy} onClick={() => { setName(label); setRenaming(false); }}>取消</button>
      </>;
  return <ExpenseAmountRow rowKey={itemId} month={month} label={renaming ? "" : label} amount={amount} canEdit={canEdit} busy={busy} saveState={saveState} saveAmount={saveAmount} deleteAmount={deleteAmount} deleteItem={deleteItem} nameControl={nameControl} onDraftChange={onDraftChange} />;
}

function ConnectedExpenseDetails({ month, role, snapshot, refresh, saveChange, registerItem, saveItemAmount, clearItemAmount, retireItem, renameItem, saveState, saveMessage, compact = false }: {
  month: string; role: Role; snapshot: ApiSnapshot | null; refresh: () => Promise<void>; saveChange: (change: MonthlyChange) => Promise<boolean>; registerItem: (categoryId: string, name: string, amount: number | null) => Promise<boolean>; saveItemAmount: (itemId: string, amount: number) => Promise<boolean>; clearItemAmount: (itemId: string) => Promise<boolean>; retireItem: (itemId: string) => Promise<boolean>; renameItem: (itemId: string, name: string) => Promise<boolean>; saveState: SaveState; saveMessage: string; compact?: boolean;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [draftAmounts, setDraftAmounts] = useState<Record<string, string>>({});
  useEffect(() => setAmount(""), [month]);
  useEffect(() => setDraftAmounts({}), [month]);
  const [itemName, setItemName] = useState("");
  const [itemAmount, setItemAmount] = useState("");
  const category = snapshot?.expenseCategories.find((item) => item.id === categoryId);
  const limit = category ? expenseItemLimit(category.name) : null;
  const count = snapshot?.expenseItems.filter((item) => item.categoryId === categoryId).length ?? 0;
  const busy = saveState === "saving" || saveState === "outcome_unknown";
  const setDraftAmount = (id: string, value: string) => setDraftAmounts((current) => ({ ...current, [id]: value }));
  const subtotal = snapshot ? sumEnteredExpenseAmounts([...snapshot.expenseItems.map((item) => ({ id: item.id, amount: item.amount })), ...snapshot.expenseEntries.filter((entry) => !entry.expenseItemId).map((entry) => ({ id: entry.id, amount: entry.amount }))]
    .map((row) => { const raw = Object.hasOwn(draftAmounts, row.id) ? draftAmounts[row.id] : row.amount === null ? "" : String(row.amount); return raw !== "" && /^-?\d+$/.test(raw) ? Number(raw) : null; })) : null;
  const addExpense = async () => {
    const description = limit === null ? category?.name : undefined;
    if (!categoryId || !description || !/^-?\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) < -2147483648 || Number(amount) > 2147483647) return;
    if (await saveChange({ type: "expenseEntry", operation: "create", categoryId, description, amount: Number(amount) })) setAmount("");
  };
  return (
    <div className="screen-stack">
      {!compact && <ScreenTitle eyebrow={"\u7d4c\u8cbb\u660e\u7d30"} title={"\u7d4c\u8cbb\u660e\u7d30"} description={"\u6708\u3054\u3068\u306e\u91d1\u984d\u3068\u9805\u76ee\u540d\u3092\u7ba1\u7406\u3057\u307e\u3059\u3002"} month={month} />}
      {!snapshot && <p className="connection-notice" role="status">{month ? saveMessage || "\u5bfe\u8c61\u6708\u306e\u7d4c\u8cbb\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059\u3002" : "\u5bfe\u8c61\u6708\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002"}</p>}
      {snapshot && !snapshot.exists && <p className="connection-notice" role="status">{"\u3053\u306e\u6708\u306e\u6708\u6b21\u30ec\u30b3\u30fc\u30c9\u306f\u3042\u308a\u307e\u305b\u3093\u3002\u6708\u6b21\u5165\u529b\u753b\u9762\u3067\u6708\u3092\u4f5c\u6210\u3057\u3066\u304f\u3060\u3055\u3044\u3002"}</p>}
      {snapshot?.exists && snapshot.closed && <p className="connection-notice" role="status">{"\u3053\u306e\u6708\u306f\u78ba\u5b9a\u6e08\u307f\u3067\u3001\u7d4c\u8cbb\u306f\u7de8\u96c6\u3067\u304d\u307e\u305b\u3093\u3002"}</p>}
      {snapshot?.exists && !snapshot.closed && <p className="connection-notice" role="status">{role === "ALBA_ADMIN" ? "\u672a\u78ba\u5b9a\u306e\u6708\u3067\u3059\u3002\u7ba1\u7406\u8005\u306f\u7d4c\u8cbb\u3092\u5165\u529b\u3067\u304d\u307e\u3059\u3002" : "\u672a\u78ba\u5b9a\u306e\u6708\u3067\u3059\u3002\u7d4c\u8cbb\u3092\u7de8\u96c6\u3067\u304d\u308b\u306e\u306f\u7ba1\u7406\u8005\u306e\u307f\u3067\u3059\u3002"}</p>}
      {snapshot && <section className="panel">
        <PanelHeading title={"\u7d4c\u8cbb\u660e\u7d30"} aside={<span className="role-pill">{"\u7ba1\u7406\u8005"}</span>} />
        <div className="expense-list" aria-label={"\u7d4c\u8cbb\u4e00\u89a7"}>
          <div className="expense-list-header"><span>{"\u9805\u76ee\u540d"}</span><span>{"\u91d1\u984d\uff08\u5186\uff09"}</span><span></span></div>
          {snapshot.expenseItems.map((item) => <NamedExpenseAmountRow key={item.id} itemId={item.id} month={month} label={item.name} amount={item.amount} canEdit={role === "ALBA_ADMIN" && snapshot.exists && !snapshot.closed} busy={busy} saveState={saveState} saveAmount={(nextAmount) => saveItemAmount(item.id, nextAmount)} deleteAmount={() => clearItemAmount(item.id)} deleteItem={() => retireItem(item.id)} renameItem={(nextName) => renameItem(item.id, nextName)} onDraftChange={(value) => setDraftAmount(item.id, value)} />)}
          {snapshot.expenseEntries.filter((entry) => !entry.expenseItemId).map((entry) => <ExpenseAmountRow key={entry.id} rowKey={entry.id} month={month} label={entry.description === entry.categoryName ? entry.categoryName : `${entry.categoryName} / ${entry.description}`} amount={entry.amount} canEdit={role === "ALBA_ADMIN" && snapshot.exists && !snapshot.closed} busy={busy} saveState={saveState} saveAmount={(nextAmount) => saveChange({ type: "expenseEntry", operation: "update", id: entry.id, amount: nextAmount })} deleteAmount={() => saveChange({ type: "expenseEntry", operation: "delete", id: entry.id })} onDraftChange={(value) => setDraftAmount(entry.id, value)} />)}
          {snapshot.expenseItems.length === 0 && snapshot.expenseEntries.filter((entry) => !entry.expenseItemId).length === 0 && <p className="expense-list-empty">{"\u7d4c\u8cbb\u660e\u7d30\u306f\u307e\u3060\u3042\u308a\u307e\u305b\u3093"}</p>}
        </div>
        <div className="expense-subtotal" aria-live="polite"><span>経費小計</span><strong>{subtotal === null ? "—" : `¥${subtotal.toLocaleString()}`}</strong></div>
        <p className="expense-list-note">{"\u7a7a\u6b04\u306f\u672a\u5165\u529b\u3002\u0030\u5186\u306f\u5165\u529b\u5024\u3067\u3059\u3002\u91d1\u984d\u306f\u6708\u3054\u3068\u306b\u5165\u529b\u3057\u307e\u3059"}</p>
        {role === "ALBA_ADMIN" && snapshot.exists && !snapshot.closed && <div className={`expense-add-row${limit !== null ? " has-name" : " has-fixed"}`}>
          <label className="expense-add-category"><span>{"\u30ab\u30c6\u30b4\u30ea"}</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">{"\u9078\u629e"}</option>{snapshot.expenseCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {limit !== null ? <>
            <label className="expense-add-name"><span>{"\u9805\u76ee\u540d"}</span><input value={itemName} onChange={(event) => setItemName(event.target.value)} maxLength={200} /></label>
            <label className="expense-add-amount"><span>{"\u91d1\u984d（\u5186）"}</span><input type="number" step="1" inputMode="decimal" value={itemAmount} onChange={(event) => setItemAmount(event.target.value)} aria-label={"\u8ffd\u52a0\u3059\u308b\u9805\u76ee\u306e\u5f53\u6708\u91d1\u984d（\u7a7a\u6b04\u306f\u672a\u5165\u529b）"} /></label>
            <span className="expense-add-cap">{count}/{limit}</span>
            <button type="button" className="expense-row-save" disabled={!canRegisterExpenseItem(category?.name ?? "", count, itemName) || (itemAmount !== "" && (!/^-?\d+$/.test(itemAmount) || !Number.isSafeInteger(Number(itemAmount)) || Number(itemAmount) < -2147483648 || Number(itemAmount) > 2147483647)) || busy} onClick={async () => { if (await registerItem(categoryId, itemName.trim(), itemAmount === "" ? null : Number(itemAmount))) { setItemName(""); setItemAmount(""); } }}>{"\u8ffd\u52a0"}</button>
          </> : <>
            <label className="expense-add-amount"><span>{"\u91d1\u984d\uff08\u5186\uff09"}</span><input type="number" step="1" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
            <button type="button" className="expense-row-save" disabled={!categoryId || !category || !/^-?\d+$/.test(amount) || busy} onClick={() => void addExpense()}>{"\u8ffd\u52a0"}</button>
          </>}
        </div>}
        {saveMessage && <p role="status">{saveMessage}</p>}
      </section>}
    </div>
  );
}
function MetricResult({ title, reason = "入力値を未取得" }: { title: string; reason?: string }) {
  return <div className="result-row"><span>{title}</span><UnavailableValue reason={reason} /></div>;
}

function MonthlyEntry({ month, role, navigate }: { month: string; role: Role; navigate: (screen: Screen) => void }) {
  return (
    <div className="screen-stack">
      <ScreenTitle eyebrow="月次入力" title="月次入力" description="対象月の月次データを確認し、権限に応じて入力します。" month={month} />
      <ConnectionNotice />
      <div className="entry-layout">
        <div className="entry-main screen-stack">
          <section className="panel">
            <PanelHeading title="対象月と担当" hint="対象月を選んでもデータ照会や保存は行われません。" />
            <div className="assignment-grid">
              <div><span className="field-label">財務入力</span><span className="role-pill">管理者</span><p className="field-help">売上・経費の入力担当</p></div>
              <div><span className="field-label">会員統計</span><span className="role-pill role-pill--blue">入力担当：ALBA_ADMIN / EarneS</span><p className="field-help">会員数・新規・退会の入力担当</p></div>
            </div>
          </section>

          <section className="panel">
            <PanelHeading title="売上内訳" hint="実入金ベース・税込。その他入金は任意で追加できます。" aside={<span className="role-pill">管理者</span>} />
            <div className="field-grid field-grid--two">
              <DisabledField id="revenue-sugram-one" label="スグラム入金①" helper="未接続のため入力できません。" type="number" role={role} />
              <DisabledField id="revenue-sugram-two" label="スグラム入金②" helper="未接続のため入力できません。" type="number" role={role} />
            </div>
            <div className="optional-row"><div><strong>その他入金</strong><span>任意の売上内訳</span></div><button type="button" className="secondary-button" disabled aria-disabled="true">＋ 明細を追加</button></div>
            <div className="inline-status"><StatusBadge>売上合計 未取得</StatusBadge><UnavailableValue reason="データ未接続" /></div>
          </section>

          <section className="panel">
            <PanelHeading title="経費" hint="経費明細から確認・入力します。" aside={<span className="role-pill">管理者</span>} />
            <div className="linked-summary"><span>経費明細</span><UnavailableValue reason="明細未取得" /><button type="button" className="secondary-button" onClick={() => navigate("expenses")}>経費明細を確認 <span aria-hidden="true">→</span></button></div>
          </section>

          <section className="panel">
            <PanelHeading title="会員統計" hint="会員数は対象月の前月末時点です。" aside={<span className="role-pill role-pill--blue">入力担当：ALBA_ADMIN / EarneS</span>} />
            <div className="date-reference"><span className="state-label">会員数の基準日</span><strong>{month ? `${month} の前月末` : "対象月を選択してください"}</strong><span>対象月が未選択の間、基準日は確定しません。</span></div>
            <div className="field-grid field-grid--three">
              <DisabledField id="member-count" label="会員数（前月末）" helper="0人と未入力は区別します。" type="number" role={role} />
              <DisabledField id="member-new" label="新規入会数" helper="未接続のため入力できません。" type="number" role={role} />
              <DisabledField id="member-cancel" label="退会数" helper="未接続のため入力できません。" type="number" role={role} />
            </div>
          </section>

          <div className="save-panel">
            <div><strong>保存状態</strong><span>保存機能未接続</span></div>
            <button type="button" className="primary-button" disabled aria-disabled="true">保存できません</button>
          </div>
        </div>
        <aside className="entry-side">
          <section className="panel sticky-panel">
            <PanelHeading title="計算結果" hint="入力値を取得後に表示します。" />
            <MetricResult title="売上" /><MetricResult title="経費" /><MetricResult title="粗利" /><MetricResult title="ALBA報酬" /><MetricResult title="EarneS報酬" />
            <div className="side-checklist"><strong>必須入力</strong>{["売上", "経費", "前月末会員数", "新規入会数", "退会数"].map((label) => <div key={label}><span>{label}</span><StatusBadge>未接続</StatusBadge></div>)}</div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ExpenseDetails({ month, navigate }: { month: string; navigate: (screen: Screen) => void }) {
  return (
    <div className="screen-stack">
      <ScreenTitle eyebrow="経費明細" title="経費明細" description="対象月ごとの経費内訳を確認します。" month={month} />
      <ConnectionNotice />
      <section className="panel">
        <PanelHeading title="経費合計" hint="税込・返金や取消の負数を含みます。" aside={<span className="role-pill">管理者</span>} />
        <div className="expense-total"><UnavailableValue large /><span>円</span><StatusBadge>合計未取得</StatusBadge></div>
      </section>
      <section className="panel expense-list-panel">
        <PanelHeading title="明細" hint="明細なしは未入力です。未入力を0円として扱いません。" />
        <div className="desktop-table-scroll">
          <table className="data-table expense-table"><thead><tr><th scope="col">カテゴリ</th><th scope="col">説明</th><th scope="col" className="align-right">金額（税込）</th></tr></thead><tbody><tr><td colSpan={3}><EmptyState title="明細データ未接続" detail="経費データを読み込んでいません。0円入力済みとは区別されます。" /></td></tr></tbody></table>
        </div>
        <div className="expense-card-list"><EmptyState title="明細データ未接続" detail="経費データを読み込んでいません。" /></div>
        <div className="panel-actions"><button type="button" className="secondary-button" onClick={() => navigate("entry")}>月次入力へ戻る</button><button type="button" className="primary-button" disabled aria-disabled="true">明細追加（未接続）</button></div>
      </section>
    </div>
  );
}

const requiredRows = ["売上（実入金）", "経費", "前月末会員数", "新規入会数", "退会数"];

function LegacyMonthlyReview({ month }: { month: string }) {
  return (
    <div className="screen-stack">
      <ScreenTitle eyebrow="月次確認" title="月次確認" description="対象月の必須項目と確定状態を確認します。" month={month} />
      <ConnectionNotice />
      <section className="panel">
        <PanelHeading title="確定状態" hint="状態取得前のため、未確定・確定済みのいずれとも表示しません。" />
        <div className="review-state"><StatusBadge tone="warning">状態未取得</StatusBadge><span>{month || "対象月未選択"}</span></div>
      </section>
      <section className="panel">
        <PanelHeading title="必須5項目" hint="0入力済みと未入力を区別します。その他入金は任意です。" />
        <ul className="review-checklist">{requiredRows.map((label) => <li key={label}><span>{label}</span><span className="required-status">未接続</span><UnavailableValue /></li>)}</ul>
      </section>
      <section className="panel">
        <PanelHeading title="数値明細" hint="売上・経費は明細と合計を確認します。" />
        <div className="review-numbers"><MetricResult title="売上合計" /><MetricResult title="経費合計" /><MetricResult title="前月末会員数" /><MetricResult title="新規入会数" /><MetricResult title="退会数" /></div>
      </section>
      <section className="panel review-actions-panel">
        <PanelHeading title="月次確定" hint="確定後は通常編集できません。" aside={<span className="role-pill">管理者</span>} />
        <p className="text-muted">確定操作は認証とデータ接続後に利用できます。確定結果を模擬表示しません。</p>
        <button type="button" className="primary-button" disabled aria-disabled="true">確定（未接続）</button>
      </section>
      <section className="panel unlock-panel">
        <PanelHeading title="確定解除" hint="通常の月次操作とは分離しています。理由と監査記録が必要です。" aside={<span className="role-pill">管理者</span>} />
        <label className="field-label" htmlFor="unlock-reason">解除理由</label>
        <textarea id="unlock-reason" rows={3} disabled aria-describedby="unlock-explanation" placeholder="認証・データ未接続" />
        <p className="field-help" id="unlock-explanation">解除フォームは認証確認後に利用できます。</p>
        <button type="button" className="secondary-button" disabled aria-disabled="true">解除できません</button>
      </section>
      <p className="role-explanation">EARNESは月次状況と財務情報を閲覧できます。確定・解除操作はALBA_ADMINのみです。</p>
    </div>
  );
}

function ConnectedMonthlyReview({ month, role, authState, snapshot, refresh, finalize, unlock, unlockReason, setUnlockReason, saveState, saveMessage }: {
  month: string; role: Role; snapshot: ApiSnapshot | null; refresh: () => Promise<void>;
  authState: AuthState;
  finalize: () => Promise<void>; unlock: () => Promise<void>; unlockReason: string;
  setUnlockReason: (value: string) => void; saveState: SaveState; saveMessage: string;
}) {
  const readiness = closingReadiness(snapshot);
  const rows = [
    { label: "売上（明細合計）", entered: readiness.revenueEntered, value: readiness.revenueEntered ? readiness.revenueTotal === null ? "合計表示不可" : `${readiness.revenueTotal.toLocaleString()}円` : "未入力" },
    { label: "経費（明細合計）", entered: readiness.expensesEntered, value: readiness.expensesEntered ? readiness.expenseTotal === null ? "合計表示不可" : `${readiness.expenseTotal.toLocaleString()}円` : "未入力" },
    { label: "前月末会員数", entered: readiness.memberCountEntered, value: readiness.memberCount === null ? "未入力" : `${readiness.memberCount}人` },
    { label: "新規入会数", entered: readiness.newMembersEntered, value: readiness.newMembers === null ? "未入力" : `${readiness.newMembers}人` },
    { label: "退会数", entered: readiness.cancellationsEntered, value: readiness.cancellations === null ? "未入力" : `${readiness.cancellations}人` },
  ];
  const busy = saveState === "saving" || saveState === "outcome_unknown";
  return <div className="screen-stack">
    <ScreenTitle eyebrow="月次確認" title="月次確認" description="保存済みの必須5項目と月の確定状態を確認します。" month={month} />
    {authState === "signed_out" && <ConnectionNotice />}
    <section className="panel">
      <PanelHeading title="確定状態" hint="確定は保存済みデータをサーバー側で再検証します。" />
      <div className="review-state"><StatusBadge tone={snapshot?.closed ? "success" : snapshot?.exists ? "warning" : "neutral"}>{snapshot?.closed ? "確定済み" : snapshot?.exists ? "未確定" : "状態未取得"}</StatusBadge><span>{month || "対象月を選択"}</span></div>
      {!month && <p role="status">対象月を選択してください。</p>}
      {month && !snapshot && <p role="status">ログイン状態と月次データを確認してください。</p>}
      {snapshot && !snapshot.exists && <p role="status">この月のレコードがありません。ここから作成はできません。</p>}
      {snapshot?.closed && <p role="status">確定後は通常編集できません。再開にはALBA_ADMINと解除理由が必要です。</p>}
      {month && <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={saveState === "saving"}>最新状態を再取得</button>}
    </section>
    <section className="panel">
      <PanelHeading title="必須5項目" hint="金額・人数の0は入力済みとして扱い、未入力とは区別します。" />
      <ul className="review-checklist">{rows.map((row) => <li key={row.label}><span>{row.label}</span><span className="required-status">{row.entered ? "入力済み" : "未入力"}</span><strong>{row.value}</strong></li>)}</ul>
    </section>
    <section className="panel review-actions-panel">
      <PanelHeading title="月次確定" hint="ALBA_ADMINのみ実行できます。サーバーが保存済み必須値を再確認します。" aside={<span className="role-pill">管理者</span>} />
      <button type="button" className="primary-button" onClick={() => void finalize()} disabled={role !== "ALBA_ADMIN" || authState !== "ready" || !snapshot?.exists || snapshot.closed || !readiness.complete || busy}>{saveState === "saving" ? "処理中…" : snapshot?.closed ? "確定済み" : !snapshot?.exists ? "月次データ未取得" : !readiness.complete ? "必須項目を入力してください" : "この月を確定"}</button>
    </section>
    <section className="panel unlock-panel">
      <PanelHeading title="確定解除" hint="解除理由は日時・操作者とともに監査記録へ保存されます。" aside={<span className="role-pill">管理者</span>} />
      <label className="field-label" htmlFor="unlock-reason">解除理由</label>
      <textarea id="unlock-reason" rows={3} value={unlockReason} onChange={(event) => setUnlockReason(event.target.value)} disabled={role !== "ALBA_ADMIN" || !snapshot?.closed || busy} aria-describedby="unlock-explanation" placeholder="解除理由を入力" />
      <p className="field-help" id="unlock-explanation">空白だけの理由では解除できません。</p>
      <button type="button" className="secondary-button" onClick={() => void unlock()} disabled={role !== "ALBA_ADMIN" || authState !== "ready" || !snapshot?.exists || !snapshot.closed || !unlockReason.trim() || busy}>{saveState === "saving" ? "処理中…" : "理由を記録して確定解除"}</button>
    </section>
    {saveMessage && <p className="save-feedback" role="status">{saveMessage}</p>}
    <p className="role-explanation">EARNESは状態と必須項目を閲覧できます。確定・解除はALBA_ADMINのみです。</p>
  </div>;
}

const comparisonMetrics = [
  { name: "売上", unit: "円" }, { name: "経費", unit: "円" }, { name: "粗利", unit: "円" }, { name: "EarneS報酬", unit: "円" }, { name: "会員数", unit: "人" },
];

function AnnualComparison({ month, snapshot, history }: { month: string; snapshot: ApiSnapshot | null; history: SimulationMonth[] | null }) {
  const currentMemberCount = snapshot?.membershipStats?.memberCount ?? null;
  const [input, setInput] = useState(currentMemberCount === null ? "" : String(currentMemberCount));
  useEffect(() => setInput(currentMemberCount === null ? "" : String(currentMemberCount)), [currentMemberCount]);
  const simulationMembers = /^\d+$/.test(input) ? Number(input) : null;
  const current: SimulationMonth | null = snapshot?.exists ? { year: snapshot.period.year, month: snapshot.period.month, memberCount: currentMemberCount, revenueAmounts: snapshot.revenueEntries.map((entry) => entry.amount), expenseAmounts: snapshot.expenseEntries.map((entry) => entry.amount), expenseCategoryAmounts: snapshot.expenseEntries.map((entry) => ({ categoryName: entry.categoryName, amount: entry.amount })), cancellations: snapshot.membershipStats?.cancellations ?? null } : null;
  const result = history && simulationMembers !== null && Number.isSafeInteger(simulationMembers) && simulationMembers >= 0 ? calculateSimulation(simulationMembers, history, current) : null;
  const baselineMonthCount = history ? eligibleSimulationMonths(history).length : 0;
  const formatMoney = (value: number | null | undefined) => value === null || value === undefined ? "—" : `¥${Math.round(value).toLocaleString()}`;
  const formatRate = (value: number | null | undefined, digits = 1) => value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;
  const scenarioRows = ["現在", "60", "70", "80", "90", "100"].map((label) => ({ label, members: label === "現在" ? currentMemberCount : Number(label) }));
  const trendRows = history?.map((item) => ({ item, metrics: monthlyMetrics(item) })) ?? [];
  return (
    <div className="screen-stack">
      <ScreenTitle eyebrow="比較・年間" title="推移／経営シミュレータ" description="実績から経営指標を確認し、会員数の変化を試算します。" month={month} />
      <section className="panel">
        <PanelHeading title="シミュレーション会員数" hint="現在会員数を初期値にしています。入力値は実績データを変更しません。" />
        <div className="simulator-input-row"><label className="field"><span>会員数（人）</span><input type="number" min="0" step="1" value={input} onChange={(event) => setInput(event.target.value)} /></label><div className="simulator-step-buttons">{[1, 5, 10].map((step) => <button key={step} type="button" className="secondary-button" onClick={() => setInput(String(Math.max(0, (simulationMembers ?? 0) + step)))}>＋{step}</button>)}</div></div>
      </section>
      <section className="panel">
        <PanelHeading title="自動算出結果" hint="確定済み月だけを平均対象にし、明示した0円は平均に含めます。" />
        <p className="simulation-baseline" role="status">平均算出対象：{history === null ? "読み込み中" : `${baselineMonthCount}か月（確定済み）`}</p>
        {!result ? <p className="connection-notice" role="status">実績データ不足</p> : <div className="simulator-results"><div className="result-row"><span>平均会員単価</span><strong>{formatMoney(result.averageMemberUnitPrice)}</strong></div><div className="result-row"><span>平均経費</span><strong>{formatMoney(result.averageExpense)}</strong></div><div className="result-row"><span>想定売上</span><strong>{formatMoney(result.revenue)}</strong></div><div className="result-row"><span>想定経費</span><strong>{formatMoney(result.expense)}</strong></div><div className="result-row"><span>営業利益</span><strong>{formatMoney(result.grossProfit)}</strong></div><div className="result-row"><span>営業利益率</span><strong>{formatRate(result.operatingMargin)}</strong></div><div className="result-row"><span>ALBA報酬</span><strong>{formatMoney(result.albaReward)}</strong></div><div className="result-row"><span>EarneS報酬</span><strong>{formatMoney(result.earnesReward)}</strong></div><div className="result-row"><span>EarneS報酬率</span><strong>{formatRate(result.earnesRewardRate)}</strong></div><div className="result-row"><span>現在会員数との差</span><strong>{result.memberDifference === null ? "—" : `${result.memberDifference.toLocaleString()}人`}</strong></div><div className="result-row"><span>現在実績との差額</span><strong>{formatMoney(result.currentDifference)}</strong></div></div>}
      </section>
      <section className="panel"><PanelHeading title="会員数別比較" hint="現在・60・70・80・90・100名を同じ計算式で比較します。" /><div className="desktop-table-scroll"><table className="data-table comparison-table"><thead><tr><th scope="col">会員数</th><th scope="col">想定売上</th><th scope="col">想定経費</th><th scope="col">営業利益</th><th scope="col">営業利益率</th><th scope="col">ALBA報酬</th><th scope="col">EarneS報酬</th><th scope="col">EarneS報酬率</th></tr></thead><tbody>{scenarioRows.map((row) => { const item = history && row.members !== null ? calculateSimulation(row.members, history, current) : null; return <tr key={row.label}><th scope="row">{row.label}{row.label !== "現在" ? "名" : ""}</th><td>{item ? formatMoney(item.revenue) : "実績データ不足"}</td><td>{item ? formatMoney(item.expense) : "実績データ不足"}</td><td>{item ? formatMoney(item.grossProfit) : "実績データ不足"}</td><td>{item ? formatRate(item.operatingMargin) : "実績データ不足"}</td><td>{item ? formatMoney(item.albaReward) : "実績データ不足"}</td><td>{item ? formatMoney(item.earnesReward) : "実績データ不足"}</td><td>{item ? formatRate(item.earnesRewardRate) : "実績データ不足"}</td></tr>; })}</tbody></table></div></section>
      <section className="panel"><PanelHeading title="経営推移" hint="入力済みの月を時系列で表示します。" /><div className="desktop-table-scroll"><table className="data-table comparison-table"><thead><tr><th scope="col">月</th><th scope="col">売上</th><th scope="col">経費</th><th scope="col">営業利益</th><th scope="col">ALBA報酬</th><th scope="col">EarneS報酬</th><th scope="col">人件費率</th><th scope="col">広告費率</th><th scope="col">営業利益率</th></tr></thead><tbody>{trendRows.map(({ item, metrics }) => <tr key={`${item.year}-${item.month}`}><th scope="row">{item.year}-{String(item.month).padStart(2, "0")}</th><td>{formatMoney(metrics.revenue)}</td><td>{formatMoney(metrics.expense)}</td><td>{formatMoney(metrics.operatingProfit)}</td><td>{formatMoney(metrics.albaReward)}</td><td>{formatMoney(metrics.earnesReward)}</td><td>{formatRate(metrics.laborRate)}</td><td>{formatRate(metrics.advertisingRate)}</td><td>{formatRate(metrics.operatingMargin)}</td></tr>)}</tbody></table></div>{trendRows.length === 0 && <p className="connection-notice" role="status">推移データがありません。</p>}</section>
      <section className="panel"><PanelHeading title="会員推移" hint="会員数・入会・退会と退会率を月別に表示します。" /><div className="desktop-table-scroll"><table className="data-table comparison-table"><thead><tr><th scope="col">月</th><th scope="col">会員数（前月末）</th><th scope="col">新規入会</th><th scope="col">退会</th><th scope="col">退会率</th></tr></thead><tbody>{trendRows.map(({ item, metrics }) => <tr key={`${item.year}-${item.month}`}><th scope="row">{item.year}-{String(item.month).padStart(2, "0")}</th><td>{item.memberCount === null || item.memberCount === undefined ? "—" : `${item.memberCount}人`}</td><td>{item.newMembers === null || item.newMembers === undefined ? "—" : `${item.newMembers}人`}</td><td>{item.cancellations === null || item.cancellations === undefined ? "—" : `${item.cancellations}人`}</td><td>{formatRate(metrics.cancellationRate, 2)}</td></tr>)}</tbody></table></div>{trendRows.length === 0 && <p className="connection-notice" role="status">会員推移データがありません。</p>}</section>
    </div>
  );
}

function AuditHistory({ month }: { month: string }) {
  return (
    <div className="screen-stack">
      <ScreenTitle eyebrow="変更履歴" title="変更履歴" description="月次データの変更と確定・解除履歴を確認します。" month={month} />
      <ConnectionNotice />
      <section className="panel">
        <PanelHeading title="履歴" hint="日時・操作者・操作・対象月・変更内容を表示します。履歴の編集・削除はできません。" />
        <div className="desktop-table-scroll"><table className="data-table audit-table"><thead><tr><th scope="col">日時</th><th scope="col">操作者</th><th scope="col">操作</th><th scope="col">対象月</th><th scope="col">変更内容</th></tr></thead><tbody><tr><td colSpan={5}><EmptyState title="履歴データ未接続" detail="履歴や個人情報は取得・表示していません。" /></td></tr></tbody></table></div>
        <div className="audit-card-list"><EmptyState title="履歴データ未接続" detail="履歴は取得していません。" /></div>
      </section>
    </div>
  );
}

function ManagementFrame({ role }: { role: Role }) {
  if (role !== "ALBA_ADMIN") {
    return (
      <section className="panel access-gate" aria-labelledby="management-title">
        <p className="eyebrow">ADMINISTRATION</p><h1 id="management-title">管理</h1>
        <StatusBadge tone="warning">ALBA_ADMIN専用</StatusBadge>
        <p>認証済みの管理者セッションを確認できないため、管理項目・実データ・操作は表示しません。</p>
      </section>
    );
  }
  return <section className="panel access-gate"><p className="eyebrow">ADMINISTRATION</p><h1>管理</h1><EmptyState title="管理項目未確定" detail="この画面には未承認の管理操作を追加していません。" /></section>;
}

function LegacyLoginPreview() {
  return (
    <div className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-mark brand-mark--large" aria-hidden="true">MG</div>
        <p className="eyebrow">MINNANO GYM</p>
        <h1 id="login-title">ログイン</h1>
        <p className="login-description">管理者が許可したアカウントのみ利用できます。</p>
        <div className="login-method-placeholder"><span className="state-label">認証方法</span><strong>未接続</strong><p>ログイン方式は未設定です。入力欄やログイン操作は表示していません。</p></div>
        <StatusBadge>認証未接続</StatusBadge>
      </section>
      <p className="login-footnote">この画面ではログイン・アカウント作成を行いません。</p>
    </div>
  );
}

function MobileMoreMenu({ open, onNavigate, onLogout, role, authState }: { open: boolean; onNavigate: (screen: Screen) => void; onLogout: () => void; role: Role; authState: AuthState }) {
  if (!open) return null;
  const moreLinks: ScreenLink[] = [{ id: "expenses", label: "経費明細" }, { id: "review", label: "月次確認" }, { id: "history", label: "変更履歴" }];
  if (authState !== "ready") moreLinks.push({ id: "login", label: "ログイン" });
  return (
    <nav className="mobile-more-menu" id="mobile-more-menu" aria-label="その他の画面">
      {moreLinks.map((link) => <ScreenButton key={link.id} link={link} active={false} onClick={() => onNavigate(link.id)} />)}
      <ScreenButton link={{ id: "management", label: "管理" }} active={false} disabled={role !== "ALBA_ADMIN"} onClick={() => onNavigate("management")} />
      {authState === "ready" && <button type="button" className="screen-link" onClick={onLogout}><span className="screen-link-mark" aria-hidden="true">↪</span><span>ログアウト</span></button>}
    </nav>
  );
}

function ScreenContent({ screen, month, role, navigate, onLogin, authState, authMessage, entryProps, expenseProps, reviewProps, snapshot, simulationHistory }: { screen: Screen; month: string; role: Role; navigate: (screen: Screen) => void; onLogin: (email: string, password: string) => Promise<void>; authState: AuthState; authMessage: string; entryProps: Omit<React.ComponentProps<typeof ConnectedMonthlyEntry>, "month" | "role" | "expenseProps">; expenseProps: Omit<React.ComponentProps<typeof ConnectedExpenseDetails>, "month" | "role">; reviewProps: Omit<React.ComponentProps<typeof ConnectedMonthlyReview>, "month" | "role" | "authState">; snapshot: ApiSnapshot | null; simulationHistory: SimulationMonth[] | null }) {
  switch (screen) {
    case "login": return <LoginFrame onLogin={onLogin} authState={authState} authMessage={authMessage} />;
    case "dashboard": return <Dashboard month={month} navigate={navigate} snapshot={entryProps.snapshot} authState={authState} />;
    case "entry": return <ConnectedMonthlyEntry {...entryProps} expenseProps={expenseProps} month={month} role={role} />;
    case "expenses": return <ConnectedExpenseDetails {...expenseProps} month={month} role={role} />;
    case "review": return <ConnectedMonthlyReview {...reviewProps} month={month} role={role} authState={authState} />;
    case "comparison": return <AnnualComparison month={month} snapshot={snapshot} history={simulationHistory} />;
    case "history": return <AuditHistory month={month} />;
    case "management": return <ManagementFrame role={role} />;
  }
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>(() => requestedScreen(undefined));
  const [targetMonth, setTargetMonth] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [role, setRole] = useState<Role>(null);
  const [sessionActorId, setSessionActorId] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authMessage, setAuthMessage] = useState("");
  const [snapshot, setSnapshot] = useState<ApiSnapshot | null>(null);
  const [simulationHistory, setSimulationHistory] = useState<SimulationMonth[] | null>(null);
  const [membershipValues, setMembershipValues] = useState({ memberCount: "", newMembers: "", cancellations: "" });
  const [unlockReason, setUnlockReason] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const requestLock = useRef(false);
  const saveLock = useRef(false);
  const pendingMonthlyRequest = useRef<PendingMonthlyRequest | null>(null);
  const verifiedActorId = useRef<string | null>(null);
  const activeTargetMonth = useRef(targetMonth);
  activeTargetMonth.current = targetMonth;

  const beginMonthlyMutation = (body: MonthlyMutationBody): PendingMonthlyRequest => {
    const actorId = verifiedActorId.current;
    if (!actorId) throw new Error("確認済みの月次担当者でログインしてください。");
    const pending = createPendingMonthlyRequest(actorId, body);
    window.sessionStorage.setItem(PENDING_MONTHLY_REQUEST_KEY, JSON.stringify(pending));
    pendingMonthlyRequest.current = pending;
    return pending;
  };
  const clearPendingMonthlyMutation = () => {
    window.sessionStorage.removeItem(PENDING_MONTHLY_REQUEST_KEY);
    pendingMonthlyRequest.current = null;
  };
  const sendMonthlyMutation = async (pending: PendingMonthlyRequest) => {
    const { response, body: result } = await postMonthlyMutation(pending);
    if ((response.ok && result?.status === "ok") || (!response.ok && response.status < 500 && result?.code !== "outcome_unknown")) {
      clearPendingMonthlyMutation();
    }
    return { response, result };
  };

  const acceptVerifiedActor = (actorId: string) => {
    const previousActorId = verifiedActorId.current;
    verifiedActorId.current = actorId;
    setSessionActorId(actorId);
    let pending = pendingMonthlyRequest.current;
    if (!pending) {
      try { pending = readPendingMonthlyRequest(window.sessionStorage); } catch { pending = null; }
    }
    const actorChanged = previousActorId !== null && previousActorId !== actorId;
    const pendingBelongsToAnotherActor = pending !== null && !pendingMonthlyRequestBelongsToActor(pending, actorId);
    if (actorChanged || pendingBelongsToAnotherActor) {
      try { clearPendingMonthlyMutation(); } catch { pendingMonthlyRequest.current = null; }
      setMembershipValues({ memberCount: "", newMembers: "", cancellations: "" });
      setDirty(false);
      setSnapshot(null);
      setUnlockReason("");
      setSaveState("failed");
      setSaveMessage("ログインアカウントが変わったため、前の未確定操作は破棄しました。再試行はしていません。");
      return;
    }
    if (pending) {
      pendingMonthlyRequest.current = pending;
      setSaveState("outcome_unknown");
    }
  };

  const sessionRequest = async (): Promise<{ actorId: string; role: Role; displayName?: string }> => {
    const { response, body } = await fetchVerifiedSession();
    const user = resolveVerifiedSession(response, body);
    return { actorId: user.id, role: user.role, displayName: user.displayName };
  };

  const refreshSession = async () => {
    try {
      const session = await sessionRequest();
      acceptVerifiedActor(session.actorId);
      setRole(session.role);
      setAuthState("ready");
      return session.role;
    } catch (error) {
      const code = error instanceof Error ? error.message : "error";
      setRole(null);
      setAuthState(code === "unauthenticated" || code === "forbidden" ? "reauth_required" : "unavailable");
      return null;
    }
  };

  useEffect(() => {
    if (authState === "signed_out" || authState === "reauth_required") setScreen("login");
  }, [authState]);

  // The first mount performs one explicit session verification.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refreshSession();
    const restored = readPendingMonthlyRequest(window.sessionStorage);
    if (restored) {
      pendingMonthlyRequest.current = restored;
      setSaveState("outcome_unknown");
      setSaveMessage("前回の保存結果を確認できません。同じ操作を再試行して重複せずに確認してください。");
    } else {
      // Actor-unknown records from the earlier format cannot be safely retried.
      try { window.sessionStorage.removeItem(PENDING_MONTHLY_REQUEST_KEY); } catch { /* storage unavailable */ }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSnapshot = async (period: string, preserveDraft = true): Promise<ApiSnapshot | null> => {
    if (!period || requestLock.current) return null;
    const match = /^(\d{4})-(\d{2})$/.exec(period);
    if (!match) return null;
    requestLock.current = true;
    setSnapshot(null);
    setSaveMessage("\u5bfe\u8c61\u6708\u306e\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059\u3002");
    try {
      const { response, body: rawBody } = await fetchMonthlySnapshot(period);
      const body = rawBody as { code?: string; snapshot?: unknown } | null;
      if (response.status === 401) { setRole(null); setAuthState("reauth_required");  setAuthMessage("セッションの再認証が必要です。入力値は保持されています。"); setSaveMessage("\u518d\u30ed\u30b0\u30a4\u30f3\u3057\u3066\u5bfe\u8c61\u6708\u3092\u518d\u8aad\u307f\u8fbc\u307f\u3057\u3066\u304f\u3060\u3055\u3044\u3002"); return null; }
      if (response.status === 403) { setRole(null); setAuthState("reauth_required");  setAuthMessage("このアカウントは許可されていません。"); setSaveMessage("\u6708\u6b21\u30c7\u30fc\u30bf\u306e\u8aad\u307f\u53d6\u308a\u6a29\u9650\u3092\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093\u3002"); return null; }
      if (!response.ok || !body || !isApiSnapshot(body.snapshot, period)) { setSaveMessage(body?.code === "outcome_unknown" ? "\u6708\u6b21\u30c7\u30fc\u30bf\u306e\u8aad\u307f\u53d6\u308a\u7d50\u679c\u3092\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093\u3002\u518d\u53d6\u5f97\u3057\u3066\u304f\u3060\u3055\u3044\u3002" : "\u6708\u6b21\u30c7\u30fc\u30bf\u306e\u5f62\u5f0f\u304c\u4e0d\u6b63\u3067\u3059\u3002"); return null; }
      if (activeTargetMonth.current !== period) return body.snapshot;
      setSnapshot(body.snapshot);
      if (!preserveDraft || !dirty) {
        const stats = body.snapshot.membershipStats;
        setMembershipValues({ memberCount: stats?.memberCount == null ? "" : String(stats.memberCount), newMembers: stats?.newMembers == null ? "" : String(stats.newMembers), cancellations: stats?.cancellations == null ? "" : String(stats.cancellations) });
        setDirty(false);
      }
      setSaveMessage("");
      return body.snapshot;
    } catch {
      setSaveMessage("通信できませんでした。入力値は保持されています。");
      return null;
    } finally {
      requestLock.current = false;
      if (activeTargetMonth.current && activeTargetMonth.current !== period) void loadSnapshot(activeTargetMonth.current);
    }
  };

  // Refresh only when the selected period or verified auth state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (authState === "ready" && targetMonth) void loadSnapshot(targetMonth);
  }, [authState, targetMonth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (authState !== "ready") { setSimulationHistory(null); return; }
    void fetchSimulationHistory().then(setSimulationHistory).catch(() => setSimulationHistory(null));
  }, [authState]);

  const login = async (email: string, password: string) => {
    setAuthMessage("");
    try {
      const signIn = await signInWithBrowserPassword(email, password);
      if (signIn.code) {
        if (signIn.code === "unauthenticated") throw new Error("メールアドレスまたはパスワードを確認してください。");
        if (signIn.code === "network" || signIn.code === "unavailable") throw new Error("認証サービスに接続できません。");
        throw new Error("ログインできませんでした。");
      }
      const session = await sessionRequest();
      acceptVerifiedActor(session.actorId);
      setRole(session.role);
      setAuthState("ready");
      setAuthMessage("");
      if (targetMonth) await loadSnapshot(targetMonth);
      if (screen === "login") setScreen("dashboard");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "ログインできませんでした。");
      setAuthState("signed_out");
    }
  };
  const logout = async () => {
    try { await signOutBrowserSession(); } catch { /* Local state is still cleared. */ }
    verifiedActorId.current = null;
    pendingMonthlyRequest.current = null;
    try { window.sessionStorage.removeItem(PENDING_MONTHLY_REQUEST_KEY); } catch { /* Storage is optional. */ }
    setRole(null); setSessionActorId(null); setSnapshot(null); setAuthState("signed_out"); setAuthMessage(""); setScreen("login");
  };

  const submitMembership = async () => {
    if (!targetMonth || !snapshot?.exists || snapshot.closed || saveLock.current || saveState === "outcome_unknown") return;
    const match = /^(\d{4})-(\d{2})$/.exec(targetMonth);
    if (!match) return;
    const parseCount = (value: string) => value === "" ? null : /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
    const counts = [parseCount(membershipValues.memberCount), parseCount(membershipValues.newMembers), parseCount(membershipValues.cancellations)];
    if (counts.some((value) => typeof value === "number" && (!Number.isInteger(value) || value < 0 || value > 2147483647))) {
      setSaveState("failed"); setSaveMessage("人数は0以上の整数で入力してください。"); return;
    }
    saveLock.current = true; setSaveState("saving"); setSaveMessage("保存中…");
    let mutationStarted = false;
    let pending: PendingMonthlyRequest | null = null;
    try {
      const sessionRole = await refreshSession();
      if (sessionRole !== "EARNES" && sessionRole !== "ALBA_ADMIN") { setAuthMessage("セッションを再認証してください。入力値は保持されています。");  setSaveState("failed"); setSaveMessage("認証を確認できないため保存していません。"); return; }
      const currentSnapshot = await loadSnapshot(targetMonth);
      if (!currentSnapshot?.exists) { setSaveState("failed"); setSaveMessage("この月のレコードがないため保存できません。入力値は保持されています。"); return; }
      if (currentSnapshot.closed) { setSaveState("failed"); setSaveMessage("この月は確定済みのため保存できません。入力値は保持されています。"); return; }
      pending = beginMonthlyMutation({ period: { year: Number(match[1]), month: Number(match[2]) }, change: { type: "membershipStats", memberCount: counts[0], newMembers: counts[1], cancellations: counts[2] } });
      mutationStarted = true;
      const { response, result: body } = await sendMonthlyMutation(pending);
      if (!response.ok) {
        if (response.status >= 500) { setSaveState("outcome_unknown"); setSaveMessage("サーバー応答を確認できません。保存済みの可能性があるため再送せず、最新状態を確認してください。入力値は保持されています。"); return; }
        if (response.status === 401) { setAuthState("reauth_required"); setRole(null);  setAuthMessage("セッションの再認証が必要です。入力値は保持されています。"); }
        if (body?.code === "outcome_unknown") { setSaveState("outcome_unknown"); setSaveMessage("保存結果が不明です。再送せず、最新状態を再取得してください。入力値は保持されています。"); return; }
        setSaveState("failed"); setSaveMessage(response.status === 403 ? "この操作は許可されていません。入力値は保持されています。" : response.status === 409 ? "この月は確定済みです。入力値は保持されています。" : "保存できませんでした。入力値は保持されています。"); return;
      }
      if (body?.status !== "ok") { setSaveState("outcome_unknown"); setSaveMessage("保存結果を確認できません。再送せず、最新状態を確認してください。入力値は保持されています。"); return; }
      setSaveState("saved"); setSaveMessage("保存しました。"); setDirty(false);
      await loadSnapshot(targetMonth, false);
    } catch (error) {
      const code = error instanceof Error ? error.message : "network";
      setSaveState(mutationStarted ? "outcome_unknown" : "failed");
      setSaveMessage(code === "unauthenticated" ? "再認証が必要です。入力値は保持されています。" : "通信結果を確認できません。再送せず、最新状態を確認してください。入力値は保持されています。");
      if (code === "unauthenticated") { setAuthState("reauth_required"); setRole(null);  }
    } finally { saveLock.current = false; }
  };

  const createMonth = async () => {
    if (!targetMonth || !snapshot || snapshot.exists || saveLock.current || saveState === "outcome_unknown") return;
    const match = /^(\d{4})-(\d{2})$/.exec(targetMonth);
    if (!match) return;
    saveLock.current = true;
    setSaveState("saving");
    setSaveMessage("月次データを作成しています…");
    let requestStarted = false;
    try {
      const currentRole = await refreshSession();
      if (currentRole !== "ALBA_ADMIN") {
        setSaveState("failed");
        setSaveMessage("管理者権限を確認できないため、作成していません。");
        return;
      }
      const latest = await loadSnapshot(targetMonth);
      if (!latest) {
        setSaveState("failed");
        setSaveMessage("対象月を確認できないため、作成していません。");
        return;
      }
      if (latest.exists) {
        setSaveState("failed");
        setSaveMessage("この月のデータは既にあります。最新状態を再取得してください。");
        return;
      }
      const pending = beginMonthlyMutation({ period: { year: Number(match[1]), month: Number(match[2]) }, action: "create_month" });
      requestStarted = true;
      const { response, result } = await sendMonthlyMutation(pending);
      if (!response.ok || result?.status !== "ok") {
        if (response.status === 401 || response.status === 403) {
          setRole(null);
          setAuthState("reauth_required");
          setAuthMessage("月を作成するには、許可された管理者アカウントでログインしてください。");
        }
        if (response.status >= 500 || result?.code === "outcome_unknown") {
          setSaveState("outcome_unknown");
          setSaveMessage("作成結果を確認できません。安全に同じ操作を再試行できます。");
        } else {
          setSaveState("failed");
          setSaveMessage(response.status === 409 ? "この月のデータは既にあります。" : "月次データを作成できませんでした。");
        }
        return;
      }
      setSnapshot(null);
      setSaveState("saved");
      const refreshed = await loadSnapshot(targetMonth, false);
      if (refreshed?.exists) {
        setSaveMessage(refreshed.closed
          ? "\u6708\u3092\u4f5c\u6210\u3057\u3001\u518d\u53d6\u5f97\u3067\u78ba\u5b9a\u6e08\u307f\u3092\u78ba\u8a8d\u3057\u307e\u3057\u305f\u3002\u901a\u5e38\u7de8\u96c6\u306f\u3067\u304d\u307e\u305b\u3093\u3002"
          : "\u6708\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f\u3002\u58f2\u4e0a\u30fb\u7d4c\u8cbb\u30c7\u30fc\u30bf\u306f\u672a\u5165\u529b\u3067\u3059\u3002");
      } else {
        setSaveMessage("\u6708\u4f5c\u6210\u306f\u5b8c\u4e86\u3057\u307e\u3057\u305f\u304c\u3001\u6700\u65b0\u72b6\u614b\u3092\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093\u3002\u6708\u6b21\u30c7\u30fc\u30bf\u3092\u518d\u53d6\u5f97\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
      }
    } catch {
      setSaveState(requestStarted ? "outcome_unknown" : "failed");
      setSaveMessage(requestStarted ? "作成結果を確認できません。安全に同じ操作を再試行できます。" : "月次データを作成できませんでした。対象月を再取得してから再試行してください。");
    } finally {
      saveLock.current = false;
    }
  };
  const runExpenseItemMutation = async (body: Omit<MonthlyMutationBody, "period">): Promise<boolean> => {
    if (!targetMonth || saveLock.current || saveState === "outcome_unknown") return false;
    const match = /^(\d{4})-(\d{2})$/.exec(targetMonth);
    if (!match) return false;
    saveLock.current = true; setSaveState("saving"); setSaveMessage("経費項目を処理中です…");
    let requestStarted = false;
    try {
      if (await refreshSession() !== "ALBA_ADMIN") throw new Error("unauthorized");
      const current = await loadSnapshot(targetMonth);
      if (!current?.exists || current.closed) throw new Error(current?.closed ? "closed" : "not_found");
      const pending = beginMonthlyMutation({ ...body, period: {year:Number(match[1]),month:Number(match[2])} });
      requestStarted = true;
      const {response,result}=await sendMonthlyMutation(pending);
      if (!response.ok || result?.status !== "ok") {
        if (response.status === 401 || response.status === 403) { setRole(null); setAuthState("reauth_required"); }
        if (response.status >= 500 || result?.code === "outcome_unknown") { setSaveState("outcome_unknown"); setSaveMessage("処理結果を確認できません。安全に同じ要求を再試行できます。"); }
        else { setSaveState("failed"); setSaveMessage(response.status===409?"対象月が確定済みか、利用できません。":"経費項目を保存できませんでした。"); }
        return false;
      }
      setSaveState("saved"); await loadSnapshot(targetMonth,false); setSaveMessage(body.action === "retire_expense_item" ? "経費項目を削除しました。" : "経費項目を保存しました。"); return true;
    } catch (error) {
      setSaveState(requestStarted?"outcome_unknown":"failed"); setSaveMessage(requestStarted?"処理結果を確認できません。安全に同じ要求を再試行できます。":error instanceof Error&&error.message==="unauthorized"?"管理者権限の確認が必要です。":"対象月が確定済みか、利用できません。"); return false;
    } finally { saveLock.current=false; }
  };
  const registerExpenseItem = (categoryId:string,name:string,amount:number|null) => runExpenseItemMutation({action:"register_expense_item_with_amount",categoryId,name,amount});
  const saveExpenseItemAmount = (itemId:string,amount:number) => runExpenseItemMutation({action:"expense_item_amount",itemId,amount});
  const clearExpenseItemAmount = (itemId:string) => runExpenseItemMutation({action:"clear_expense_item_amount",itemId});
  const retireExpenseItem = (itemId:string) => runExpenseItemMutation({action:"retire_expense_item",itemId});
  const renameExpenseItem = (itemId:string,name:string) => runExpenseItemMutation({action:"rename_expense_item",itemId,name});
  const editMembershipValues = (next: typeof membershipValues) => { setMembershipValues(next); setDirty(true); setSaveState("unsaved"); setSaveMessage("未保存の変更があります。"); };
  const saveChange = async (change: MonthlyChange): Promise<boolean> => {
    if (!targetMonth || saveLock.current || saveState === "outcome_unknown") return false;
    const match = /^(\d{4})-(\d{2})$/.exec(targetMonth);
    if (!match) return false;
    saveLock.current = true; setSaveState("saving"); setSaveMessage("保存中…");
    let pending: PendingMonthlyRequest | null = null;
    try {
      const currentRole = await refreshSession();
      const allowedChange = change.type === "membershipStats" ? currentRole === "EARNES" || currentRole === "ALBA_ADMIN" : currentRole === "ALBA_ADMIN";
      if (!allowedChange) {  setAuthMessage("再認証が必要です。編集中の値は保持されています。"); setSaveState("failed"); setSaveMessage("権限を確認できないため保存していません。"); return false; }
      const currentSnapshot = await loadSnapshot(targetMonth);
      if (!currentSnapshot?.exists || currentSnapshot.closed) { setSaveState("failed"); setSaveMessage(currentSnapshot?.closed ? "この月は確定済みです。保存していません。" : "この月のデータを確認できません。保存していません。"); return false; }
      pending = beginMonthlyMutation({ period: { year: Number(match[1]), month: Number(match[2]) }, change });
      const { response, result } = await sendMonthlyMutation(pending);
      if (!response.ok) {
        if (response.status >= 500) { setSaveState("outcome_unknown"); setSaveMessage("サーバー応答を確認できません。保存済みの可能性があるため再送せず、最新状態を確認してください。"); return false; }
        if (response.status === 401 || response.status === 403) { setRole(null); setAuthState("reauth_required");  setAuthMessage("セッションを再認証してください。"); }
        if (result?.code === "outcome_unknown") { setSaveState("outcome_unknown"); setSaveMessage("保存結果が不明です。再送せず最新状態を確認してください。"); return false; }
        setSaveState("failed"); setSaveMessage(response.status === 409 ? "この月は確定済みです。" : response.status === 403 ? "この操作は許可されていません。" : "保存できませんでした。入力値は保持されています。"); return false;
      }
      if (result?.status !== "ok") { setSaveState("outcome_unknown"); setSaveMessage("保存結果を確認できません。再送せず最新状態を再取得してください。"); return false; }
      setSaveState("saved"); setSaveMessage("保存しました。"); await loadSnapshot(targetMonth, true); return true;
    } catch {
      setSaveState(pending ? "outcome_unknown" : "failed"); setSaveMessage(pending ? "保存結果を確認できません。同じ操作を安全に再試行できます。" : "保存を開始できませんでした。入力内容は保持されています。"); return false;
    } finally { saveLock.current = false; }
  };
  const runClosingAction = async (action: "finalize" | "unlock") => {
    if (!targetMonth || saveLock.current || saveState === "outcome_unknown") return;
    if (action === "unlock" && !unlockReason.trim()) {
      setSaveState("failed"); setSaveMessage("空白以外の解除理由を入力してください。"); return;
    }
    const match = /^(\d{4})-(\d{2})$/.exec(targetMonth);
    if (!match) return;
    saveLock.current = true; setSaveState("saving"); setSaveMessage(action === "finalize" ? "確定条件を確認中…" : "解除条件を確認中…");
    let mutationStarted = false;
    try {
      const currentRole = await refreshSession();
      if (currentRole !== "ALBA_ADMIN") { setSaveState("failed"); setSaveMessage("ALBA_ADMINの認証を確認できないため処理していません。"); return; }
      const currentSnapshot = await loadSnapshot(targetMonth);
      if (!currentSnapshot?.exists) { setSaveState("failed"); setSaveMessage("対象月のレコードがないため処理できません。"); return; }
      if (action === "finalize" && currentSnapshot.closed) { setSaveState("failed"); setSaveMessage("この月はすでに確定済みです。最新状態を確認してください。"); return; }
      if (action === "unlock" && !currentSnapshot.closed) { setSaveState("failed"); setSaveMessage("この月は確定されていないため解除できません。"); return; }
      if (action === "finalize" && !closingReadiness(currentSnapshot).complete) {
        setSaveState("failed"); setSaveMessage("保存済みの必須5項目が不足しています。入力画面で保存後、状態を再取得してください。"); return;
      }
      const pending = beginMonthlyMutation({ period: { year: Number(match[1]), month: Number(match[2]) }, action, ...(action === "unlock" ? { reason: unlockReason } : {}) });
      mutationStarted = true;
      const { response, result } = await sendMonthlyMutation(pending);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { setRole(null); setAuthState("reauth_required"); setAuthMessage("セッションを再認証し、roleを再確認してください。"); }
        if (response.status >= 500 || result?.code === "outcome_unknown") {
          setSaveState("outcome_unknown"); setSaveMessage("処理結果が不明です。再送せず、対象月の最新状態を再取得してください。"); return;
        }
        setSaveState("failed");
        setSaveMessage(result?.code === "incomplete_inputs" ? "保存済みの必須項目が不足しています。" : result?.code === "closed" ? "この月は確定済みです。" : result?.code === "not_found" ? "対象月または確定状態が見つかりません。" : response.status === 403 ? "この操作は許可されていません。" : "処理できませんでした。入力値と解除理由は保持されています。");
        await loadSnapshot(targetMonth);
        return;
      }
      if (result?.status !== "ok") {
        setSaveState("outcome_unknown"); setSaveMessage("処理結果を確認できません。再送せず、対象月の最新状態を再取得してください。"); return;
      }
      setSaveState("saved");
      if (action === "finalize") setSnapshot({ ...currentSnapshot, closed: true });
      else { setSnapshot(null); setUnlockReason(""); }
      const refreshed = await loadSnapshot(targetMonth, false);
      setSaveMessage(refreshed
        ? action === "finalize" ? "月次を確定しました。" : "確定を解除しました。"
        : action === "finalize" ? "確定APIは成功しました。状態再取得に失敗したため、確定状態として編集をロックしています。" : "解除APIは成功しました。最新状態を取得できるまで編集を停止しています。");
    } catch {
      setSaveState(mutationStarted ? "outcome_unknown" : "failed");
      setSaveMessage(mutationStarted ? "通信結果が不明です。再送せず、対象月の最新状態を確認してください。入力と解除理由は保持しています。" : "通信できません。入力と解除理由は保持しています。");
    } finally { saveLock.current = false; }
  };
  const retryPendingMonthlyMutation = async () => {
    if (saveLock.current) return;
    const pending = pendingMonthlyRequest.current ?? readPendingMonthlyRequest(window.sessionStorage);
    if (!pending) return;
    pendingMonthlyRequest.current = pending;
    saveLock.current = true;
    setSaveState("saving");
    setSaveMessage("同じ月次操作を安全に再試行しています。");
    try {
      const sessionRole = await refreshSession();
      if (!sessionRole) {
        setSaveState("outcome_unknown");
        setSaveMessage("再ログイン後、同じ操作を再試行してください。");
        return;
      }
      if (!pendingMonthlyRequestBelongsToActor(pending, verifiedActorId.current)) {
        try { clearPendingMonthlyMutation(); } catch { pendingMonthlyRequest.current = null; }
        setSaveState("failed");
        setSaveMessage("This pending operation belongs to another account and was discarded without retry.");
        return;
      }
      const { response, result } = await sendMonthlyMutation(pending);
      if (!response.ok || result?.status !== "ok") {
        if (response.status === 401) {
          setRole(null);
          setAuthState("reauth_required");
          setSaveState("failed");
          setSaveMessage("再ログインしてから保存してください。");
        } else if (response.status >= 500 || result?.code === "outcome_unknown") {
          setSaveState("outcome_unknown");
          setSaveMessage("保存結果を確認できません。同じ操作をもう一度再試行してください。");
    } else {
          setSaveState("failed");
          setSaveMessage("操作は受け付けられませんでした。新しい変更の前に対象月を確認してください。");
        }
        return;
      }
      setSaveState("saved");
      setDirty(false);
      if (pending.body.action === "unlock") setUnlockReason("");
      const operationMonth = `${pending.body.period.year}-${String(pending.body.period.month).padStart(2, "0")}`;
      setTargetMonth(operationMonth);
      const latest = await loadSnapshot(operationMonth, false);
      if (latest) {
        setSnapshot(latest);
        setMembershipValues({
          memberCount: latest.membershipStats?.memberCount == null ? "" : String(latest.membershipStats.memberCount),
          newMembers: latest.membershipStats?.newMembers == null ? "" : String(latest.membershipStats.newMembers),
          cancellations: latest.membershipStats?.cancellations == null ? "" : String(latest.membershipStats.cancellations),
        });
      }
      setSaveMessage(latest ? "保存済みの操作を確認しました。" : "操作は保存済みです。最新状態を確認するため対象月を再取得してください。");
    } catch {
      setSaveState("outcome_unknown");
      setSaveMessage("保存結果を確認できません。同じ操作をもう一度再試行してください。");
    } finally {
      saveLock.current = false;
    }
  };
  const entryProps: Omit<React.ComponentProps<typeof ConnectedMonthlyEntry>, "month" | "role" | "expenseProps"> = { snapshot, refresh: async () => { await loadSnapshot(targetMonth); }, submitMembership, createMonth, saveChange, values: membershipValues, setValues: editMembershipValues, saveState, saveMessage };
  const expenseProps: Omit<React.ComponentProps<typeof ConnectedExpenseDetails>, "month" | "role"> = { snapshot, refresh: async () => { await loadSnapshot(targetMonth); }, saveChange, registerItem: registerExpenseItem, saveItemAmount: saveExpenseItemAmount, clearItemAmount: clearExpenseItemAmount, retireItem: retireExpenseItem, renameItem: renameExpenseItem, saveState, saveMessage };
  const reviewProps: Omit<React.ComponentProps<typeof ConnectedMonthlyReview>, "month" | "role" | "authState"> = { snapshot, refresh: async () => { const wasUnknown = saveState === "outcome_unknown"; const latest = await loadSnapshot(targetMonth); if (wasUnknown) setSaveMessage(latest ? "最新状態を取得しました。先行処理の結果不明のため、この画面からの再送はロック中です。" : "最新状態を取得できません。再送はロック中です。"); }, finalize: async () => { await runClosingAction("finalize"); }, unlock: async () => { await runClosingAction("unlock"); }, unlockReason, setUnlockReason, saveState, saveMessage };
  const navigate = (next: Screen) => {
    if (authState !== "ready" && next !== "login") {
      setScreen("login");
      setMoreOpen(false);
      return;
    }
    if (next === "management" && role !== "ALBA_ADMIN") return;
    setScreen(next);
    setMoreOpen(false);
  };
  const roleLabel = role === "ALBA_ADMIN" ? "\u7ba1\u7406\u8005" : role === "EARNES" ? "\u5165\u529b\u62c5\u5f53\uff1aEarneS" : "\u6a29\u9650\u672a\u78ba\u8a8d";
  const sessionStatus = authState === "ready" ? `\u30ed\u30b0\u30a4\u30f3\u78ba\u8a8d\u6e08\u307f\u30fb\u6a29\u9650\uff1a${roleLabel}` : authState === "checking" ? "\u30ed\u30b0\u30a4\u30f3\u72b6\u614b\u3092\u78ba\u8a8d\u4e2d" : authState === "unavailable" ? "\u8a8d\u8a3c\u30b5\u30fc\u30d3\u30b9\u3092\u5229\u7528\u3067\u304d\u307e\u305b\u3093" : "\u30ed\u30b0\u30a4\u30f3\u304c\u5fc5\u8981\u3067\u3059";
   const dataStatus = !targetMonth ? "\u5bfe\u8c61\u6708\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044" : !snapshot ? saveMessage || "\u6708\u6b21\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u8fbc\u307f\u4e2d" : !snapshot.exists ? "\u6708\u6b21\u30ec\u30b3\u30fc\u30c9\u672a\u4f5c\u6210" : snapshot.closed ? "\u78ba\u5b9a\u6e08\u307f\u30fb\u901a\u5e38\u7de8\u96c6\u4e0d\u53ef" : "\u672a\u78ba\u5b9a\u30fb\u5165\u529b\u53ef\u80fd";
  const saveStatusLabel = saveState === "saving" ? "\u4fdd\u5b58\u4e2d" : saveState === "saved" ? "\u4fdd\u5b58\u6e08\u307f" : saveState === "outcome_unknown" ? "\u4fdd\u5b58\u7d50\u679c\u3092\u78ba\u8a8d\u4e2d\u30fb\u5b89\u5168\u306b\u518d\u8a66\u884c\u3067\u304d\u307e\u3059" : saveState === "failed" ? "\u4fdd\u5b58\u5931\u6557\u30fb\u5165\u529b\u5185\u5bb9\u306f\u4fdd\u6301\u3055\u308c\u3066\u3044\u307e\u3059" : saveState === "unsaved" ? "\u672a\u4fdd\u5b58\u306e\u5909\u66f4\u304c\u3042\u308a\u307e\u3059" : "\u5f85\u6a5f\u4e2d";
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="メインナビゲーション">
        <a className="brand-lockup" href="#main-content" aria-label="みんなのジム ホームへ">
          <span className="brand-mark" aria-hidden="true">MG</span><span><strong>みんなのジム</strong><small>経営管理</small></span>
        </a>
        <div className="sidebar-connection"><StatusBadge tone={authState === "ready" ? "success" : "warning"}>{sessionStatus}</StatusBadge></div>
        <nav className="sidebar-nav" aria-label="画面">
          <p className="nav-group-label">日々の管理</p>
          {primaryLinks.slice(0, 4).map((link) => <ScreenButton key={link.id} link={link} active={screen === link.id} onClick={() => navigate(link.id)} />)}
          <p className="nav-group-label nav-group-label--spaced">振り返り</p>
          {primaryLinks.slice(4).map((link) => <ScreenButton key={link.id} link={link} active={screen === link.id} onClick={() => navigate(link.id)} />)}
          <p className="nav-group-label nav-group-label--spaced">アカウント</p>
          {authState !== "ready" && <ScreenButton link={{ id: "login", label: "ログイン" }} active={screen === "login"} onClick={() => navigate("login")} />}
          <ScreenButton link={{ id: "management", label: "管理" }} active={screen === "management"} disabled={role !== "ALBA_ADMIN"} onClick={() => navigate("management")} />
          {authState === "ready" && <button type="button" className="screen-link" onClick={() => void logout()}><span className="screen-link-mark" aria-hidden="true">↪</span><span>ログアウト</span></button>}
        </nav>
        <div className="sidebar-footer"><span className="sidebar-role">{role ?? "権限未確認"}</span><span>{dataStatus}</span></div>
      </aside>

      <main className="main-content" id="main-content">
        <header className="topbar">
          <div className="topbar-status"><span className="mobile-brand">みんなのジム</span><StatusBadge tone={authState === "ready" ? "success" : "warning"}>{sessionStatus}</StatusBadge></div>
          {screen !== "login" && <TargetMonth value={targetMonth} disabled={saveState === "saving"} onChange={(value) => { if (!saveLock.current) { setTargetMonth(value); setSnapshot(null); setSaveMessage(""); } }} />}
        </header>
        <div className="mobile-screen-heading"><span className="eyebrow">{dataStatus}</span><strong>{primaryLinks.find((link) => link.id === screen)?.label ?? (screen === "management" ? "管理" : "ログイン")}</strong></div>
        <div className="preview-banner" role="status"><span aria-hidden="true">i</span><p>{sessionStatus} · {dataStatus} · {saveStatusLabel}{saveMessage ? ` · ${saveMessage}` : ""}</p></div>
        {saveState === "outcome_unknown" && pendingMonthlyRequest.current && sessionActorId && pendingMonthlyRequest.current.actorId === sessionActorId && authState !== "reauth_required" && <section className="connection-notice" role="status">
          <p>{saveMessage}</p>
          <button type="button" className="secondary-button" onClick={() => void retryPendingMonthlyMutation()} disabled={authState !== "ready"}>同じ操作を安全に再試行</button>
        </section>}
        <div className="screen-content">{authState === "ready"
          ? <ScreenContent key={sessionActorId ?? "verified"} screen={screen} month={targetMonth} role={role} navigate={navigate} onLogin={login} authState={authState} authMessage={authMessage} entryProps={entryProps} expenseProps={expenseProps} reviewProps={reviewProps} snapshot={snapshot} simulationHistory={simulationHistory} />
          : authState === "checking" ? <SessionCheckingFrame /> : <LoginFrame onLogin={login} authState={authState} authMessage={authMessage} />}</div>
        <footer className="app-footer"><span>みんなのジム経営管理</span><span>{saveStatusLabel}</span></footer>
      </main>

      <MobileMoreMenu open={moreOpen} onNavigate={navigate} onLogout={() => void logout()} role={role} authState={authState} />
      <nav className="mobile-nav" aria-label="画面ナビゲーション">
        {[primaryLinks[0], primaryLinks[1], primaryLinks[4]].map((link) => (
          <ScreenButton key={link.id} link={link} active={screen === link.id} onClick={() => navigate(link.id)} compact />
        ))}
        <button type="button" className={`screen-link is-compact${moreOpen ? " is-active" : ""}`} aria-expanded={moreOpen} aria-controls="mobile-more-menu" onClick={() => setMoreOpen(!moreOpen)}>
          <span className="screen-link-mark" aria-hidden="true">···</span><span>その他</span>
        </button>
      </nav>
    </div>
  );
}
