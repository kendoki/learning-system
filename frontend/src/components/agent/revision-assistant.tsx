import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  Circle,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { ProposalEvidence } from "@/components/agent/proposal-evidence";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AgentProposalError,
  approveAgentProposal,
  homeKeys,
  streamAgentProposal,
  topicsKeys,
  type PlanProposal,
  type ProposalEvent,
  type TransportKind,
} from "@/lib/api";

type AssistantRun =
  | { status: "idle" }
  | { status: "streaming"; events: ProposalEvent[] }
  | {
      status: "ready";
      proposal: PlanProposal;
      events: ProposalEvent[];
      approvalError: string | null;
    }
  | {
      status: "approving";
      proposal: PlanProposal;
      events: ProposalEvent[];
    }
  | { status: "success"; proposal: PlanProposal }
  | {
      status: "error";
      message: string;
      noData: boolean;
      events: ProposalEvent[];
    };

export function RevisionAssistant(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [transportKind, setTransportKind] =
    useState<TransportKind>("deepseek");
  const [run, setRun] = useState<AssistantRun>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const buildPlan = async (): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    const events: ProposalEvent[] = [];
    setRun({ status: "streaming", events });

    try {
      const proposal = await streamAgentProposal(
        { transport_kind: transportKind },
        (event) => {
          events.push(event);
          setRun({ status: "streaming", events: [...events] });
        },
        controller.signal,
      );
      setRun({
        status: "ready",
        proposal,
        events: [...events],
        approvalError: null,
      });
    } catch (error) {
      setRun({
        status: "error",
        message: error instanceof Error ? error.message : "Proposal generation failed.",
        noData:
          error instanceof AgentProposalError && error.errorKind === "no_data",
        events: [...events],
      });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  const approvePlan = async (
    proposal: PlanProposal,
    events: ProposalEvent[],
  ): Promise<void> => {
    setRun({ status: "approving", proposal, events });
    try {
      await approveAgentProposal(proposal);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: topicsKeys.all() }),
        queryClient.invalidateQueries({ queryKey: homeKeys.all() }),
      ]);
      setRun({ status: "success", proposal });
    } catch (error) {
      setRun({
        status: "ready",
        proposal,
        events,
        approvalError:
          error instanceof Error ? error.message : "Approval failed.",
      });
    }
  };

  const hasAttention =
    run.status === "ready" || run.status === "success" || run.status === "error";

  return (
    <>
      <Button
        type="button"
        size="lg"
        className="fixed right-4 bottom-4 z-40 rounded-full px-4 shadow-lg sm:right-6 sm:bottom-6"
        onClick={() => { setOpen(true); }}
        aria-label="Open revision assistant"
      >
        {run.status === "streaming" || run.status === "approving" ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Sparkles />
        )}
        <span className="hidden sm:inline">Revision assistant</span>
        {hasAttention ? (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-background bg-warning"
          />
        ) : null}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="inset-0 h-dvh max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none p-0 sm:top-0 sm:right-0 sm:bottom-0 sm:left-auto sm:w-[34rem] sm:max-w-[calc(100%-2rem)] sm:rounded-l-2xl"
        >
          <header className="shrink-0 border-b px-5 py-4 pr-14">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4" />
                Revision assistant
              </DialogTitle>
              <DialogDescription>
                Build an evidence-grounded plan from your weak topics, then
                approve all changes atomically.
              </DialogDescription>
            </DialogHeader>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <AssistantBody
              run={run}
              transportKind={transportKind}
              onTransportChange={setTransportKind}
              onBuild={() => { void buildPlan(); }}
              onDismiss={() => { setRun({ status: "idle" }); }}
              onApprove={(proposal, events) => {
                void approvePlan(proposal, events);
              }}
              onClose={() => { setOpen(false); }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

type AssistantBodyProps = {
  run: AssistantRun;
  transportKind: TransportKind;
  onTransportChange: (kind: TransportKind) => void;
  onBuild: () => void;
  onDismiss: () => void;
  onApprove: (proposal: PlanProposal, events: ProposalEvent[]) => void;
  onClose: () => void;
};

function AssistantBody({
  run,
  transportKind,
  onTransportChange,
  onBuild,
  onDismiss,
  onApprove,
  onClose,
}: AssistantBodyProps): React.JSX.Element {
  if (run.status === "idle") {
    return (
      <IdleView
        transportKind={transportKind}
        onTransportChange={onTransportChange}
        onBuild={onBuild}
      />
    );
  }
  if (run.status === "streaming") {
    return <ProgressView events={run.events} />;
  }
  if (run.status === "error") {
    return (
      <ErrorView
        message={run.message}
        noData={run.noData}
        onRetry={onBuild}
        onDismiss={onDismiss}
      />
    );
  }
  if (run.status === "success") {
    return <SuccessView proposal={run.proposal} onClose={onClose} />;
  }

  const approving = run.status === "approving";
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 p-5">
        <ProposalEvidence proposal={run.proposal} />
        {run.status === "ready" && run.approvalError !== null ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{run.approvalError}</p>
          </div>
        ) : null}
      </div>
      <div className="sticky bottom-0 border-t bg-popover/95 p-4 backdrop-blur">
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onDismiss}
            disabled={approving}
          >
            Dismiss
          </Button>
          <Button
            type="button"
            onClick={() => { onApprove(run.proposal, run.events); }}
            disabled={approving}
          >
            {approving ? (
              <>
                <Loader2 className="animate-spin" />
                Applying changes
              </>
            ) : (
              "Approve all changes"
            )}
          </Button>
        </DialogFooter>
      </div>
    </div>
  );
}

