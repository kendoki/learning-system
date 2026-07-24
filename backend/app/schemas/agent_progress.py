"""Progress event schemas for streamed agent proposals.

Events mark orchestration call boundaries rather than provider tokens.
Every stream ends with exactly one ready or failed terminal event.
"""

from __future__ import annotations

from typing import Annotated, Literal

# Pydantic v2 resolves field annotations at runtime. These service
# models must therefore remain runtime imports.
from app.schemas.agent_plan import (  # noqa: TC002
    Evidence,
    Plan,
    PlanProposal,
)
from pydantic import BaseModel, ConfigDict, Field

type PlannerErrorKind = Literal[
    "transport_failed",
    "parse_failed",
    "tool_handler_failed",
    "disallowed_tool",
    "no_data",
    "ungrounded",
    "unexpected",
]


class PlanningStarted(BaseModel):
    """The proposal flow has started its planner stage."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["planning_started"] = "planning_started"


class PlanReady(BaseModel):
    """The grounded plan and its planner evidence are available."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["plan_ready"] = "plan_ready"
    plan: Plan
    evidence: list[Evidence]


class SpecialistStarted(BaseModel):
    """One target's retrieval specialist has started."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["specialist_started"] = "specialist_started"
    topic_path: str
    position: int = Field(ge=1)
    total: int = Field(ge=1)


class SpecialistFinished(BaseModel):
    """One target's completed or failed specialist evidence is available."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["specialist_finished"] = "specialist_finished"
    topic_path: str
    position: int = Field(ge=1)
    total: int = Field(ge=1)
    evidence: Evidence


class ProposalReady(BaseModel):
    """The complete grounded proposal is ready for approval."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["proposal_ready"] = "proposal_ready"
    proposal: PlanProposal


class ProposalFailed(BaseModel):
    """Proposal generation ended with a typed application failure."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["proposal_failed"] = "proposal_failed"
    error_kind: PlannerErrorKind
    message: str = Field(min_length=1)


type ProposalEvent = Annotated[
    PlanningStarted
    | PlanReady
    | SpecialistStarted
    | SpecialistFinished
    | ProposalReady
    | ProposalFailed,
    Field(discriminator="kind"),
]
