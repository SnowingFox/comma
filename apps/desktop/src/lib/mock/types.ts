import type { AppMode, CommandName } from "@comma/shared/ipc";

/** What a mock handler may read from the shared mock state. */
export type MockContext = { mode: AppMode; model: string };

export type MockHandler = (args: Record<string, unknown>, ctx: MockContext) => unknown;

export type MockHandlers = Partial<Record<CommandName, MockHandler>>;