function IdleView({
  transportKind,
  onTransportChange,
  onBuild,
}: {
  transportKind: TransportKind;
  onTransportChange: (kind: TransportKind) => void;
  onBuild: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col justify-between gap-8 p-5">
      <div className="flex flex-col gap-6">
        <div className="rounded-xl border bg-muted/30 p-4">
          <h3 className="font-heading font-semibold">Plan revisions</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            The planner reads your weak-topic history. A retrieval specialist
            then checks your corpus for each proposed topic.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="revision-transport">Transport</Label>
          <Select
            value={transportKind}
            onValueChange={(value) => {
              onTransportChange(value as TransportKind);
            }}
          >
            <SelectTrigger id="revision-transport" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deepseek">DeepSeek</SelectItem>
              <SelectItem value="claude_playwright">
                Claude (Playwright)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button type="button" size="lg" onClick={onBuild} className="w-full">
        <Sparkles />
        Build revision plan
      </Button>
    </div>
  );
}

function ProgressView({
  events,
}: {
  events: ProposalEvent[];
}): React.JSX.Element {
  const rows = progressRows(events);
  return (
    <div className="p-5" role="status" aria-live="polite">
      <div className="rounded-xl border bg-muted/30 p-4">
        <div className="flex items-center gap-3">
          <Loader2 className="size-5 animate-spin" />
          <div>
            <h3 className="font-heading font-semibold">Building your plan</h3>
            <p className="text-sm text-muted-foreground">
              Planner and specialist calls run sequentially.
            </p>
          </div>
        </div>
      </div>
      <ol className="mt-5 flex flex-col gap-3">
        {rows.map((row, index) => (
          <li
            key={`${row.label}:${String(index)}`}
            className="flex items-start gap-3 text-sm"
          >
            {row.complete ? (
              <Check className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 animate-pulse text-muted-foreground" />
            )}
            <span className={row.complete ? "" : "text-muted-foreground"}>
              {row.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ErrorView({
  message,
  noData,
  onRetry,
  onDismiss,
}: {
  message: string;
  noData: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col justify-between gap-6 p-5">
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div>
            <h3 className="font-heading font-semibold">
              {noData ? "Nothing to revise yet" : "Could not build the plan"}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {message}
            </p>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDismiss}>
          Back
        </Button>
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      </DialogFooter>
    </div>
  );
}

function SuccessView({
  proposal,
  onClose,
}: {
  proposal: PlanProposal;
  onClose: () => void;
}): React.JSX.Element {
  const changeCount = proposal.plan.steps.filter(
    (step) => step.tool === "mark_for_revision",
  ).length;
  return (
    <div className="flex min-h-full flex-col justify-between gap-8 p-5">
      <div className="rounded-xl border border-success/30 bg-success/10 p-5">
        <div className="flex size-10 items-center justify-center rounded-full bg-success/15">
          <Check className="size-5 text-success" />
        </div>
        <h3 className="mt-4 font-heading text-lg font-semibold">
          Revision plan applied
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {changeCount} {changeCount === 1 ? "topic is" : "topics are"} now
          marked for revision.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button asChild size="lg" className="w-full">
          <Link to="/topics" onClick={onClose}>
            View topics
          </Link>
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

type ProgressRow = {
  label: string;
  complete: boolean;
};

function progressRows(events: ProposalEvent[]): ProgressRow[] {
  const rows: ProgressRow[] = [];
  for (const event of events) {
    if (event.kind === "planning_started") {
      rows.push({ label: "Reading weak topics and drafting a plan", complete: false });
    } else if (event.kind === "plan_ready") {
      const planningRow = rows.find((row) =>
        row.label.startsWith("Reading weak topics")
      );
      if (planningRow !== undefined) {
        planningRow.complete = true;
      }
      rows.push({
        label: `Grounded plan ready for ${String(event.plan.steps.length)} topics`,
        complete: true,
      });
    } else if (event.kind === "specialist_started") {
      rows.push({
        label: `Checking corpus for ${event.topic_path} (${String(event.position)}/${String(event.total)})`,
        complete: false,
      });
    } else if (event.kind === "specialist_finished") {
      const activeRow = [...rows].reverse().find(
        (row) =>
          !row.complete && row.label.startsWith(`Checking corpus for ${event.topic_path}`),
      );
      if (activeRow !== undefined) {
        activeRow.complete = true;
      }
    }
  }
  return rows;
}
