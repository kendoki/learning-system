"""Planner service.

Drives the propose half of the agent's propose/approve round trip.
The LLM reads the user's weak topics through the tool-call loop and
emits a mutate-only plan. The tool results are kept as Evidence, the
plan is checked against them, and the pair goes back to the caller.
Nothing mutates during propose.

Approve receives the plan and evidence back, re-checks groundedness
(the backend holds no state between the two calls), and executes
through the orchestrator's transaction boundary.

The chat is throwaway: no persistence, no session row. Mirrors the
diagnostic service's loop with two differences. Tool calls are gated
against a read allowlist before dispatch, because registry handlers
commit their own writes and an unapproved mutation must die
structurally rather than by prompt promise. And get_weak_topics
results become Evidence instead of being discarded.
"""

from __future__ import annotations

import contextlib
import json
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from app.prompts.planner_intro import build_planner_intro
from app.schemas.agent_plan import Evidence, MarkForRevisionStep, PlanProposal
from app.schemas.agent_progress import (
    PlannerErrorKind,
    PlanningStarted,
    PlanReady,
    ProposalFailed,
    ProposalReady,
    SpecialistFinished,
    SpecialistStarted,
)
from app.schemas.agent_specialist import SpecialistFailure
from app.schemas.parsed_response import ParsedToolCall
from app.schemas.tools import GetWeakTopicsInput, GetWeakTopicsOutput
from app.services.agent_orchestrator import run_plan
from app.services.agent_specialist import SpecialistServiceError, gather_grounding
from app.services.parser import ParseError, parse_plan_response
from app.services.tools.handlers import ToolHandlerError, get_weak_topics
from app.services.tools.registry import execute_tool_call
from app.transport.base import (
    ToolResult,
    TransportError,
    TransportResponse,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from sqlalchemy.orm import Session as DbSession

    from app.models import TransportKind
    from app.schemas.agent_plan import ParsedPlan, Plan
    from app.schemas.agent_progress import ProposalEvent
    from app.schemas.tools import WeakTopicInfo
    from app.services.agent_error_recorder import AgentErrorRecorder
    from app.services.embedding_service import Embedder
    from app.transport.base import LLMTransport


# First message sent to the planner chat after the intro. Kept thin:
# the intro carries the instructions, this is the "go" signal.
_FIRST_MESSAGE = (
    "Read the user's weak topics with get_weak_topics, then respond "
    "with a PLAN block proposing which topics to mark for revision."
)

# Tools the planner LLM may call during the propose loop. Checked
# before registry dispatch: the registry's write handlers commit
# their own writes, and a mutation during propose would be an
# unapproved write. The phase split is structural, not a prompt rule.
# The same tuple is the chat's advertised surface, so the transport
# can never offer the LLM a tool this gate would reject.
_PLANNER_TOOL_NAMES: tuple[str, ...] = ("get_weak_topics",)
_ALLOWED_TOOLS = frozenset(_PLANNER_TOOL_NAMES)

_SPECIALIST_UNAVAILABLE_MESSAGE = "Retrieval enrichment was unavailable for this topic."


class PlannerServiceError(Exception):
    """A planner-service operation failed.

    Wraps the underlying cause so callers see one error type at the
    service boundary. kind is the discriminator the route layer uses
    to pick the HTTP status: no_data maps to 422, ungrounded and
    disallowed_tool map to 502 since both mean the upstream LLM broke
    its contract.
    """

    def __init__(
        self,
        message: str,
        kind: PlannerErrorKind,
        cause: Exception | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.kind: PlannerErrorKind = kind
        self.cause = cause


async def propose_plan(
    *,
    db: DbSession,
    transport: LLMTransport[Any],
    embedder: Embedder,
    transport_kind: TransportKind,
) -> PlanProposal:
    """Consume proposal events and return or raise on the terminal.

    The streaming generator is the single implementation of proposal
    generation. This wrapper preserves the ordinary endpoint's
    service contract by returning ProposalReady and translating
    ProposalFailed back into PlannerServiceError.
    """
    async for event in stream_plan_proposal(
        db=db,
        transport=transport,
        embedder=embedder,
        transport_kind=transport_kind,
    ):
        if isinstance(event, ProposalReady):
            return event.proposal
        if isinstance(event, ProposalFailed):
            raise PlannerServiceError(
                event.message,
                kind=event.error_kind,
            )

    raise PlannerServiceError(
        "Proposal generation ended without a terminal event.",
        kind="unexpected",
    )


async def stream_plan_proposal(
    *,
    db: DbSession,
    transport: LLMTransport[Any],
    embedder: Embedder,
    transport_kind: TransportKind,
) -> AsyncIterator[ProposalEvent]:
    """Yield proposal progress at planner and specialist boundaries.

    The stream always starts with planning_started and ends with
    exactly one proposal_ready or proposal_failed event. Application
    failures are terminal data because an SSE response cannot change
    its HTTP status after headers have been sent.

    transport_kind is accepted for signature symmetry with the route
    dependencies. The flow has no per-transport branching.
    """
    yield PlanningStarted()

    try:
        plan, planner_evidence, weak_topics = await _build_grounded_plan(
            db=db,
            transport=transport,
            embedder=embedder,
        )
        yield PlanReady(plan=plan, evidence=planner_evidence)

        specialist_evidence: list[Evidence] = []
        total = len(plan.steps)
        for position, step in enumerate(plan.steps, start=1):
            if not isinstance(step, MarkForRevisionStep):
                continue
            topic_path = step.args.path
            yield SpecialistStarted(
                topic_path=topic_path,
                position=position,
                total=total,
            )
            outcome = await _gather_specialist_evidence(
                db=db,
                transport=transport,
                embedder=embedder,
                topic_path=topic_path,
                weak_topic=weak_topics[topic_path],
            )
            specialist_evidence.append(outcome)
            yield SpecialistFinished(
                topic_path=topic_path,
                position=position,
                total=total,
                evidence=outcome,
            )

        proposal = PlanProposal(
            plan=plan,
            evidence=[*planner_evidence, *specialist_evidence],
        )
    except PlannerServiceError as exc:
        yield ProposalFailed(
            error_kind=exc.kind,
            message=exc.message,
        )
        return
    except Exception as exc:
        yield ProposalFailed(
            error_kind="unexpected",
            message=f"Unexpected error during planner flow: {exc}",
        )
        return

    yield ProposalReady(proposal=proposal)


async def _build_grounded_plan(
    *,
    db: DbSession,
    transport: LLMTransport[Any],
    embedder: Embedder,
) -> tuple[Plan, list[Evidence], dict[str, WeakTopicInfo]]:
    """Run the planner stage and return its grounded artifacts.

    The planner chat is closed before specialist fan-out begins,
    including every failure path.
    """
    await _check_plannable_state(db)
    intro = build_planner_intro()

    try:
        chat, response = await transport.start_new_chat(
            intro, _FIRST_MESSAGE, tool_names=_PLANNER_TOOL_NAMES
        )
    except TransportError as exc:
        raise PlannerServiceError(
            f"Transport failed opening planner chat: {exc.message}",
            kind="transport_failed",
            cause=exc,
        ) from exc

    try:
        parsed, evidence = await _execute_until_plan(
            transport=transport,
            embedder=embedder,
            chat=chat,
            response=response,
            db=db,
        )
    except PlannerServiceError:
        await _close_quietly(transport, chat)
        raise
    except Exception as exc:
        await _close_quietly(transport, chat)
        raise PlannerServiceError(
            f"Unexpected error during planner flow: {exc}",
            kind="unexpected",
            cause=exc,
        ) from exc

    await _close_quietly(transport, chat)
    weak_topics = _assert_plan_grounded(parsed.plan, evidence)
    return parsed.plan, evidence, weak_topics


async def approve_plan(
    *,
    db: DbSession,
    recorder: AgentErrorRecorder,
    plan: Plan,
    evidence: list[Evidence],
) -> None:
    """Re-check groundedness, then execute the plan's mutations.

    The backend holds no state between propose and approve, so the
    plan and evidence arrive back from the caller and the same guard
    runs again before anything executes. Execution goes through
    run_plan with approval: one transaction, all-or-nothing.

    Raises PlannerServiceError(kind="ungrounded") from the guard.
    Lets AgentOrchestratorError propagate unwrapped: a mutation
    failure is the orchestrator's contract and the route maps it
    separately.
    """
    _assert_plan_grounded(plan, evidence)
    await run_plan(db=db, recorder=recorder, plan=plan, approve=True)


async def _execute_until_plan(
    *,
    transport: LLMTransport[Any],
    embedder: Embedder,
    chat: Any,
    response: TransportResponse,
    db: DbSession,
) -> tuple[ParsedPlan, list[Evidence]]:
    """Drive tool calls until the LLM emits the terminal plan.

    Every call is checked against the allowlist before dispatch, then
    runs through the same registry as the teaching flow. Results from
    get_weak_topics are kept as Evidence. The caller checks the plan
    against them and returns them as the proposal's justification.
    """
    evidence: list[Evidence] = []
    parsed = _parse_or_raise(response)
    while isinstance(parsed, ParsedToolCall):
        # Execute every call in the response before sending results
        # back. OpenAI-compatible APIs require all calls in one
        # assistant message to be answered together.
        results: list[ToolResult] = []
        for call in parsed.calls:
            if call.name not in _ALLOWED_TOOLS:
                raise PlannerServiceError(
                    f"Tool {call.name!r} is not available to the planner.",
                    kind="disallowed_tool",
                )
            try:
                output = await execute_tool_call(db, call, embedder)
            except ToolHandlerError as e:
                raise PlannerServiceError(
                    f"Tool handler {call.name!r} failed: {e.message}",
                    kind="tool_handler_failed",
                    cause=e,
                ) from e
            if call.name == "get_weak_topics":
                evidence.append(Evidence(tool=call.name, result=output.model_dump(mode="json")))
            results.append(
                ToolResult(call_id=call.id or call.name, content=output.model_dump_json())
            )

        try:
            response = await transport.send_tool_results(chat, results)
        except TransportError as e:
            raise PlannerServiceError(
                f"Transport failed sending tool results: {e.message}",
                kind="transport_failed",
                cause=e,
            ) from e

        parsed = _parse_or_raise(response)

    return parsed, evidence


def _parse_or_raise(response: TransportResponse) -> ParsedToolCall | ParsedPlan:
    """Translate a TransportResponse, wrapping parse failures uniformly."""
    try:
        return _response_to_parsed(response)
    except ParseError as e:
        raise PlannerServiceError(
            f"Parse failed on planner response: {e.message}",
            kind="parse_failed",
            cause=e,
        ) from e


def _response_to_parsed(response: TransportResponse) -> ParsedToolCall | ParsedPlan:
    """Translate a TransportResponse for the planner flow.

    Same shape as the diagnostic service's translation: native
    tool_calls take precedence (DeepSeek), otherwise the text parses
    through the planner grammar, a TOOL_CALL block or the terminal
    PLAN.
    """
    if response.tool_calls:
        calls = list(response.tool_calls)
        raw_text = json.dumps([c.model_dump(mode="json") for c in calls])
        return ParsedToolCall(calls=calls, raw_text=raw_text)
    return parse_plan_response(response.text)


async def _close_quietly(transport: LLMTransport[Any], chat: Any) -> None:
    """Close the chat, swallowing any error from the close itself.

    A failed close is not worth promoting over the original error
    being raised. Throwaway chats: leaking the chat handle is
    acceptable if close fails.
    """
    with contextlib.suppress(Exception):
        await transport.close(chat)


async def _check_plannable_state(db: DbSession) -> None:
    """Raise PlannerServiceError(kind="no_data") when no weak topics exist.

    Runs the same handler the LLM's tool call hits, with the widest
    net: min_attempts=1 so a single graded miss counts, sample_size=0
    because only existence matters here. An empty result means a
    planner chat could only produce an empty or invented plan, both
    of which the wire format rejects, so the chat never opens.
    """
    output = await get_weak_topics(db, GetWeakTopicsInput(min_attempts=1, sample_size=0))
    if not output.topics:
        raise PlannerServiceError(
            "No weak topics exist yet. The planner needs graded attempts "
            "with incorrect or partial verdicts to plan from.",
            kind="no_data",
        )


def _assert_plan_grounded(
    plan: Plan,
    evidence: list[Evidence],
) -> dict[str, WeakTopicInfo]:
    """Return evidenced weak topics after validating every plan target.

    Three checks: the plan has at least one step, every step is a
    mutate step, and every target path appears in a get_weak_topics
    evidence entry. A plan emitted without any tool call has empty
    evidence and fails here, so the call-first rule is structural.

    Runs before the orchestrator, so a bad plan dies with a clean
    error instead of mid-transaction. Existence against current
    database state stays with the strict mutate core inside the
    transaction.
    """
    grounded = _evidenced_weak_topics(evidence)
    if not plan.steps:
        raise PlannerServiceError("Plan has no steps.", kind="ungrounded")
    for index, step in enumerate(plan.steps):
        if not isinstance(step, MarkForRevisionStep):
            raise PlannerServiceError(
                f"Plan step {index} ({step.tool!r}) is not a mutate step. "
                f"Planner plans are mutate-only.",
                kind="ungrounded",
            )
        if step.args.path not in grounded:
            raise PlannerServiceError(
                f"Plan step {index} targets {step.args.path!r}, which is "
                f"not in the gathered evidence.",
                kind="ungrounded",
            )
    return grounded


def _evidenced_weak_topics(evidence: list[Evidence]) -> dict[str, WeakTopicInfo]:
    """Collect weak-topic rows from get_weak_topics evidence entries.

    Entries validate back through GetWeakTopicsOutput. On approve the
    evidence arrives from the client, so an entry that does not
    validate grounds nothing rather than being trusted.
    """
    topics: dict[str, WeakTopicInfo] = {}
    for entry in evidence:
        if entry.tool != "get_weak_topics":
            continue
        try:
            output = GetWeakTopicsOutput.model_validate(entry.result)
        except ValidationError:
            continue
        topics.update((topic.topic_path, topic) for topic in output.topics)
    return topics


async def _gather_specialist_evidence(
    *,
    db: DbSession,
    transport: LLMTransport[Any],
    embedder: Embedder,
    topic_path: str,
    weak_topic: WeakTopicInfo,
) -> Evidence:
    """Return one target's completed or failed specialist evidence.

    A specialist failure is data rather than a proposal failure, so
    the generator can emit specialist_finished and continue to later
    targets.
    """
    try:
        result = await gather_grounding(
            db=db,
            transport=transport,
            embedder=embedder,
            topic_path=topic_path,
            weak_topic=weak_topic,
        )
    except SpecialistServiceError as exc:
        failure = SpecialistFailure(
            topic_path=topic_path,
            error_kind=exc.kind,
            message=_SPECIALIST_UNAVAILABLE_MESSAGE,
        )
        outcome_payload = failure.model_dump(mode="json")
    else:
        outcome_payload = result.model_dump(mode="json")
    return Evidence(
        tool="retrieval_specialist",
        result=outcome_payload,
    )
