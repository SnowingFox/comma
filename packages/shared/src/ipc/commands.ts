import { z } from "zod";
import { Settings, SettingsPatch } from "./settings";

/** Keychain entries. Values are write-only from the frontend. */
export const SecretName = z.enum(["elevenlabs", "llm"]);
export type SecretName = z.infer<typeof SecretName>;

/** Which secrets are present. Never carries the values. */
export const SecretStatus = z.object({
  elevenlabs: z.boolean(),
  llm: z.boolean(),
});
export type SecretStatus = z.infer<typeof SecretStatus>;

export const PermissionState = z.enum(["granted", "denied", "restricted", "not_determined"]);
export type PermissionState = z.infer<typeof PermissionState>;

export const PermissionsStatus = z.object({
  /** AVCaptureDevice authorization for audio. */
  microphone: PermissionState,
  /** AXIsProcessTrusted: `granted` or `denied`. */
  accessibility: PermissionState,
});
export type PermissionsStatus = z.infer<typeof PermissionsStatus>;

/** The System Settings Privacy pane to open. */
export const SettingsPaneKind = z.enum(["microphone", "accessibility"]);
export type SettingsPaneKind = z.infer<typeof SettingsPaneKind>;

export const WindowLabel = z.enum(["hub", "onboarding", "bar"]);
export type WindowLabel = z.infer<typeof WindowLabel>;

const NoArgs = z.object({}).strict();
const Unit = z.null();

/**
 * Commands, frontend -> Rust (spec 3.3). `args` is what the frontend passes to
 * `invoke` (Tauri maps the top-level keys to the Rust parameter names), `result`
 * is what the command resolves with. Phase 1 implements the commands below.
 */
export const commands = {
  settings_get: { args: NoArgs, result: Settings },
  settings_set: { args: z.object({ patch: SettingsPatch }).strict(), result: Settings },
  /** An empty value deletes the entry. */
  secret_set: {
    args: z.object({ name: SecretName, value: z.string().max(4096) }).strict(),
    result: Unit,
  },
  secret_status: { args: NoArgs, result: SecretStatus },
  permissions_status: { args: NoArgs, result: PermissionsStatus },
  open_settings_pane: { args: z.object({ kind: SettingsPaneKind }).strict(), result: Unit },
  window_show: { args: z.object({ label: WindowLabel }).strict(), result: Unit },
  window_hide: { args: z.object({ label: WindowLabel }).strict(), result: Unit },
} as const;

export type Commands = typeof commands;
export type CommandName = keyof Commands;
export type CommandArgs<N extends CommandName> = z.input<Commands[N]["args"]>;
export type CommandResult<N extends CommandName> = z.output<Commands[N]["result"]>;
