import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { match } from "ts-pattern";
import type { LlmTestResult, SttTestResult } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Check, CircleAlert } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { formatMs } from "../lib/format";

type TestState<T> = { status: "idle" | "pending" | "success" | "error"; data?: T; error: Error | null };

export type ResultTone = "ok" | "error" | "muted";

/** One test result line: a check or alert icon and the text, in the tone's colour. Shared by Test and Compare efforts. */
export function TestResultRow({ tone, children, className }: { tone: ResultTone; children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "flex gap-1.5 text-label leading-snug",
        match(tone)
          .with("ok", () => "text-success")
          .with("error", () => "text-destructive")
          .otherwise(() => "text-muted-foreground"),
        className,
      )}
    >
      {tone === "ok" ? <Check className="mt-0.5 size-3.5 shrink-0" /> : null}
      {tone === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> : null}
      {tone === "muted" ? <Spinner className="mt-0.5 size-3.5 shrink-0" /> : null}
      <span className={cn("min-w-0", tone === "error" && "selectable")}>{children}</span>
    </p>
  );
}

/** A Test button with its result inline: latency and model on success, the precise error otherwise. */
export function ProviderTest<T>({
  state,
  onTest,
  describe,
  disabled,
  disabledReason,
  className,
  extra,
}: {
  state: TestState<T>;
  onTest: () => void;
  describe: (data: T) => ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
  /** More buttons after Test, e.g. Compare efforts. */
  extra?: ReactNode;
}) {
  const { data, error } = state;
  type Outcome = { key: string; tone: ResultTone | "hint"; body: ReactNode };
  const idle: Outcome | null = disabled && disabledReason ? { key: "disabled", tone: "hint", body: disabledReason } : null;
  const outcome = match(state.status)
    .returnType<Outcome | null>()
    .with("pending", () => ({ key: "pending", tone: "muted", body: "Testing…" }))
    .with("success", () => (data === undefined ? idle : { key: "ok", tone: "ok", body: describe(data) }))
    .with("error", () => (error ? { key: `error:${error.message}`, tone: "error", body: error.message } : idle))
    .with("idle", () => idle)
    .exhaustive();

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={onTest}
        disabled={disabled || state.status === "pending"}
      >
        {state.status === "pending" ? <Spinner className="size-3.5" /> : null}
        Test
      </Button>
      {extra}
      <div className="min-h-7 min-w-0 flex-1" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {outcome ? (
            <motion.div
              key={outcome.key}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="pt-1.5"
            >
              {outcome.tone === "hint" ? (
                <p className="text-label leading-snug text-muted-foreground">{outcome.body}</p>
              ) : (
                <TestResultRow tone={outcome.tone}>{outcome.body}</TestResultRow>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function describeLlmTest(r: LlmTestResult): ReactNode {
  const parts = [
    r.ttft_ms != null ? `first token ${formatMs(r.ttft_ms)}` : null,
    `total ${formatMs(r.total_ms)}`,
    r.reasoning_tokens ? `${r.reasoning_tokens} reasoning tokens` : null,
  ].filter(Boolean);
  return (
    <>
      Works. <span className="font-mono">{r.model}</span> answered, {parts.join(", ")}.
    </>
  );
}

export function describeSttTest(r: SttTestResult): ReactNode {
  return (
    <>
      Works. <span className="font-mono">{r.model_id}</span> answered in {formatMs(r.total_ms)}.
    </>
  );
}
