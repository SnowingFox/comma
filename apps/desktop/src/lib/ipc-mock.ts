// Dev-only stand-in for the Rust commands when the UI runs in a plain browser.
// Never bundled into a release: `ipc.ts` imports it only under `import.meta.env.DEV`.
//
// URL knobs for screenshots and layout work, remembered in localStorage:
//   ?magpie=up|down|slow     magpie answers, is not running, or never answers (stays "detecting")
//   ?server=up|down          the Comma server
//   ?stt=ok|missing_permission|invalid_key
//   ?keys=1|0                pretend an ElevenLabs key is stored and a model is picked
//   ?step=<id>               resume onboarding at this step
//   ?mode=local|account
//   ?listener=fn|fallback|restart   the Fn listener (see mock/runtime.ts)
//   ?reset                   forget everything
import { match } from "ts-pattern";
import {
  DEFAULT_SETTINGS,
  Settings,
  type AccountStatus,
  type AppError,
  type CommandName,
  type PermissionsStatus,
  type RunMode,
  type SecretName,
} from "@comma/shared/ipc";

import { HISTORY_HANDLERS } from "./mock/history";
import { RUNTIME_HANDLERS } from "./mock/runtime";
import type { MockHandler } from "./mock/types";

const KEY = "comma-dev-mock";

type Knobs = { magpie: "up" | "down" | "slow"; server: "up" | "down"; stt: "ok" | "missing_permission" | "invalid_key" };

type MockState = {
  settings: Settings;
  secrets: Record<SecretName, boolean>;
  permissions: PermissionsStatus;
  knobs: Knobs;
  session: boolean;
};

const MODELS = [
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "moonshot/kimi-k3",
  "openai/gpt-5.6-mini",
  "openai/gpt-5.6",
  "qwen/qwen3.5-72b-instruct",
  "zhipu/glm-5-air",
  "mistral/mistral-large-3",
];

function defaults(): MockState {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    secrets: { elevenlabs: false, llm: false },
    permissions: { microphone: "not_determined", accessibility: "denied", input_monitoring: "denied" },
    knobs: { magpie: "up", server: "up", stt: "ok" },
    session: false,
  };
}

function load(): MockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MockState>;
      const base = defaults();
      // Settings saved by an older mock lack the newer fields.
      const settings = Settings.safeParse({ ...base.settings, ...parsed.settings });
      return { ...base, ...parsed, settings: settings.success ? settings.data : base.settings, knobs: { ...base.knobs, ...parsed.knobs } };
    }
  } catch {
    // fall through to defaults
  }
  return defaults();
}

function save(state: MockState) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function applyUrlKnobs() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("reset")) localStorage.removeItem(KEY);
  const state = load();
  const magpie = params.get("magpie");
  if (magpie === "up" || magpie === "down" || magpie === "slow") state.knobs.magpie = magpie;
  const server = params.get("server");
  if (server === "up" || server === "down") state.knobs.server = server;
  const stt = params.get("stt");
  if (stt === "ok" || stt === "missing_permission" || stt === "invalid_key") state.knobs.stt = stt;
  const keys = params.get("keys");
  if (keys === "1") {
    state.secrets.elevenlabs = true;
    if (!state.settings.llm.model) state.settings.llm.model = MODELS[0]!;
    state.permissions = { microphone: "granted", accessibility: "granted", input_monitoring: "granted" };
  } else if (keys === "0") {
    state.secrets = { elevenlabs: false, llm: false };
    state.settings.llm.model = "";
  }
  const mode = params.get("mode");
  if (mode === "local" || mode === "account") state.settings.mode = mode;
  const step = params.get("step");
  if (step) state.settings.onboarding_step = step;
  const listener = params.get("listener");
  if (listener === "fn" || listener === "fallback" || listener === "restart") {
    localStorage.setItem("comma-dev-listener", listener);
    if (listener !== "fn") state.permissions = { ...state.permissions, input_monitoring: listener === "restart" ? "granted" : "denied" };
  }
  save(state);
}
applyUrlKnobs();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(code: AppError["code"], message: string, reason?: string): never {
  throw { code, message, reason } satisfies AppError;
}

