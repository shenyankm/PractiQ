# Issue and PR bot rollout acceptance

This temporary documentation change exercises the production bot workflows introduced by PR #286.

- Opening a maintainer test issue should preserve its question label and add an AI-assessed area and priority through the dedicated issue App.
- Opening this PR should trigger one bounded model classification through the dedicated PR App.
- Clean completed current-head Codex code/security review evidence and successful required CI should let the PR App submit one formal approval.
- The approved PR should remain open because repository auto-merge is disabled.
- Closing this temporary PR should trigger trusted-main revalidation and withdraw its bot approval.

These are acceptance criteria, not recorded results. The maintainer will record the actual Actions run IDs, label actors, review state, and closure outcome separately, then close this PR without merging it.
