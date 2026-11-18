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

/** A Test button with its result inline: latency and model on success, the precise error otherwise. */
export function ProviderTest<T>({
  state,
  onTest,
  describe,
  disabled,
  disabledReason,
  className,
}: {
  state: TestState<T>;
  onTest: () => void;
  describe: (data: T) => ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}) {
  const { data, error } = state;
  const idle = disabled && disabledReason ? { key: "disabled", tone: "muted", body: <span>{disabledReason}</span> } : null;
  const outcome = match(state.status)
    .with("pending", () => ({ key: "pending", tone: "muted", body: <span>Testing…</span> }))
    .with("success", () =>
      data === undefined
        ? idle
        : {
            key: "ok",
            tone: "ok",
            body: (
              <>
                <Check className="mt-0.5 size-3.5 shrink-0" />
                <span>{describe(data)}</span>
              </>
            ),
          },
    )
    .with("error", () =>
      error
        ? {
            key: `error:${error.message}`,
            tone: "error",
            body: (
              <>
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="selectable">{error.message}</span>
              </>
            ),
          }
        : idle,
    )
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
      <div className="min-h-7 min-w-0 flex-1" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {outcome ? (
            <motion.p
              key={outcome.key}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className={cn(
                "flex gap-1.5 pt-1.5 text-label leading-snug",
                match(outcome.tone)
                  .with("ok", () => "text-success")
                  .with("error", () => "text-destructive")
                  .otherwise(() => "text-muted-foreground"),
              )}
            >
              {outcome.body}
            </motion.p>
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
