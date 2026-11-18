import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { emitTo as tauriEmitTo, listen as tauriListen } from "@tauri-apps/api/event";
import {
  AppError,
  commands,
  events,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type EventName,
  type EventPayload,
  type WindowLabel,
} from "@comma/shared/ipc";

/** A rejected command. `code` follows `AppErrorCode`; the message is safe to show. */
export class IpcError extends Error {
  readonly code: string;
  readonly command: CommandName;

  constructor(command: CommandName, code: string, message: string) {
    super(message);
    this.name = "IpcError";
    this.code = code;
    this.command = command;
  }
}

/** True inside a Tauri window; false in a plain browser on the Vite dev server. */
export const inTauri = isTauri();

type Transport = (command: CommandName, args: Record<string, unknown>) => Promise<unknown>;

let transport: Promise<Transport> | undefined;

function getTransport(): Promise<Transport> {
  transport ??= inTauri
    ? Promise.resolve<Transport>((command, args) => tauriInvoke(command, args))
    : import.meta.env.DEV
      ? // The dev server in a browser (screenshots, layout work) gets an in-memory backend.
        import("./ipc-mock").then((m) => m.mockInvoke)
      : Promise.reject(new Error("Comma must run inside its desktop app"));
  return transport;
}

// Commands without required arguments can be called as `invoke("name")`.
type ArgsParam<N extends CommandName> = {} extends CommandArgs<N>
  ? [args?: CommandArgs<N>]
  : [args: CommandArgs<N>];

/**
 * Calls a Rust command. Arguments are validated before sending and the response is
 * validated against the shared contract before it reaches the UI.
 */
export async function invoke<N extends CommandName>(
  command: N,
  ...[args]: ArgsParam<N>
): Promise<CommandResult<N>> {
  const spec = commands[command];
  const input = spec.args.safeParse(args ?? {});
  if (!input.success) {
    throw new IpcError(command, "invalid_input", input.error.issues[0]?.message ?? "Invalid input");
  }

  let raw: unknown;
  try {
    raw = await (await getTransport())(command, input.data as Record<string, unknown>);
  } catch (err) {
    const parsed = AppError.safeParse(err);
    if (parsed.success) throw new IpcError(command, parsed.data.code, parsed.data.message);
    throw new IpcError(command, "internal", err instanceof Error ? err.message : String(err));
  }

  const output = spec.result.safeParse(raw);
  if (!output.success) {
    throw new IpcError(command, "internal", `Unexpected response from ${command}`);
  }
  return output.data as CommandResult<N>;
}

const devChannel =
  !inTauri && import.meta.env.DEV && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("comma-dev-events")
    : undefined;

/** Subscribes to an event; payloads that do not match the contract are dropped. */
export async function listen<N extends EventName>(
  name: N,
  handler: (payload: EventPayload<N>) => void,
): Promise<() => void> {
  const accept = (payload: unknown) => {
    const parsed = events[name].safeParse(payload);
    if (parsed.success) handler(parsed.data as EventPayload<N>);
    else console.warn(`comma: dropped malformed ${name} event`);
  };
  if (inTauri) return tauriListen(name, (event) => accept(event.payload));
  if (!devChannel) return () => {};
  const onMessage = (e: MessageEvent<{ name: string; payload: unknown }>) => {
    if (e.data.name === name) accept(e.data.payload);
  };
  devChannel.addEventListener("message", onMessage);
  return () => devChannel.removeEventListener("message", onMessage);
}

/** Sends an event to one window (used by the dev bar preview). */
export async function emitTo<N extends EventName>(
  target: WindowLabel,
  name: N,
  payload: EventPayload<N>,
): Promise<void> {
  events[name].parse(payload);
  if (inTauri) return tauriEmitTo(target, name, payload);
  devChannel?.postMessage({ name, payload });
}
