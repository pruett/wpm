import type { ReactNode } from "react";
import { getRundown } from "@/app/_data/rundown";
import { Card, CardBody, CardHeader, CardEyebrow, CardTitle } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { formatDollars, formatCount } from "@/app/_lib/format";

/** Render Telegram-flavored markdown: **bold**, *italic*, and paragraph breaks. */
function renderMarkdown(text: string): ReactNode {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para, pi) => (
      <p key={pi} className="text-[0.95rem] leading-relaxed text-foreground/90">
        {para.split("\n").map((line, li, arr) => (
          <span key={li}>
            {renderInline(line)}
            {li < arr.length - 1 && <br />}
          </span>
        ))}
      </p>
    ));
}

function renderInline(line: string): ReactNode {
  // Split on **bold** and *italic* runs, keeping the delimiters via capture.
  const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-bold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={i} className="text-gold-soft not-italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    return part;
  });
}

function Header({ when }: { when?: string }) {
  return (
    <CardHeader>
      <div>
        <CardEyebrow>The Sunday Rundown</CardEyebrow>
        <CardTitle>Word From the Commissioner</CardTitle>
      </div>
      {when && <Badge tone="neutral">{when}</Badge>}
    </CardHeader>
  );
}

/** The weekly LLM recap — the bot's trash-talk commissioner, rendered for the web. */
export async function Rundown() {
  const r = await getRundown();

  if (!r) {
    return (
      <Card className="flex h-full flex-col">
        <Header />
        <CardBody className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
          <span className="text-4xl">📭</span>
          <p className="display text-2xl text-muted">No rundown yet.</p>
          <p className="max-w-[34ch] text-sm text-muted">
            The commissioner files his report every Sunday night. Place some bets and give
            him something to work with.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="flex h-full flex-col">
      <Header when={r.ageLabel} />
      <CardBody className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-3">{renderMarkdown(r.body)}</div>

        <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4 text-xs text-muted">
          {r.betsPlaced != null && (
            <span>
              <span className="nums font-semibold text-foreground">{formatCount(r.betsPlaced)}</span>{" "}
              bets
            </span>
          )}
          {r.totalStakedCents != null && (
            <span>
              <span className="nums font-semibold text-foreground">
                {formatDollars(r.totalStakedCents)}
              </span>{" "}
              wagered
            </span>
          )}
          {r.wins != null && r.losses != null && (
            <span>
              <span className="nums font-semibold text-win">{r.wins}W</span>
              {" · "}
              <span className="nums font-semibold text-loss">{r.losses}L</span>
            </span>
          )}
          <span className="ml-auto text-faint">
            {r.model === "fallback" ? "auto-generated" : `via ${r.model.split("/").pop()}`}
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

export function RundownSkeleton() {
  return (
    <Card className="flex h-full flex-col">
      <Header />
      <CardBody className="flex flex-1 flex-col gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[92%]" />
        <Skeleton className="h-4 w-[97%]" />
        <Skeleton className="h-4 w-[78%]" />
        <Skeleton className="h-4 w-[88%]" />
        <div className="mt-auto flex gap-4 border-t border-border pt-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-14" />
        </div>
      </CardBody>
    </Card>
  );
}
