# History — what landed, and when

Append-only, dated records of finished work. They are not maintained: an entry says what was true on
its date, and later changes get new entries rather than edits. For the CURRENT state read
[README.md](../../README.md), the one living document. Until 2026-11-22 the living state was split
over several files (TESTPLAN.md, THREATMODEL.md, BACKLOG.md, COMPATIBILITY.md, deploy/DEPLOY.md,
docs/architecture/, docs/decisions.md, docs/test-setup.md); the entries below still name them, and
their links now open the README section each was merged into.

| File | What it records |
|---|---|
| [step6-hardening.md](step6-hardening.md) | step 6 — server room hardening, per-pairing role, the lobby, TURN + strict Max privacy, the cross-browser pass, the nginx deploy |
| [followups-and-ops.md](followups-and-ops.md) | small security / correctness follow-ups, ops and housekeeping, landed nice-to-haves, the 2026-10-03 repository split |
| [reconnect.md](reconnect.md) | the codeless reconnect (2026-09-25) and the by-code design it replaced |
| [ux-fixes.md](ux-fixes.md) | the UX bugs found in the manual and real-device passes, and their fixes |
| [security-audits.md](security-audits.md) | the internal security audit passes and what each found |
| [pre-launch.md](pre-launch.md) | what came out of the 2026-10-03 pre-launch review, as it lands |

The real-device test runs are a separate record: [docs/test-runs/](../test-runs/README.md).
