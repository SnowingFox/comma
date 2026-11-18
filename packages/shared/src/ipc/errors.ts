import { z } from "zod";

export const AppErrorCode = z.enum([
  "invalid_input",
  "io",
  "keychain",
  "unsupported",
  "internal",
]);
export type AppErrorCode = z.infer<typeof AppErrorCode>;

/** Every command rejects with this shape (spec 3.3). Messages never contain secrets. */
export const AppError = z.object({
  code: AppErrorCode,
  message: z.string(),
});
export type AppError = z.infer<typeof AppError>;
