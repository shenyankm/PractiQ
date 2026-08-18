"""Membership tier ranking and trial-aware effective-tier computation."""

from datetime import datetime, timezone

TIER_RANK = {'free': 0, 'pro': 1, 'organization': 2}


def effective_membership(
    membership: str, trial_ends_at: datetime | None, now: datetime | None = None
) -> str:
    """Resolve the tier actually in force: paid tier wins, else an active trial grants pro."""
    if membership in ('pro', 'organization'):
        return membership
    if trial_ends_at is not None:
        now = now or datetime.now(timezone.utc)
        ends = trial_ends_at if trial_ends_at.tzinfo else trial_ends_at.replace(tzinfo=timezone.utc)
        if ends > now:
            return 'pro'
    return 'free'


def tier_at_least(membership: str, minimum: str) -> bool:
    return TIER_RANK.get(membership, 0) >= TIER_RANK[minimum]
