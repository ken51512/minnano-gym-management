import type { MonthlyRpcCall } from "./monthly-rpc-core.ts";

type RpcClientFactory = (headers: Record<string, string>) => {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ error: unknown | null }>;
};

export type MonthlyRpcClient = ReturnType<RpcClientFactory>;

/** Bind one operation ID to a fresh request-scoped RPC client. */
export function createMonthlyRpcTransport(requestId: string, createClient: RpcClientFactory): MonthlyRpcCall {
  const supabase = createClient({ "x-monthly-request-id": requestId });
  return async (name, args) => {
    try {
      const { error } = await supabase.rpc(name, args);
      return { error };
    } catch (error) {
      return { error };
    }
  };
}
