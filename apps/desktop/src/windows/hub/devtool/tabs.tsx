// Developer-only vocabulary, English only.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BarState,
  isFnAccelerator,
  OnboardingStep,
  RunMode,
  type BarPreviewPayload,
  type PermissionState,
  type ShortcutsStatus,
} from "@comma/shared/ipc";
import { clearActions, useDevtoolStore, type ActionRecord } from "../../../lib/devtool-store";
import { emitTo, errorMessage, invoke } from "../../../lib/ipc";
import { useRecheckPermission, type PermissionKind } from "../../../lib/permissions";
import { queryKeys, usePermissions, useSettings, useUpdateSettings } from "../../../lib/queries";
import { shortcutsStatusKey, useShortcutsStatus } from "../../../lib/shortcut-events";
import { clock, DevButton, msText, muted, Note, Row, Section, Status, type Tone } from "./controls";

const fail = (e: unknown) => toast.error(errorMessage(e));

// ---- Shortcuts ------------------------------------------------------------------------------------

export function listenerTone(s: ShortcutsStatus | undefined): Tone {
  if (!s) return undefined;
  if (s.restart_required || s.tap === "failed") return "bad";
  return s.listener === "fn" ? "on" : "warn";
}

export const SWALLOW_KEY = "comma-swallow-fn";

function tapText(s: ShortcutsStatus) {
  if (s.tap === "running") return s.tap_keys ? "running, key presses arrive" : s.tap_delivered ? "running, modifiers only so far" : "running, nothing delivered yet";
  if (s.tap === "failed") return `failed: ${s.tap_error ?? "unknown"}`;
  return "off";
}

/** The mode a recording is in after these actions, newest last. */
export function activeMode(actions: readonly ActionRecord[]): RunMode | null {
  let mode: RunMode | null = null;
  for (const a of actions) {
    if (a.action === "start" || a.action === "switch") mode = a.mode;
    if (a.action === "stop" || a.action === "cancel") mode = null;
  }
  return mode;
}

function Lights() {
  const actions = useDevtoolStore((s) => s.actions);
  const held = useDevtoolStore((s) => s.held);
  const active = activeMode(actions);
  const last = actions.at(-1);
  return (
    <div className="cdt-lights" role="group" aria-label="Live shortcut indicators">
      <span className="cdt-light" data-on={held.includes("Fn") || undefined}>
        <i />
        Fn held
      </span>
      {RunMode.options.map((m) => (
        <span
          key={last?.mode === m ? `${m}-${last.seq}` : m}
          className="cdt-light"
          data-on={active === m || undefined}
          data-flash={(last?.mode === m && active !== m) || undefined}
        >
          <i />
          {m}
        </span>
      ))}
    </div>
  );
}

