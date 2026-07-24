"""Agent proposal and approval HTTP routes.

The bounded planner exposes ordinary and streamed proposal routes.
Both produce a mutate-only plan with its grounding evidence. Approve
receives that pair back, re-checks groundedness, and executes the
mutations atomically under the orchestrator's transaction boundary.

The prefix is /agent rather than /plan because the assistant surface
grows beyond planning (specialists, evidence panel); this module is
its home.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, HTTPException, status
from fastapi.sse import EventSourceResponse, ServerSentEvent

from app.api.deps import (
    AgentErrorRecorderDep,
    DbSession,
    DeepseekTransportDep,
    EmbedderDep,
    PlaywrightTransportDep,
    pick_transport,
)
from app.schemas.agent_api import (
    AgentApproveRequest,
    AgentProposeRequest,
    AgentProposeResponse,
)
from app.services.agent_orchestrator import AgentOrchestratorError
from app.services.agent_planner import (
    PlannerServiceError,
    approve_plan,
    propose_plan,
    stream_plan_proposal,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

router = APIRouter(prefix="/agent", tags=["agent"])


def _map_planner_error(exc: PlannerServiceError) -> HTTPException:
    """Translate a planner-service error to an HTTP exception.

    Mirrors diagnose.py's _map_diagnostic_error: dispatch on the
    kind discriminator, never on message substrings. no_data means
    the request is well-formed but there is nothing to plan against:
    422. transport_failed, parse_failed, disallowed_tool, and
    ungrounded all mean the upstream LLM broke its contract: 502.
    tool_handler_failed is a backend fault, and unexpected is the
    catch-all: 500.
    """
    if exc.kind == "no_data":
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=exc.message)
    if exc.kind in ("transport_failed", "parse_failed", "disallowed_tool", "ungrounded"):
        return HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.message)
    return HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=exc.message)


@router.post("/propose", response_model=AgentProposeResponse)
async def propose(
    body: AgentProposeRequest,
    db: DbSession,
    playwright: PlaywrightTransportDep,
    deepseek: DeepseekTransportDep,
    embedder: EmbedderDep,
) -> AgentProposeResponse:
    """Run the planning flow and return the proposed plan.

    Nothing mutates here: the plan executes only when the client
    posts it back to /agent/approve. The planning chat is throwaway
    and closed before this handler returns.
    """
    transport = pick_transport(body.transport_kind, playwright, deepseek)
    try:
        proposal = await propose_plan(
            db=db,
            transport=transport,
            embedder=embedder,
            transport_kind=body.transport_kind,
        )
    except PlannerServiceError as exc:
        raise _map_planner_error(exc) from exc

    return AgentProposeResponse(plan=proposal.plan, evidence=proposal.evidence)


@router.post("/propose/stream", response_class=EventSourceResponse)
async def propose_stream(
    body: AgentProposeRequest,
    db: DbSession,
    playwright: PlaywrightTransportDep,
    deepseek: DeepseekTransportDep,
    embedder: EmbedderDep,
) -> AsyncIterator[ServerSentEvent]:
    """Stream planning progress as named server-sent events.

    Request validation still uses ordinary HTTP status codes. Once
    headers are sent, application failures arrive as the typed
    proposal_failed terminal event.
    """
    transport = pick_transport(body.transport_kind, playwright, deepseek)
    async for event in stream_plan_proposal(
        db=db,
        transport=transport,
        embedder=embedder,
        transport_kind=body.transport_kind,
    ):
        yield ServerSentEvent(
            event=event.kind,
            data=event,
        )


@router.post("/approve", status_code=status.HTTP_204_NO_CONTENT)
async def approve(
    body: AgentApproveRequest,
    db: DbSession,
    recorder: AgentErrorRecorderDep,
) -> None:
    """Execute an approved plan's mutations, all-or-nothing.

    Returns 204: the client already holds the plan it submitted, so
    there is nothing new to say on success. An orchestrator failure
    means the transaction rolled back and the error was recorded on
    an independent session; the plan left no partial writes.
    """
    try:
        await approve_plan(
            db=db,
            recorder=recorder,
            plan=body.plan,
            evidence=body.evidence,
        )
    except PlannerServiceError as exc:
        raise _map_planner_error(exc) from exc
    except AgentOrchestratorError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=exc.message) from exc
