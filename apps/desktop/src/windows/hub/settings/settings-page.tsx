import { lazy, Suspense, type ComponentType, type SVGProps } from "react";
import { BellRing, Code, Info, Keyboard, Lock, Mic, Scan, Settings2, ShieldCheck, Sparkles } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { Page } from "../page";
import { navigate, useRoute } from "../route";
import { AboutSection } from "./about";
import {
  ContextSection,
  GeneralSection,
  LlmSection,
  PermissionsSection,
  PrivacySection,
  ShortcutsSection,
  SoundsSection,
  SpeechSection,
} from "./sections";

// Kept out of release bundles entirely.
const DeveloperSection = import.meta.env.DEV
  ? lazy(() => import("./developer").then((m) => ({ default: m.DeveloperSection })))
  : null;

type Section = {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  render: ComponentType;
};

const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: Settings2, render: GeneralSection },
  { id: "speech", label: "Speech to text", icon: Mic, render: SpeechSection },
  { id: "llm", label: "LLM", icon: Sparkles, render: LlmSection },
  { id: "context", label: "Context", icon: Scan, render: ContextSection },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard, render: ShortcutsSection },
  { id: "sounds", label: "Sounds and bar", icon: BellRing, render: SoundsSection },
  { id: "privacy", label: "Privacy", icon: Lock, render: PrivacySection },
  { id: "permissions", label: "Permissions", icon: ShieldCheck, render: PermissionsSection },
  { id: "about", label: "About", icon: Info, render: AboutSection },
  ...(DeveloperSection ? [{ id: "developer", label: "Developer", icon: Code, render: DeveloperSection }] : []),
];

export function SettingsPage() {
  const { section } = useRoute();
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  const Content = active.render;

  return (
    <Page title="Settings" className="flex overflow-hidden">
      <nav aria-label="Settings sections" className="scrollbar-slim w-52 shrink-0 overflow-y-auto border-r border-border p-2">
        <ul className="flex flex-col gap-0.5">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => navigate("settings", id)}
                aria-current={id === active.id ? "page" : undefined}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-nav-item px-2 text-left text-body transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
                  id === active.id
                    ? "bg-nav-item-active font-medium text-nav-item-active-foreground"
                    : "text-nav-item hover:bg-nav-item-hover hover:text-nav-item-hover-foreground",
                  id === "developer" && "mt-3",
                )}
              >
                <Icon />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="scrollbar-slim min-w-0 flex-1 overflow-y-auto">
        <div key={active.id} className="animate-onboarding-enter mx-auto flex max-w-2xl flex-col gap-6 px-8 py-7">
          <Suspense fallback={null}>
            <Content />
          </Suspense>
        </div>
      </div>
    </Page>
  );
}
