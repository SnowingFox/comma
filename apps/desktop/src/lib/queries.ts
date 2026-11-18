import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecretName, Settings, SettingsPatch } from "@comma/shared/ipc";
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
};

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => invoke("settings_get") });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => invoke("settings_set", { patch }),
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
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.secrets }),
  });
}

/** Live permission status; polls every second while mounted (spec 2.4 step 3). */
export function usePermissions() {
  return useQuery({
    queryKey: queryKeys.permissions,
    queryFn: () => invoke("permissions_status"),
    refetchInterval: 1_000,
    staleTime: 0,
  });
}
