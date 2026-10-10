import "server-only";

import type { MonthlyRpcCall } from "./monthly-rpc-core.ts";
import { createMonthlyRpcTransport, type MonthlyRpcClient } from "./monthly-rpc-transport-core.ts";
import { createRequestSupabaseClient } from "./supabase-server.ts";

export function createAuthenticatedMonthlyRpc(requestId: string): MonthlyRpcCall {
  return createMonthlyRpcTransport(requestId, (headers) =>
    createRequestSupabaseClient({ writeCookies: true, headers }) as unknown as MonthlyRpcClient);
}
