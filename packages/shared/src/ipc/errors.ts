import { z } from "zod";

export const AppErrorCode = z.enum([
  "invalid_input",
  "io",
  "keychain",
  "unsupported",
  "internal",
  /** A key or setting the call needs is missing. */
  "not_configured",
  /** The provider rejected the key. */
  "invalid_key",
  /** The key is valid but lacks a permission (ElevenLabs Speech to Text). */
  "missing_permission",
  "unknown_model",
  /** Connection refused, DNS or TLS failure. */
  "unreachable",
  "timeout",
  "rate_limited",
  /** Any other error answer from a provider. */
  "upstream",
  /** The Comma server answered with an error; `reason` carries its `ErrorCode`. */
  "server",
]);
export type AppErrorCode = z.infer<typeof AppErrorCode>;

/** Every command rejects with this shape (spec 3.3). Messages never contain secrets. */
export const AppError = z.object({
  code: AppErrorCode,
  message: z.string(),
  /** Machine-readable upstream reason, e.g. `email_not_verified` or `missing_permissions`. */
  reason: z.string().optional(),
});
export type AppError = z.infer<typeof AppError>;