function accountStatus(state: MockState): AccountStatus {
  const { email, name, server_url } = state.settings.account;
  return { signed_in: state.session, email: state.session ? email : "", name: state.session ? name : "", server_url, offline: false };
}

const SAMPLE_TRANSCRIPT = "so um I think we should meet on Tuesday, no wait, Wednesday at three, and uh bring the slides";

const REFINED: Record<RunMode, (target?: string, selected?: string) => string> = {
  dictate: () => "I think we should meet on Wednesday at three and bring the slides.",
  translate: (target) =>
    target?.startsWith("ja")
      ? "水曜日の3時に会って、スライドを持ってきましょう。"
      : target?.startsWith("de")
        ? "Ich denke, wir sollten uns am Mittwoch um drei treffen und die Folien mitbringen."
        : "Je pense que nous devrions nous retrouver mercredi à trois heures et apporter les diapositives.",
  ask: (_target, selected) =>
    selected
      ? "Comma turns speech into clean text at your cursor, in any app."
      : "A comma marks a short pause. Use one between clauses, after an introductory phrase, and to separate items in a list.",
};

export async function mockInvoke(command: CommandName, args: Record<string, unknown>): Promise<unknown> {
  await wait(60);
  const state = load();
  const { knobs } = state;
  return match(command)
    .with("settings_get", async () => {
      return state.settings;
    })
    .with("settings_set", async () => {
      const patch = args.patch as Partial<Settings>;
      const next = Settings.parse({
        ...state.settings,
        ...patch,
        stt: { ...state.settings.stt, ...patch.stt },
        llm: { ...state.settings.llm, ...patch.llm },
        languages: { ...state.settings.languages, ...patch.languages },
        shortcuts: { ...state.settings.shortcuts, ...patch.shortcuts },
        account: { ...state.settings.account, ...patch.account },
        feedback: { ...state.settings.feedback, ...patch.feedback },
        privacy: { ...state.settings.privacy, ...patch.privacy },
        audio: { ...state.settings.audio, ...patch.audio },
      });
      save({ ...state, settings: next });
      return next;
    })
    .with("secret_set", async () => {
      const name = args.name as SecretName;
      const value = String(args.value).trim();
      save({ ...state, secrets: { ...state.secrets, [name]: value.length > 0 } });
      return null;
    })
    .with("secret_status", async () => {
      return state.secrets;
    })
    .with("permissions_status", async () => {
      return state.permissions;
    })
    .with("open_settings_pane", async () => {
      // Pretend the user granted it in System Settings.
      const kind = args.kind as keyof PermissionsStatus;
      setTimeout(() => save({ ...load(), permissions: { ...load().permissions, [kind]: "granted" } }), 1500);
      return null;
    })
    .with("window_show", "window_hide", async () => {
      console.info(`[mock] ${command}`, args);
      return null;
    })
    .with("llm_models", async () => {
      const base = (args.base_url as string | undefined) ?? state.settings.llm.base_url;
      const magpie = base.includes("127.0.0.1:3425");
      if (magpie && knobs.magpie === "slow") return new Promise(() => {});
      await wait(350);
      if (magpie && knobs.magpie === "down") fail("unreachable", "magpie is not running on this Mac (nothing answers at 127.0.0.1:3425)");
      if (!magpie && !state.secrets.llm) fail("invalid_key", `${new URL(base).host} needs an API key. Add one and test again`);
      return magpie ? MODELS : MODELS.slice(0, 2);
    })
    .with("llm_test", async () => {
      const model = (args.model as string | undefined) || state.settings.llm.model;
      if (!model) fail("not_configured", "Pick a model first");
      await wait(700);
      const base = (args.base_url as string | undefined) ?? state.settings.llm.base_url;
      if (base.includes("127.0.0.1:3425") && knobs.magpie === "down") fail("unreachable", "magpie is not running on this Mac (nothing answers at 127.0.0.1:3425)");
      return { model, ttft_ms: 412.3, total_ms: 538.9, reasoning_tokens: model.includes("reasoner") ? 24 : null, reply: "ready" };
    })
    .with("stt_test", async () => {
      if (!state.secrets.elevenlabs) fail("not_configured", "Add your ElevenLabs API key first");
      await wait(600);
      if (knobs.stt === "missing_permission")
        fail(
          "missing_permission",
          "This ElevenLabs key lacks the Speech to Text permission. Turn it on for the key in ElevenLabs, or create a new key with it",
          "missing_permissions",
        );
      if (knobs.stt === "invalid_key") fail("invalid_key", "ElevenLabs rejected the API key. Check that you pasted all of it");
      return { model_id: state.settings.stt.model_id, total_ms: 684.2, text: "", language_code: "eng" };
    })
    .with("stt_transcribe", async () => {
      if (!state.secrets.elevenlabs) fail("not_configured", "Add your ElevenLabs API key first");
      await wait(500);
      return { text: SAMPLE_TRANSCRIPT, language_code: "eng", language_probability: 0.97, duration_secs: 4.2, total_ms: 702.5, retried: false };
    })
    .with("refine_text", async () => {
      if (!state.settings.llm.model) fail("not_configured", "Pick an LLM model first");
      await wait(600);
      const mode = args.mode as RunMode;
      const selected = args.selected_text as string | undefined;
      const target = (args.target_language as string | undefined) ?? state.settings.languages.translate_targets[0];
      return {
        mode,
        text: REFINED[mode](target, selected),
        delivery: mode === "ask" ? (selected ? "inline" : "external") : null,
        model: state.settings.llm.model,
        ttft_ms: 380.1,
        total_ms: 812.4,
      };
    })
    .with("pipeline_check", async () => {
      if (state.settings.mode === "account") {
        if (!state.session) fail("not_configured", "You're signed out of Comma. Sign in again in Settings", "signed_out");
        return null;
      }
      if (!state.secrets.elevenlabs) fail("not_configured", "Add your ElevenLabs key in Settings to start dictating", "missing_elevenlabs_key");
      if (!state.settings.llm.model) fail("not_configured", "Pick an LLM model in Settings to start dictating", "missing_llm_model");
      return null;
    })
    .with("account_check", async () => {
      await wait(300);
      if (knobs.server === "down") fail("unreachable", `Can't reach the Comma server at ${new URL(state.settings.account.server_url).host}`);
      return null;
    })
    .with("account_register", async () => {
      await wait(400);
      if (knobs.server === "down") fail("unreachable", "Can't reach the Comma server");
      if (String(args.email).includes("taken")) fail("server", "There is already an account with this email. Sign in instead", "email_taken");
      return null;
    })
    .with("account_verify_email", async () => {
      await wait(300);
      if (args.code !== "123456") fail("server", "That code is not right. Check the latest email", "invalid_code");
      return null;
    })
    .with("account_resend_code", async () => {
      return null;
    })
    .with("account_sign_in", async () => {
      await wait(400);
      if (knobs.server === "down") fail("unreachable", "Can't reach the Comma server");
      if (args.password === "wrong") fail("server", "Wrong email or password", "invalid_credentials");
      const email = String(args.email).trim().toLowerCase();
      const next: MockState = {
        ...state,
        session: true,
        settings: { ...state.settings, mode: "account", account: { ...state.settings.account, email, name: email.split("@")[0]!, access_expires_at: 1 } },
      };
      save(next);
      return accountStatus(next);
    })
    .with("account_status", async () => {
      return accountStatus(state);
    })
    .with("account_sign_out", async () => {
      save({ ...state, session: false, settings: { ...state.settings, mode: "local" } });
      return null;
    })
    .otherwise(async () => {
      const handler = (HISTORY_HANDLERS[command] ?? RUNTIME_HANDLERS[command]) as MockHandler | undefined;
      if (!handler) fail("unsupported", `${command} is not mocked`);
      return handler(args, { mode: state.settings.mode, model: state.settings.llm.model });
    });
}
