/**
 * Typed client for the revision-assistant proposal stream.
 *
 * Progress arrives as named SSE events over a POST fetch request.
 * The terminal proposal remains lossless so approval can echo the
 * plan and evidence back to the stateless backend.
 */

import { z } from "zod";

import { ApiError, apiFetchVoid, apiRequest } from "@/lib/api/client";
import { TransportKindSchema } from "@/lib/api/sessions";
import { SseDecoder, type SseFrame } from "@/lib/api/sse";

const JsonObjectSchema = z.record(z.string(), z.unknown());

const GetWeakTopicsStepSchema = z.object({
  kind: z.literal("read"),
  tool: z.literal("get_weak_topics"),
  args: z.object({
    min_attempts: z.number().int().positive(),
    sample_size: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

const MarkForRevisionStepSchema = z.object({
  kind: z.literal("mutate"),
  tool: z.literal("mark_for_revision"),
  args: z.object({
    path: z.string().min(1),
  }).passthrough(),
}).passthrough();

export const PlanStepSchema = z.discriminatedUnion("tool", [
  GetWeakTopicsStepSchema,
  MarkForRevisionStepSchema,
]);
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  steps: z.array(PlanStepSchema),
}).passthrough();
export type Plan = z.infer<typeof PlanSchema>;

export const EvidenceSchema = z.object({
  tool: z.string().min(1),
  result: JsonObjectSchema,
}).passthrough();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const PlanProposalSchema = z.object({
  plan: PlanSchema,
  evidence: z.array(EvidenceSchema),
}).passthrough();
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

export const PlannerErrorKindSchema = z.enum([
  "transport_failed",
  "parse_failed",
  "tool_handler_failed",
  "disallowed_tool",
  "no_data",
  "ungrounded",
  "unexpected",
]);
export type PlannerErrorKind = z.infer<typeof PlannerErrorKindSchema>;

const PositionSchema = z.number().int().positive();

export const ProposalEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("planning_started"),
  }),
  z.object({
    kind: z.literal("plan_ready"),
    plan: PlanSchema,
    evidence: z.array(EvidenceSchema),
  }),
  z.object({
    kind: z.literal("specialist_started"),
    topic_path: z.string().min(1),
    position: PositionSchema,
    total: PositionSchema,
  }),
  z.object({
    kind: z.literal("specialist_finished"),
    topic_path: z.string().min(1),
    position: PositionSchema,
    total: PositionSchema,
    evidence: EvidenceSchema,
  }),
  z.object({
    kind: z.literal("proposal_ready"),
    proposal: PlanProposalSchema,
  }),
  z.object({
    kind: z.literal("proposal_failed"),
    error_kind: PlannerErrorKindSchema,
    message: z.string().min(1),
  }),
]);
export type ProposalEvent = z.infer<typeof ProposalEventSchema>;

export const WrongAnswerSampleSchema = z.object({
  question: z.string(),
  verdict: z.enum(["correct", "partial", "incorrect", "open_graded"]),
});

export const WeakTopicInfoSchema = z.object({
  topic_path: z.string().min(1),
  incorrect_count: z.number().int().nonnegative(),
  partial_count: z.number().int().nonnegative(),
  correct_count: z.number().int().nonnegative(),
  samples: z.array(WrongAnswerSampleSchema),
});
export type WeakTopicInfo = z.infer<typeof WeakTopicInfoSchema>;

export const GetWeakTopicsOutputSchema = z.object({
  topics: z.array(WeakTopicInfoSchema),
});

export const CorpusHitSchema = z.object({
  source_type: z.enum(["learned_item", "document_chunk"]),
  content: z.string(),
  score: z.number(),
});
export type CorpusHit = z.infer<typeof CorpusHitSchema>;

export const SearchCorpusOutputSchema = z.object({
  hits: z.array(CorpusHitSchema),
});

const SpecialistErrorKindSchema = z.enum([
  "transport_failed",
  "parse_failed",
  "tool_handler_failed",
  "disallowed_tool",
  "ungrounded",
  "unexpected",
]);

export const SpecialistResultSchema = z.object({
  status: z.literal("completed"),
  finding: z.object({
    specialist: z.literal("retrieval_specialist"),
    topic_path: z.string().min(1),
    summary: z.string().min(1),
  }),
  evidence: z.array(EvidenceSchema),
});
export type SpecialistResult = z.infer<typeof SpecialistResultSchema>;

export const SpecialistFailureSchema = z.object({
  status: z.literal("failed"),
  specialist: z.literal("retrieval_specialist"),
  topic_path: z.string().min(1),
  error_kind: SpecialistErrorKindSchema,
  message: z.string().min(1),
});
export type SpecialistFailure = z.infer<typeof SpecialistFailureSchema>;

export const SpecialistOutcomeSchema = z.discriminatedUnion("status", [
  SpecialistResultSchema,
  SpecialistFailureSchema,
]);
export type SpecialistOutcome = z.infer<typeof SpecialistOutcomeSchema>;

export type AgentProposalRequest = {
  transport_kind: z.infer<typeof TransportKindSchema>;
};

export class AgentProposalError extends Error {
  readonly errorKind: PlannerErrorKind;

  constructor(errorKind: PlannerErrorKind, message: string) {
    super(message);
    this.name = "AgentProposalError";
    this.errorKind = errorKind;
  }
}

export async function streamAgentProposal(
  request: AgentProposalRequest,
  onEvent: (event: ProposalEvent) => void,
  signal?: AbortSignal,
): Promise<PlanProposal> {
  const response = await apiRequest("/agent/propose/stream", {
    method: "POST",
    body: request,
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.body === null) {
    throw new ApiError("parse", "Proposal stream returned no response body.");
  }

  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const sseDecoder = new SseDecoder();
  let terminalSeen = false;
  let proposal: PlanProposal | undefined;
  let failure: AgentProposalError | undefined;

  const consumeFrames = (frames: SseFrame[]): void => {
    for (const frame of frames) {
      if (terminalSeen) {
        throw new ApiError("parse", "Proposal stream emitted an event after its terminal.");
      }
      const event = parseProposalEvent(frame);
      onEvent(event);
      if (event.kind === "proposal_ready") {
        terminalSeen = true;
        proposal = event.proposal;
      } else if (event.kind === "proposal_failed") {
        terminalSeen = true;
        failure = new AgentProposalError(event.error_kind, event.message);
      }
    }
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      consumeFrames(sseDecoder.push(textDecoder.decode(chunk.value, { stream: true })));
    }
    consumeFrames(sseDecoder.push(textDecoder.decode()));
    sseDecoder.finish();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (failure !== undefined) {
    throw failure;
  }
  if (proposal === undefined) {
    throw new ApiError("parse", "Proposal stream ended without a ready terminal event.");
  }
  return proposal;
}

export async function approveAgentProposal(proposal: PlanProposal): Promise<void> {
  await apiFetchVoid("/agent/approve", {
    method: "POST",
    body: proposal,
  });
}

function parseProposalEvent(frame: SseFrame): ProposalEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch (error) {
    throw new ApiError("parse", "Proposal stream contained invalid JSON.", {
      cause: error,
    });
  }

  const parsed = ProposalEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError("parse", "Proposal stream event did not match its schema.", {
      cause: parsed.error,
    });
  }
  if (frame.event !== parsed.data.kind) {
    throw new ApiError(
      "parse",
      `Proposal stream event name ${String(frame.event)} did not match ${parsed.data.kind}.`,
    );
  }
  return parsed.data;
}
