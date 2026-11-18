import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { match, P } from "ts-pattern";
import { LlmBaseUrl } from "@comma/shared/ipc";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@multica/ui/components/ui/input-otp";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { CircleAlert, UserRound } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { StatusDot } from "../../../components/status-dot";
import { errorMessage, invoke, IpcError } from "../../../lib/ipc";
import { queryKeys, useAccountStatus, useServerCheck, useSettings, useUpdateSettings } from "../../../lib/queries";
import { useStepControls } from "../flow";
import { Stacked } from "./layout";

type View =
  | { kind: "sign_in" }
  | { kind: "sign_up" }
  /** The password is kept in memory only, to sign in right after the code is confirmed. */
  | { kind: "verify"; email: string; password: string };

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-label font-medium">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function ServerRow() {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const url = settings?.account.server_url;
  const check = useServerCheck(url);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(url ?? "");
  useEffect(() => setDraft(url ?? ""), [url]);
  const valid = LlmBaseUrl.safeParse(draft.trim()).success;

  const tone = match(check)
    .with({ status: "success" }, () => "ok" as const)
    .with({ status: "error" }, () => "off" as const)
    .otherwise(() => "pending" as const);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <StatusDot tone={tone} />
        {editing ? (
          <form
            className="flex flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              update.mutate(
                { account: { server_url: draft.trim().replace(/\/+$/, "") } },
                { onSuccess: () => setEditing(false), onError: (err) => toast.error(errorMessage(err)) },
              );
            }}
          >
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label="Server URL" className="h-8 font-mono" autoFocus />
            <Button type="submit" size="sm" disabled={!valid || update.isPending}>
              Save
            </Button>
          </form>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-label font-medium">
                {match(check.status)
                  .with("success", () => "Comma server is reachable")
                  .with("error", () => "Comma server is not reachable")
                  .otherwise(() => "Checking the Comma server…")}
              </span>
              <span className="truncate font-mono text-caption text-muted-foreground">{url}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Change
            </Button>
          </>
        )}
      </div>
      {check.status === "error" && !editing ? (
        <p className="text-caption text-muted-foreground">
          {errorMessage(check.error)}. Start your server, change the address, or use Local instead.
        </p>
      ) : null}
    </div>
  );
}

