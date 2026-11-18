import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";
import { MulticaWordmark } from "@multica/ui/components/common/multica-wordmark";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { ArrowUpRight } from "@multica/ui/icons";
import commaLicense from "../../../../../../LICENSE?raw";
import multicaLicense from "../../../../../../packages/multica-ui/LICENSE?raw";
import multicaNotice from "../../../../../../packages/multica-ui/NOTICE?raw";
import { CommaMark } from "../../../components/brand";
import { inTauri } from "../../../lib/ipc";
import { openExternal } from "../../../lib/external";
import { Group, SectionHeader } from "./ui";

/** Required by the Multica License: shown wherever Comma shows its own attribution. */
const MULTICA_COPYRIGHT = "Copyright 2025-2026 Index Labs (Hong Kong) Limited";
const MULTICA_URL = "https://github.com/multica-ai/multica";

function useAppVersion() {
  return useQuery({
    queryKey: ["app_version"],
    queryFn: () => (inTauri ? getVersion() : Promise.resolve(__APP_VERSION__)),
    staleTime: Infinity,
  }).data;
}

function LicenseDialog({ title, description, text }: { title: string; description: string; text: string }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>View license</DialogTrigger>
      <DialogContent className="flex max-h-[80%] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <pre className="selectable scrollbar-slim min-h-0 flex-1 overflow-auto rounded-lg bg-muted p-3 font-mono text-caption whitespace-pre-wrap text-muted-foreground">
          {text}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

export function AboutSection() {
  const version = useAppVersion();
  return (
    <>
      <SectionHeader title="About" />
      <div className="flex items-center gap-4 rounded-card border border-surface-border bg-surface p-5 shadow-[var(--surface-shadow)]">
        <CommaMark size={52} />
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-title-lg font-semibold tracking-tight">Comma</span>
          <span className="text-label text-muted-foreground">
            Version {version ?? "…"} · Open-source voice keyboard for macOS
          </span>
        </div>
      </div>

      <Group title="Licenses">
        <div className="flex items-center justify-between gap-6">
          <div className="flex flex-col gap-0.5">
            <span className="text-body font-medium">Comma</span>
            <span className="text-label text-muted-foreground">MIT License. Comma's own code.</span>
          </div>
          <LicenseDialog title="Comma" description="MIT License" text={commaLicense} />
        </div>
        <div className="h-px bg-border" />
        <div className="flex items-center justify-between gap-6">
          <div className="flex flex-col gap-0.5">
            <span className="text-body font-medium">Multica UI</span>
            <span className="text-label text-muted-foreground">
              Multica License (Apache 2.0 with additional conditions). The full text ships with Comma.
            </span>
          </div>
          <LicenseDialog
            title="Multica License"
            description={MULTICA_COPYRIGHT}
            text={`${multicaNotice.trim()}\n\n${"-".repeat(72)}\n\n${multicaLicense}`}
          />
        </div>
      </Group>

      <section
        aria-label="Multica attribution"
        className="flex items-center gap-4 rounded-card border border-surface-border bg-surface p-5 shadow-[var(--surface-shadow)]"
      >
        <MulticaIcon size={40} title="Multica" />
        <div className="flex flex-1 flex-col gap-1.5">
          <MulticaWordmark className="h-4.5 self-start text-foreground" />
          <span className="text-body">UI built with Multica UI</span>
          <span className="text-label text-muted-foreground">{MULTICA_COPYRIGHT}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => openExternal(MULTICA_URL)}>
          Multica on GitHub
          <ArrowUpRight />
        </Button>
      </section>
    </>
  );
}