export function ShortcutsTab() {
  const qc = useQueryClient();
  const status = useShortcutsStatus().data;
  const actions = useDevtoolStore((s) => s.actions);
  const total = useDevtoolStore((s) => s.total);
  const held = useDevtoolStore((s) => s.held);
  const run = (cmd: "shortcuts_restart" | "shortcuts_probe", done: string) =>
    void invoke(cmd)
      .then((s) => {
        qc.setQueryData(shortcutsStatusKey, s);
        void qc.invalidateQueries({ queryKey: queryKeys.permissions });
        toast.success(done);
      })
      .catch(fail);
  return (
    <>
      <Section title="Listener">
        {status ? (
          <>
            <Row label="Listener">
              <Status tone={listenerTone(status)}>{status.listener === "fn" ? "Fn tap" : "fallback shortcuts"}</Status>
            </Row>
            <Row label="Fn tap">
              <Status tone={status.tap === "running" ? (status.tap_keys ? "on" : "warn") : status.tap === "failed" ? "bad" : undefined}>{tapText(status)}</Status>
            </Row>
            <Row label="Input Monitoring">
              <Status tone={status.input_monitoring || status.tap_keys ? "on" : "bad"}>
                {status.input_monitoring ? "allowed (preflight)" : status.tap_keys ? "in effect (key presses arrive; preflight stale)" : "not allowed (preflight)"}
              </Status>
            </Row>
            <Row label="Asked this run">{status.requested ? "yes: another request would not prompt" : "no"}</Row>
            <Row label="Globe key">{status.globe_key}</Row>
            <Row label="Swallow Fn">
              <Status tone={status.swallow === "on" ? "on" : status.swallow === "unavailable" ? "bad" : undefined}>
                {status.swallow === "unavailable" ? "unavailable (needs Accessibility)" : status.swallow}
              </Status>
            </Row>
            {status.restart_required ? <Note tone="bad">Allowed in System Settings, but the tap does not start. Relaunch Comma.</Note> : null}
            {status.tap === "running" && !status.input_monitoring ? (
              <Note tone="warn">macOS created the tap without Input Monitoring; it may receive nothing. The fallbacks are registered too.</Note>
            ) : null}
            {status.errors.map((e) => (
              <Note key={e.mode} tone="bad">
                {e.mode}: {e.message}
              </Note>
            ))}
          </>
        ) : (
          muted("loading")
        )}
        <div className="cdt-buttons">
          <DevButton onClick={() => run("shortcuts_restart", "Listener restarted")}>Restart listener</DevButton>
          <DevButton onClick={() => run("shortcuts_probe", "Tap probed")}>Re-probe tap</DevButton>
          <DevButton
            active={status?.swallow === "on"}
            onClick={() => {
              const on = status?.swallow !== "on";
              localStorage.setItem(SWALLOW_KEY, on ? "1" : "0");
              void invoke("shortcuts_set_swallow", { on })
                .then((s) => qc.setQueryData(shortcutsStatusKey, s))
                .catch(fail);
            }}
          >
            Swallow Fn (experimental)
          </DevButton>
        </div>
        <Note>Swallow Fn uses an active tap that drops Fn's own events so macOS may skip the Globe key action. It needs Accessibility and is off by default.</Note>
      </Section>

      <Section title="Registered">
        {status?.registered.length ? (
          <ul className="cdt-list">
            {status.registered.map((r) => (
              <li key={`${r.mode}-${r.shortcut}`} data-wide="">
                <span className="cdt-muted">{r.via === "fn" ? "Fn tap" : "plugin"}</span>
                <span>
                  {r.mode}: {r.shortcut}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          muted("nothing registered")
        )}
      </Section>

      <Section title="Live">
        <Lights />
        <Row label="Held keys">{held.length ? held.join(" + ") : muted("none")}</Row>
      </Section>

      <Section
        title={`Last actions (${actions.length}${total > actions.length ? ` of ${total}` : ""})`}
        trailing={
          <DevButton onClick={clearActions} disabled={!actions.length}>
            Clear
          </DevButton>
        }
      >
        {actions.length ? (
          <ul className="cdt-list">
            {[...actions].reverse().map((a) => (
              <li key={a.seq}>
                <span className="cdt-muted">{clock(a.at)}</span>
                <span>{a.action}</span>
                <span>
                  {a.mode}
                  {a.hands_free ? " (hands-free)" : ""} <span className="cdt-muted">via {a.source} to {a.target}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Note>No shortcut fired since the hub opened. Press one.</Note>
        )}
      </Section>
    </>
  );
}

// ---- Permissions ----------------------------------------------------------------------------------

const PERMISSIONS: { kind: PermissionKind; title: string }[] = [
  { kind: "microphone", title: "Microphone" },
  { kind: "accessibility", title: "Accessibility" },
  { kind: "input_monitoring", title: "Input Monitoring" },
];

export function permissionTone(state: PermissionState | undefined): Tone {
  if (!state) return undefined;
  return state === "granted" ? "on" : state === "not_determined" ? "warn" : "bad";
}

export function PermissionsTab() {
  const perms = usePermissions().data;
  const status = useShortcutsStatus().data;
  const recheck = useRecheckPermission();
  const [checked, setChecked] = useState<Record<string, number>>({});
  return (
    <>
      <Section title="Live status (polled every second)">
        {PERMISSIONS.map(({ kind, title }) => (
          <div key={kind} className="cdt-section" style={{ paddingBottom: 4, borderBottom: "1px solid var(--cdt-line)" }}>
            <Row label={title}>
              <Status tone={permissionTone(perms?.[kind])}>{perms?.[kind] ?? "…"}</Status>
              {checked[kind] ? <span className="cdt-muted"> · checked {clock(checked[kind])}</span> : null}
            </Row>
            <div className="cdt-buttons">
              <DevButton
                onClick={() =>
                  void recheck(kind)
                    .then(() => setChecked((c) => ({ ...c, [kind]: Date.now() })))
                    .catch(fail)
                }
              >
                Check again
              </DevButton>
              <DevButton onClick={() => void invoke("open_settings_pane", { kind }).catch(fail)}>Open settings</DevButton>
            </div>
          </div>
        ))}
      </Section>
      {status && perms?.input_monitoring !== "granted" ? (
        <Note tone="warn">
          Input Monitoring changes reach a running app only sometimes. If it is on in System Settings and still shows denied here, relaunch Comma.
        </Note>
      ) : null}
      <div className="cdt-buttons">
        <DevButton onClick={() => void invoke("app_restart").catch(fail)} danger>
          Relaunch Comma
        </DevButton>
      </div>
    </>
  );
}

// ---- Runs -----------------------------------------------------------------------------------------

export function RunsTab() {
  const live = useDevtoolStore((s) => s.runs);
  // Timings and errors only; the texts in the records are never rendered here.
  const { data: runs, refetch, isFetching } = useQuery({
    queryKey: ["devtool_runs"],
    queryFn: () => invoke("runs_list", { limit: 20 }),
    refetchInterval: 3_000,
  });
  return (
    <>
      <Section title={`Live (${live.length}, since the hub opened)`}>
        {live.length ? (
          <table className="cdt-table">
            <thead>
              <tr>
                <th>run</th>
                <th>stt</th>
                <th>llm</th>
                <th>paste</th>
                <th>total ms</th>
              </tr>
            </thead>
            <tbody>
              {[...live].reverse().map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td title={r.id}>
                      {clock(r.at).slice(0, 8)} {r.id.slice(0, 6)}
                    </td>
                    <td>{msText(r.stages.stt)}</td>
                    <td>{msText(r.stages.llm)}</td>
                    <td>{msText(r.stages.paste)}</td>
                    <td data-bad={r.error ? "" : undefined}>{r.error ? r.error.code : msText(r.total_ms)}</td>
                  </tr>
                  {r.error ? (
                    <tr>
                      <td colSpan={5} className="cdt-error">
                        {r.error.message}
                        {r.error.reason ? ` (${r.error.reason})` : ""}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <Note>No run since the hub opened.</Note>
        )}
      </Section>
      <Section
        title={`History (last ${runs?.length ?? 0})`}
        trailing={
          <DevButton onClick={() => void refetch()} disabled={isFetching}>
            Refresh
          </DevButton>
        }
      >
        {runs?.length ? (
          <table className="cdt-table">
            <thead>
              <tr>
                <th>when · mode</th>
                <th>audio s</th>
                <th>stt</th>
                <th>ttft</th>
                <th>llm</th>
                <th>total ms</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td title={r.id}>
                      {when(r.ts)} {r.mode}
                    </td>
                    <td>{r.audio_secs.toFixed(1)}</td>
                    <td>{msText(r.stt_ms)}</td>
                    <td>{msText(r.llm_ttft_ms)}</td>
                    <td>{msText(r.llm_total_ms)}</td>
                    <td data-bad={r.ok ? undefined : ""}>{r.ok ? msText(r.total_ms) : "error"}</td>
                  </tr>
                  {r.error ? (
                    <tr>
                      <td colSpan={6} className="cdt-error">
                        {r.error}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <Note>The history database has no runs.</Note>
        )}
      </Section>
    </>
  );
}

/** Time today, else month/day and time. */
function when(ts: number): string {
  const d = new Date(ts);
  const time = clock(ts).slice(0, 5);
  return d.toDateString() === new Date().toDateString() ? time : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${time}`;
}

// ---- Log ------------------------------------------------------------------------------------------

/** `[date][time][target][LEVEL] message` from tauri-plugin-log. */
export function logLevel(line: string): string | undefined {
  return /\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/.exec(line)?.[1];
}

export function LogTab() {
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const { data, refetch } = useQuery({
    queryKey: ["devtool_log"],
    queryFn: () => invoke("log_tail", { lines: 300 }),
    refetchInterval: follow ? 1_500 : false,
  });
  const box = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => {
    const all = data?.lines ?? [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((l) => l.toLowerCase().includes(f)) : all;
  }, [data, filter]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);
  return (
    <>
      <Row label="File" title={data?.path}>
        {data?.path ?? "…"}
      </Row>
      <div className="cdt-buttons" style={{ alignItems: "center" }}>
        <input className="cdt-input" style={{ flex: 1, width: "auto" }} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter log lines" />
        <label className="cdt-check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <DevButton onClick={() => void refetch()}>Refresh</DevButton>
        <DevButton onClick={() => void navigator.clipboard.writeText((data?.lines ?? []).join("\n")).then(() => toast.success("Log copied"), fail)}>Copy</DevButton>
      </div>
      <pre className="cdt-log" ref={box} aria-label="App log">
        {lines.length
          ? lines.map((l, i) => (
              <div key={i} data-level={logLevel(l)}>
                {l}
              </div>
            ))
          : "The log is empty."}
      </pre>
    </>
  );
}

// ---- Onboarding -----------------------------------------------------------------------------------

export function OnboardingTab() {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const open = async (target: OnboardingStep) => {
    await update.mutateAsync({ onboarding_step: target });
    await invoke("window_show", { label: "onboarding" });
    await emitTo("onboarding", "onboarding://restart", { step: target });
  };
  return (
    <>
      <Section title="Progress">
        <Row label="Completed">{settings ? String(settings.onboarding_completed) : "…"}</Row>
        <Row label="Resume at">{settings?.onboarding_step || muted("first step")}</Row>
        <Row label="Mode">{settings?.mode ?? "…"}</Row>
      </Section>
      <Section title="Open at a step">
        <div className="cdt-buttons">
          <select className="cdt-select" value={step} onChange={(e) => setStep(OnboardingStep.parse(e.target.value))} aria-label="Onboarding step">
            {OnboardingStep.options.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <DevButton onClick={() => void open(step).catch(fail)}>Open onboarding</DevButton>
        </div>
        <Note>Opens the onboarding window at that step. Finishing it marks onboarding complete again.</Note>
      </Section>
      <Section title="Reset">
        <div className="cdt-buttons">
          <DevButton
            danger
            onClick={() =>
              void update
                .mutateAsync({ onboarding_completed: false, onboarding_step: "" })
                .then(() => toast.success("Onboarding progress reset; it opens at the next launch"))
                .catch(fail)
            }
          >
            Reset onboarding progress
          </DevButton>
        </div>
      </Section>
    </>
  );
}

// ---- Bar ------------------------------------------------------------------------------------------

const SAMPLE_HINT = "Fn shortcuts need Input Monitoring.";
const SAMPLE_ANSWER = "A comma marks a short pause. Use one between clauses and to separate items in a list.";

export function BarTab() {
  const [state, setState] = useState<BarState>("recording");
  const [mode, setMode] = useState<RunMode>("dictate");
  const [handsFree, setHandsFree] = useState(false);
  const [hint, setHint] = useState(false);
  const [answer, setAnswer] = useState(false);
  const [message, setMessage] = useState("Add your ElevenLabs key in Settings to start dictating");
  const [live, setLive] = useState(false);

  const payload = (): BarPreviewPayload => ({
    state,
    mode,
    hands_free: handsFree,
    message: state === "error" || state === "empty" ? message : undefined,
    done_label: state === "done" ? "Copied" : undefined,
    hint: hint ? SAMPLE_HINT : undefined,
    hint_actions: hint ? ["Allow"] : undefined,
    answer: answer ? SAMPLE_ANSWER : undefined,
  });

  // Every change goes to the bar while the preview is on.
  useEffect(() => {
    if (!live) return;
    void emitTo("bar", "bar://preview", payload()).catch(fail);
  }, [live, state, mode, handsFree, hint, answer, message]);

  const show = async () => {
    await emitTo("bar", "bar://preview", payload());
    await invoke("bar_layout", { layout: "full", interactive: false });
    setLive(true);
  };
  const stop = async () => {
    setLive(false);
    await emitTo("bar", "bar://preview", { state: "idle" });
    await invoke("bar_layout", { layout: "hidden", interactive: false });
  };

  return (
    <>
      <Section title="State">
        <div className="cdt-buttons">
          {BarState.options.map((s) => (
            <DevButton key={s} active={s === state} onClick={() => setState(s)}>
              {s}
            </DevButton>
          ))}
        </div>
      </Section>
      <Section title="Mode">
        <div className="cdt-buttons">
          {RunMode.options.map((m) => (
            <DevButton key={m} active={m === mode} onClick={() => setMode(m)}>
              {m}
            </DevButton>
          ))}
        </div>
      </Section>
      <Section title="Extras">
        <div className="cdt-buttons">
          <label className="cdt-check">
            <input type="checkbox" checked={handsFree} onChange={(e) => setHandsFree(e.target.checked)} />
            Hands-free
          </label>
          <label className="cdt-check">
            <input type="checkbox" checked={hint} onChange={(e) => setHint(e.target.checked)} />
            Hint
          </label>
          <label className="cdt-check">
            <input type="checkbox" checked={answer} onChange={(e) => setAnswer(e.target.checked)} />
            Answer card
          </label>
        </div>
        <Row label="Message">
          <input className="cdt-input" value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Error or empty message" />
        </Row>
      </Section>
      <div className="cdt-buttons">
        <DevButton active={live} onClick={() => void show().catch(fail)}>
          {live ? "Showing on the bar" : "Show on the bar"}
        </DevButton>
        <DevButton onClick={() => void stop().catch(fail)} disabled={!live}>
          Stop preview
        </DevButton>
      </div>
      <Note>Draws the state in the real bar window. Stop preview gives the bar back to the dictation loop.</Note>
    </>
  );
}

export const usesFnShortcut = (s: { dictate: string; ask: string; translate: string } | undefined) =>
  !!s && (isFnAccelerator(s.dictate) || isFnAccelerator(s.ask) || isFnAccelerator(s.translate));
