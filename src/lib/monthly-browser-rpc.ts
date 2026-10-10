"use client";

import type { MonthlyRpcCall } from "./monthly-rpc-core.ts";
import { createMonthlyRpcTransport, type MonthlyRpcClient } from "./monthly-rpc-transport-core.ts";
import { createBrowserSupabaseClient } from "./supabase-browser.ts";

/** Bind the durable request ID to the browser's authenticated Supabase RPC call. */
export function createBrowserMonthlyRpc(requestId: string): MonthlyRpcCall {
  return createMonthlyRpcTransport(requestId, (headers) =>
    createBrowserSupabaseClient(headers) as unknown as MonthlyRpcClient);
}
