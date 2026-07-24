import {
  BookOpenCheck,
  CheckCircle2,
  Database,
  TriangleAlert,
} from "lucide-react";

import {
  GetWeakTopicsOutputSchema,
  SearchCorpusOutputSchema,
  SpecialistOutcomeSchema,
  type CorpusHit,
  type Evidence,
  type PlanProposal,
  type SpecialistOutcome,
  type WeakTopicInfo,
} from "@/lib/api";

type ProposalEvidenceProps = {
  proposal: PlanProposal;
};

export function ProposalEvidence({
  proposal,
}: ProposalEvidenceProps): React.JSX.Element {
  const steps = proposal.plan.steps.filter(
    (step) => step.tool === "mark_for_revision",
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-heading text-base font-semibold">
          Proposed changes
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {steps.length} {steps.length === 1 ? "topic" : "topics"} will be
          marked for revision in one atomic approval.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {steps.map((step, index) => {
          const topicPath = step.args.path;
          return (
            <TopicEvidenceCard
              key={`${topicPath}:${String(index)}`}
              index={index}
              topicPath={topicPath}
              weakTopic={findWeakTopic(topicPath, proposal.evidence)}
              specialist={findSpecialistOutcome(topicPath, proposal.evidence)}
            />
          );
        })}
      </div>
    </div>
  );
}

type TopicEvidenceCardProps = {
  index: number;
  topicPath: string;
  weakTopic: WeakTopicInfo | undefined;
  specialist: SpecialistOutcome | undefined;
};

function TopicEvidenceCard({
  index,
  topicPath,
  weakTopic,
  specialist,
}: TopicEvidenceCardProps): React.JSX.Element {
  return (
    <article className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b bg-muted/40 px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="break-words font-medium">{topicPath}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Mark for revision
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <WeakTopicEvidence weakTopic={weakTopic} />
        <SpecialistEvidence specialist={specialist} />
      </div>
    </article>
  );
}

function WeakTopicEvidence({
  weakTopic,
}: {
  weakTopic: WeakTopicInfo | undefined;
}): React.JSX.Element {
  if (weakTopic === undefined) {
    return (
      <EvidenceWarning>
        The matching weak-topic evidence could not be displayed.
      </EvidenceWarning>
    );
  }

  return (
    <section aria-label="Learning history">
      <div className="flex items-center gap-2 text-sm font-medium">
        <BookOpenCheck className="size-4 text-muted-foreground" />
        Learning history
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Metric label="Incorrect" value={weakTopic.incorrect_count} tone="error" />
        <Metric label="Partial" value={weakTopic.partial_count} tone="warning" />
        <Metric label="Correct" value={weakTopic.correct_count} tone="neutral" />
      </div>
      {weakTopic.samples.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {weakTopic.samples.map((sample, index) => (
            <div
              key={`${sample.question}:${String(index)}`}
              className="rounded-lg bg-muted/50 px-3 py-2"
            >
              <p className="text-sm leading-relaxed">{sample.question}</p>
              <p className="mt-1 text-xs capitalize text-muted-foreground">
                {sample.verdict.replace("_", " ")}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SpecialistEvidence({
  specialist,
}: {
  specialist: SpecialistOutcome | undefined;
}): React.JSX.Element {
  if (specialist === undefined) {
    return (
      <EvidenceWarning>
        Retrieval evidence was not returned for this topic.
      </EvidenceWarning>
    );
  }
  if (specialist.status === "failed") {
    return (
      <section
        aria-label="Retrieval evidence unavailable"
        className="rounded-lg border border-warning/30 bg-warning/10 p-3"
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="size-4 text-warning" />
          Retrieval evidence unavailable
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {specialist.message}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {specialist.error_kind.replaceAll("_", " ")}
        </p>
      </section>
    );
  }

  const hits = collectSearchHits(specialist);
  return (
    <section aria-label="Corpus evidence">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Database className="size-4 text-muted-foreground" />
        Corpus evidence
      </div>
      <div className="mt-2 rounded-lg border border-success/30 bg-success/10 p-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          <p className="text-sm leading-relaxed">
            {specialist.finding.summary}
          </p>
        </div>
      </div>
      {hits.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No matching corpus material was found.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {hits.map((hit, index) => (
            <SearchHitRow
              key={`${hit.source_type}:${hit.content}:${String(index)}`}
              hit={hit}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SearchHitRow({ hit }: { hit: CorpusHit }): React.JSX.Element {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {hit.source_type === "learned_item" ? "Past answer" : "Document"}
        </span>
        <span>{Math.round(hit.score * 100)}% match</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
        {hit.content}
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "error" | "warning" | "neutral";
}): React.JSX.Element {
  const toneClass = {
    error: "bg-destructive/10 text-destructive",
    warning: "bg-warning/15 text-warning",
    neutral: "bg-muted text-muted-foreground",
  }[tone];
  return (
    <span className={`rounded-full px-2.5 py-1 ${toneClass}`}>
      {value} {label.toLowerCase()}
    </span>
  );
}

function EvidenceWarning({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

function findWeakTopic(
  topicPath: string,
  evidence: Evidence[],
): WeakTopicInfo | undefined {
  for (const entry of evidence) {
    if (entry.tool !== "get_weak_topics") {
      continue;
    }
    const parsed = GetWeakTopicsOutputSchema.safeParse(entry.result);
    if (!parsed.success) {
      continue;
    }
    const match = parsed.data.topics.find(
      (topic) => topic.topic_path === topicPath,
    );
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function findSpecialistOutcome(
  topicPath: string,
  evidence: Evidence[],
): SpecialistOutcome | undefined {
  for (const entry of evidence) {
    if (entry.tool !== "retrieval_specialist") {
      continue;
    }
    const parsed = SpecialistOutcomeSchema.safeParse(entry.result);
    if (!parsed.success) {
      continue;
    }
    const resultPath = parsed.data.status === "completed"
      ? parsed.data.finding.topic_path
      : parsed.data.topic_path;
    if (resultPath === topicPath) {
      return parsed.data;
    }
  }
  return undefined;
}

function collectSearchHits(specialist: Extract<
  SpecialistOutcome,
  { status: "completed" }
>): CorpusHit[] {
  const hits: CorpusHit[] = [];
  for (const entry of specialist.evidence) {
    if (entry.tool !== "search_corpus") {
      continue;
    }
    const parsed = SearchCorpusOutputSchema.safeParse(entry.result);
    if (parsed.success) {
      hits.push(...parsed.data.hits);
    }
  }
  return hits;
}
