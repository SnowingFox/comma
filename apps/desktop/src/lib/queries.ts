import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommandArgs, SecretName, Settings, SettingsPatch } from "@comma/shared/ipc";
import { invoke } from "./ipc";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1 },
  },
});

export const queryKeys = {
  settings: ["settings"] as const,
  secrets: ["secret_status"] as const,
  permissions: ["permissions_status"] as const,
  models: (baseUrl: string) => ["llm_models", baseUrl] as const,
  account: ["account_status"] as const,
  server: (url: string) => ["account_check", url] as const,
};

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => invoke("settings_get") });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => invoke("settings_set", { patch }),
    // Optimistic, so quick successive edits (toggling chips) build on each other instead of on a
    // stale copy. Nested objects merge one level deep, like the Rust side.
    onMutate: async (patch: SettingsPatch) => {
      await qc.cancelQueries({ queryKey: queryKeys.settings });
      const previous = qc.getQueryData<Settings>(queryKeys.settings);
      if (previous) {
        const next = { ...previous } as Record<string, unknown>;
        for (const [key, value] of Object.entries(patch)) {
          const current = next[key];
          next[key] = value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" ? { ...current, ...value } : value;
        }
        qc.setQueryData(queryKeys.settings, next as Settings);
      }
      return { previous };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKeys.settings, ctx.previous);
    },
    onSuccess: (settings: Settings) => qc.setQueryData(queryKeys.settings, settings),
  });
}

export function useSecretStatus() {
  return useQuery({ queryKey: queryKeys.secrets, queryFn: () => invoke("secret_status") });
}

export function useSetSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: SecretName; value: string }) => invoke("secret_set", vars),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.secrets });
      // A new key can change what a custom endpoint lists.
      void qc.invalidateQueries({ queryKey: ["llm_models"] });
    },
  });
}

/** Live permission status; polls every second while mounted (spec 2.4 step 4). */
export function usePermissions() {
  return useQuery({
    queryKey: queryKeys.permissions,
    queryFn: () => invoke("permissions_status"),
    refetchInterval: 1_000,
    staleTime: 0,
  });
}

/**
 * Models at `baseUrl`. With `live`, the list is re-probed every few seconds, so starting or
 * stopping magpie shows up without a click.
 */
export function useModels(baseUrl: string | undefined, { live = false, enabled = true } = {}) {
  return useQuery({
    queryKey: queryKeys.models(baseUrl ?? ""),
    queryFn: () => invoke("llm_models", baseUrl ? { base_url: baseUrl } : {}),
    enabled: enabled && !!baseUrl,
    retry: false,
    staleTime: 2_000,
    refetchInterval: live ? 4_000 : false,
    refetchOnWindowFocus: true,
  });
}

export function useLlmTest() {
  return useMutation({ mutationFn: (args: CommandArgs<"llm_test">) => invoke("llm_test", args) });
}

export function useSttTest() {
  return useMutation({ mutationFn: () => invoke("stt_test") });
}

export function useAccountStatus() {
  return useQuery({ queryKey: queryKeys.account, queryFn: () => invoke("account_status"), staleTime: 30_000 });
}

/** Whether the Comma server answers; re-checked every few seconds while it does not. */
export function useServerCheck(url: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.server(url ?? ""),
    queryFn: () => invoke("account_check", url ? { server_url: url } : {}).then(() => true as const),
    enabled: enabled && !!url,
    retry: false,
    refetchInterval: (q) => (q.state.status === "error" ? 5_000 : false),
  });
}
