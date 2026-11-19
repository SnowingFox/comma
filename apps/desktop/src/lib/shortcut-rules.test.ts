import { describe, expect, test } from "bun:test";
import { DEFAULT_SHORTCUTS } from "@comma/shared/ipc";
import { hintText } from "../windows/bar/hint-text";
import { canSwitchModes, modeHow, triggerWords } from "./shortcut-rules";

describe("shortcut rules copy (spec 2.3.2)", () => {
  test("each mode says how it starts and finishes", () => {
    expect(modeHow("dictate", DEFAULT_SHORTCUTS)).toContain("Hold to talk");
    expect(modeHow("ask", DEFAULT_SHORTCUTS)).toBe("Press to start, press again or press Fn to finish.");
    expect(modeHow("translate", DEFAULT_SHORTCUTS)).toContain("Or hold and let go.");
    expect(modeHow("ask", { dictate: "Alt+Space" })).toContain("press Option Space to finish");
  });

  test("the switch keys apply only with every mode on Fn", () => {
    expect(canSwitchModes(DEFAULT_SHORTCUTS)).toBe(true);
    expect(canSwitchModes({ ...DEFAULT_SHORTCUTS, ask: "Alt+Shift+Space" })).toBe(false);
    expect(triggerWords("Fn+Space")).toBe("Space");
    expect(triggerWords("Fn+ShiftLeft")).toBe("Left Shift");
  });

  test("bar hints", () => {
    expect(hintText("finish_with_fn", "Fn")).toBe("Press Fn to finish.");
    expect(hintText("ask_hold", "Fn")).toBe("No need to hold. Press Fn to finish.");
    expect(hintText("paste_access", "Fn")).toBe("Copied. Allow Accessibility so Comma can paste for you.");
    expect(hintText("hands_free", "Alt+Space")).toBe("Press Option Space twice to keep talking hands-free.");
  });
});