export function AccountStep() {
  const qc = useQueryClient();
  const status = useAccountStatus();
  const update = useUpdateSettings();
  const [view, setView] = useState<View>({ kind: "sign_in" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const signedIn = status.data?.signed_in ?? false;

  useStepControls({ canContinue: signedIn });

  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
      return err;
    } finally {
      setPending(false);
    }
  };

  const signIn = async (email: string, password: string) => {
    const next = await invoke("account_sign_in", { email, password });
    qc.setQueryData(queryKeys.account, next);
    void qc.invalidateQueries({ queryKey: queryKeys.settings });
  };

  const useLocal = () => update.mutate({ mode: "local" }, { onError: (e) => toast.error(errorMessage(e)) });

  return (
    <Stacked
      title={signedIn ? "You're signed in" : "Sign in to Comma"}
      lead="Your Comma server holds the provider keys and runs each request. Nothing else changes on this Mac."
      aside={
        <Button variant="ghost" onClick={useLocal}>
          Use Local instead
        </Button>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-6">
        <div className="flex flex-col gap-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={signedIn ? "signed-in" : view.kind}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
              className="flex flex-col gap-4 rounded-2xl border border-surface-border bg-surface p-5 shadow-[var(--surface-shadow)]"
            >
              {signedIn && status.data ? (
                <SignedIn
                  name={status.data.name}
                  email={status.data.email}
                  onSignOut={() =>
                    void run(async () => {
                      await invoke("account_sign_out");
                      await qc.invalidateQueries({ queryKey: queryKeys.account });
                      await update.mutateAsync({ mode: "account" });
                    })
                  }
                />
              ) : (
                match(view)
                  .with({ kind: P.union("sign_in", "sign_up") }, ({ kind }) => (
                    <CredentialsForm
                      kind={kind}
                      pending={pending}
                      onKind={(k) => {
                        setError(null);
                        setView({ kind: k });
                      }}
                      onSubmit={(form) =>
                        void run(async () => {
                          if (kind === "sign_up") {
                            await invoke("account_register", form);
                            setView({ kind: "verify", email: form.email, password: form.password });
                            return;
                          }
                          try {
                            await signIn(form.email, form.password);
                          } catch (err) {
                            if (err instanceof IpcError && err.reason === "email_not_verified") {
                              setView({ kind: "verify", email: form.email, password: form.password });
                            }
                            throw err;
                          }
                        })
                      }
                    />
                  ))
                  .with({ kind: "verify" }, (v) => (
                    <VerifyForm
                      email={v.email}
                      pending={pending}
                      onBack={() => setView({ kind: "sign_in" })}
                      onResend={() =>
                        void run(async () => {
                          await invoke("account_resend_code", { email: v.email });
                          toast.success("A new code is on its way");
                        })
                      }
                      onSubmit={(code) =>
                        void run(async () => {
                          await invoke("account_verify_email", { email: v.email, code });
                          await signIn(v.email, v.password);
                        })
                      }
                    />
                  ))
                  .exhaustive()
              )}
              <AnimatePresence>
                {error ? (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex items-start gap-1.5 text-label text-destructive"
                    role="alert"
                  >
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span className="selectable">{error}</span>
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </motion.div>
          </AnimatePresence>
        </div>
        <ServerRow />
      </div>
    </Stacked>
  );
}

function SignedIn({ name, email, onSignOut }: { name: string; email: string; onSignOut: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 items-center justify-center rounded-full bg-success/12 text-success">
        <UserRound className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-body font-medium">{name || email}</span>
        <span className="truncate text-label text-muted-foreground">{email}</span>
      </div>
      <Button variant="ghost" size="sm" onClick={onSignOut}>
        Sign out
      </Button>
    </div>
  );
}

function CredentialsForm({
  kind,
  pending,
  onKind,
  onSubmit,
}: {
  kind: "sign_in" | "sign_up";
  pending: boolean;
  onKind: (kind: "sign_in" | "sign_up") => void;
  onSubmit: (form: { email: string; password: string; name: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const signUp = kind === "sign_up";
  const ready = email.includes("@") && (signUp ? password.length >= 8 && name.trim().length > 0 : password.length > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !pending) onSubmit({ email: email.trim(), password, name: name.trim() });
  };

  return (
    <form className="flex flex-col gap-3.5" onSubmit={submit}>
      <Tabs value={kind} onValueChange={(v) => onKind(v === "sign_up" ? "sign_up" : "sign_in")}>
        <TabsList className="w-full">
          <TabsTrigger value="sign_in" className="flex-1">
            Sign in
          </TabsTrigger>
          <TabsTrigger value="sign_up" className="flex-1">
            Create account
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {signUp ? (
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}</Field>
      ) : null}
      <Field label="Email">
        {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" spellCheck={false} />}
      </Field>
      <Field label="Password">
        {(id) => (
          <Input
            id={id}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signUp ? "new-password" : "current-password"}
            placeholder={signUp ? "At least 8 characters" : undefined}
          />
        )}
      </Field>
      <Button type="submit" disabled={!ready || pending} className="self-start">
        {pending ? <Spinner className="size-3.5" /> : null}
        {signUp ? "Create account" : "Sign in"}
      </Button>
    </form>
  );
}

function VerifyForm({
  email,
  pending,
  onBack,
  onResend,
  onSubmit,
}: {
  email: string;
  pending: boolean;
  onBack: () => void;
  onResend: () => void;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) onSubmit(code);
      }}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-body font-medium">Check your email</span>
        <span className="text-label text-muted-foreground">
          Enter the 6-digit code sent to <span className="font-medium text-foreground">{email}</span>.
        </span>
      </div>
      <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={onSubmit} autoFocus disabled={pending}>
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <InputOTPSlot key={i} index={i} className={cn("size-10 text-title-sm")} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={code.length !== 6 || pending}>
          {pending ? <Spinner className="size-3.5" /> : null}
          Confirm
        </Button>
        <Button type="button" variant="ghost" onClick={onResend} disabled={pending}>
          Send a new code
        </Button>
        <Button type="button" variant="ghost" className="ml-auto" onClick={onBack} disabled={pending}>
          Back
        </Button>
      </div>
    </form>
  );
}
