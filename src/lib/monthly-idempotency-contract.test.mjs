import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../supabase/migrations/20261010000000_monthly_request_idempotency.sql", import.meta.url), "utf8");
const health = readFileSync(new URL("../../supabase/migrations/20261009000000_monthly_backend_health_rpc.sql", import.meta.url), "utf8");
const service = readFileSync(new URL("./monthly-service.ts", import.meta.url), "utf8");
const transport = readFileSync(new URL("./monthly-rpc-transport.ts", import.meta.url), "utf8");
const transportCore = readFileSync(new URL("./monthly-rpc-transport-core.ts", import.meta.url), "utf8");
const serverClient = readFileSync(new URL("./supabase-server.ts", import.meta.url), "utf8");

test("request ledger is actor-scoped, private, unique, and stores successful outcomes transactionally", () => {
  assert.match(sql, /CREATE TABLE public\."MonthlyRequest"[\s\S]*PRIMARY KEY \("actorId", "requestId"\)/);
  assert.match(sql, /"requestId" uuid NOT NULL/);
  assert.match(sql, /"payload" jsonb NOT NULL/);
  assert.match(sql, /"result" jsonb NOT NULL DEFAULT '\{"status":"ok"\}'::jsonb/);
  assert.match(sql, /ALTER TABLE public\."MonthlyRequest" ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\."MonthlyRequest" FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|FUNCTION)\b/i);
});

test("claim rejects missing authentication and non-allowlisted or wrong-role actors without exposing other actors", () => {
  assert.match(sql, /auth\.uid\(\)[\s\S]*Monthly request ID required/);
  assert.match(sql, /u\."supabaseUserId" = \(SELECT auth\.uid\(\)::text\)/);
  assert.match(sql, /v_role IS DISTINCT FROM p_required_role/);
  assert.match(sql, /WHERE r\."actorId" = v_actor_id AND r\."requestId" = v_request_id/);
  assert.match(sql, /v_operation IS DISTINCT FROM p_operation OR v_year IS DISTINCT FROM p_year[\s\S]*v_payload IS DISTINCT FROM p_payload/);
  assert.match(sql, /Request ID was already used for a different operation/);
});

test("all preserved public RPC signatures require the claim before reaching the renamed implementation", () => {
  for (const [name, privateName] of [
    ["apply_monthly_change", "_apply_monthly_change_unchecked"],
    ["finalize_monthly_record", "_finalize_monthly_record_unchecked"],
    ["unlock_monthly_record", "_unlock_monthly_record_unchecked"],
  ]) {
    const start = sql.indexOf(`CREATE FUNCTION public.${name}(`);
    const end = sql.indexOf(`$${name}$;`, start);
    assert.ok(start >= 0 && end > start, `missing protected ${name}`);
    const body = sql.slice(start, end);
    assert.ok(body.indexOf("public.claim_monthly_request(") >= 0);
    assert.ok(body.indexOf(`public.${privateName}(`) > body.indexOf("public.claim_monthly_request("));
    assert.match(sql, new RegExp(`REVOKE ALL PRIVILEGES ON FUNCTION public\\.${privateName}\\([^;]+ FROM PUBLIC, anon, authenticated`));
  }
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.apply_monthly_change\(integer, integer, jsonb\) TO authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.finalize_monthly_record\(integer, integer\) TO authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.unlock_monthly_record\(integer, integer, text\) TO authenticated/);
  assert.match(sql, /x-monthly-request-id/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.monthly_backend_health\(\)[\s\S]*public\."MonthlyRequest"[\s\S]*pg_get_functiondef[\s\S]*claim_monthly_request/);
  assert.match(sql, /public\.apply_monthly_change\(integer,integer,jsonb\)'::regprocedure/);
});

test("health check still validates the exact public signatures and server transport sends the request ID as a header", () => {
  for (const signature of [
    "public.apply_monthly_change(integer,integer,jsonb)",
    "public.finalize_monthly_record(integer,integer)",
    "public.unlock_monthly_record(integer,integer,text)",
  ]) assert.ok(health.includes(`'${signature}'`), `health check no longer checks ${signature}`);
  assert.match(transport, /createMonthlyRpcTransport\(requestId, \(headers\) =>\s*createRequestSupabaseClient\(\{ writeCookies: true, headers \}\)/);
  assert.match(transportCore, /createClient\(\{ "x-monthly-request-id": requestId \}\)/);
  assert.match(serverClient, /global: options\.headers \? \{ headers: options\.headers \} : undefined/);
});
