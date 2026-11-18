import { useEffect } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunRecord, UsageRange } from "@comma/shared/ipc";
import { invoke, listen } from "./ipc";
import { queryKeys } from "./queries";

export const historyKeys = {
  all: ["history"] as const,
  runs: (search: string) => ["history", "runs", search] as const,
  recent: ["history", "recent"] as const,
  run: (id: string) => ["history", "run", id] as const,
  summary: (range: UsageRange) => ["history", "usage_summary", range] as const,
  daily: (range: UsageRange) => ["history", "usage_daily", range] as const,
  dictionary: ["dictionary"] as const,
  credits: ["account_credits"] as const,
};

const PAGE = 50;

/**
 * Refetches history, usage and the dictionary when Rust reports a change (a run finished in the
 * bar) and when settings change (the mode decides which dictionary is shown). Mount once per window.
 */
export function useHistorySync() {
  const qc = useQueryClient();
  useEffect(() => {
    const offs = [
      listen("history://changed", () => void qc.invalidateQueries({ queryKey: historyKeys.all })),
      listen("settings://changed", () => {
        void qc.invalidateQueries({ queryKey: queryKeys.settings });
        void qc.invalidateQueries({ queryKey: historyKeys.dictionary });
        void qc.invalidateQueries({ queryKey: historyKeys.credits });
      }),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, [qc]);
}

/** Runs newest first, 50 at a time, paged with `before`. */
export function useRuns(search: string) {
  return useInfiniteQuery({
    queryKey: historyKeys.runs(search),
    queryFn: ({ pageParam }) =>
      invoke("runs_list", { search: search || undefined, before: pageParam, limit: PAGE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last: RunRecord[]) => (last.length < PAGE ? undefined : last[last.length - 1]!.ts),
    placeholderData: keepPreviousData,
  });
}

export function useRecentRuns(limit = 5) {
  return useQuery({ queryKey: historyKeys.recent, queryFn: () => invoke("runs_list", { limit }) });
}

export function useRun(id: string | undefined) {
  return useQuery({ queryKey: historyKeys.run(id ?? ""), queryFn: () => invoke("run_get", { id: id! }), enabled: !!id, retry: false });
}

export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("run_delete", { id }),
    onSettled: () => qc.invalidateQueries({ queryKey: historyKeys.all }),
  });
}

export function useRerun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("run_rerun", { id }),
    onSuccess: (run) => qc.setQueryData(historyKeys.run(run.id), run),
    onSettled: () => qc.invalidateQueries({ queryKey: historyKeys.all }),
  });
}

export function useUsageSummary(range: UsageRange) {
  return useQuery({ queryKey: historyKeys.summary(range), queryFn: () => invoke("usage_summary", { range }), placeholderData: keepPreviousData });
}

export function useUsageDaily(range: UsageRange) {
  return useQuery({ queryKey: historyKeys.daily(range), queryFn: () => invoke("usage_daily", { range }), placeholderData: keepPreviousData });
}

export function useDictionary() {
  return useQuery({ queryKey: historyKeys.dictionary, queryFn: () => invoke("dictionary_list") });
}

function useDictionaryMutation<A>(fn: (args: A) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: historyKeys.dictionary }) });
}

export const useAddTerm = () => useDictionaryMutation((term: string) => invoke("dictionary_add", { term }));
export const useUpdateTerm = () => useDictionaryMutation((a: { id: string; term: string }) => invoke("dictionary_update", a));
export const useDeleteTerm = () => useDictionaryMutation((id: string) => invoke("dictionary_delete", { id }));
export function useImportTerms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) => invoke("dictionary_import_csv", { csv }),
    onSettled: () => qc.invalidateQueries({ queryKey: historyKeys.dictionary }),
  });
}

/** This week's Comma credits; only asked for in account mode. */
export function useCredits(enabled: boolean) {
  return useQuery({ queryKey: historyKeys.credits, queryFn: () => invoke("account_credits"), enabled, retry: false, staleTime: 30_000 });
}
