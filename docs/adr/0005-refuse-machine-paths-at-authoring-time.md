# 0005. Refuse machine paths at authoring time, not in the report

- **Status:** Accepted
- **Date:** 2026-09-24
- **Supersedes:** nothing. Constrains the report layer introduced in ADR 0004.

## Question

`eval-cli` renders author-supplied values — a suite name, scenario identifiers,
slicing tags — into a Markdown comment posted on a pull request, and into a
committed JSON artifact. A CI checkout path routinely contains the account the
job runs as. Where should the control that stops such a path reaching published
output live?

## Context

The obvious place is the renderer: scan each value as it is written, redact
anything that looks like a machine path. That is what was built first, and it is
what this ADR exists to argue against.

The difficulty is that "looks like a machine path" is not decidable in free text.
`/home/ci-user/repo` is a disclosure. `/home/dashboard` is a plausible REST
route. `/api/v1/refund` is a legitimate identifier. `/media/upload` could be
either. The same characters are a leak in one author's value and a name in
another's, and nothing in the string distinguishes them.

## Options considered

1. **Detect and redact in the report.** A pattern at the rendering boundary.
   · Pros: one place; no change to the engine; no effect on what loads.
   · Cons: see the evidence below.

2. **Refuse at authoring time.** The loader rejects a suite whose name or
   identifiers contain an unmistakable machine path, naming the value and telling
   the author to rename it.
   · Pros: the constraint is real at exactly one moment — a human wrote the value
   into a committed file and can change it.
   · Cons: it is a breaking change for any suite already carrying one, and it
   cannot cover values that arrive from elsewhere, such as a baseline artifact
   produced by an earlier run.

3. **Both, with the authoring-time check as the control and the report as a
   narrow safety net.**

## Evidence

The report-side pattern was written five times. Each version was correct about
the case that prompted it and blind to the next:

| Version | What it fixed | What it then missed |
|---|---|---|
| Whitespace anchor | paths after a space | `'/home/ci-user/repo'` — quote-delimited |
| Root allowlist | listed system roots | `/workspace/ci-user/repo` — unlisted |
| Broadened | the unlisted roots | **destroyed `/api/v1/refund`** |
| Doubled-slash handling | `//home/...` | `checkout path:/home/...` — after a label |
| `:` excluded to protect `https://` | URLs | `path:///home/ci-user/repo` |

By the fifth version it was **failing in both directions at once** — mangling
`/api/v1/refund` and `/orders/{id}/refund` into unreadable aliases while still
admitting a labelled machine path. That combination is the signature of an
under-constrained problem rather than a badly written rule.

Two further findings settled it. First, the surface was wider than the report:
`Slicing.Tags` reached the **committed JSON artifact** unredacted, and a
**baseline read from disk** re-introduced identifiers from a previous run that
never passed the loader again. A renderer-side control covers one of three
published surfaces. Second, a filter over prose cannot be made reliable either —
a backstop that applied identifier tokenisation to deserializer messages missed a
quoted literal, because prose tokenises differently from an identifier.

The decisive asymmetry: at authoring time the value is in a committed file with a
human attached to it, so refusing costs one rename. In the report the value is
already in flight, every consumer pays the filter's cost forever, and a false
positive silently destroys an identifier a reviewer needed.

## Decision

**The control is refusal at suite load and at artifact read-back.** A suite name,
scenario id, or slicing tag key or value that starts with an unmistakable machine
path — drive-prefixed, UNC, or a rooted system path from a closed allowlist — is
refused, naming the field and position. Artifact read-back is guarded at
`CanonicalJson.DeserializeSuiteResult` rather than at any one caller, because a
guard one call away from being bypassed is not a guard.

The boundary is **start-anchored** and **case-sensitive**. Start-anchored because
matching anywhere refuses `/api/v1/media/upload`. Case-sensitive because macOS is
`/Users` and the canonical REST route is `/users/{id}/orders`, and no
case-insensitive rule keeps both. A leading HTTP-method token from a closed set
is exempt so `GET /home/dashboard` loads; that exemption necessarily admits
`GET /home/ci-user/repo`, and the concession is documented rather than pretended
away.

**The report keeps a narrow safety net, and its holes are published.** It catches
paths under listed roots, drive prefixes and UNC hosts. It does not catch paths
under unlisted roots, relative or tilde paths, forward-slash UNC, or a drive
letter without a separator. The README names each one. A net that claims to be a
control is worse than either.

The net is deliberately **stricter** than the control in one place: it does not
mirror the method exemption, because a net that copies the control's exemptions
inherits its blind spots. The costs are asymmetric — a false positive in the net
aliases one heading, a false positive in the control stops the work.

Rules governing text of unknown provenance and rules governing OS-produced paths
are **kept separate and documented as such**. A caller label is scanned for both
separators and never handed to `Path`, whose `GetFileName` ignores backslashes on
Unix. A resolved path uses native separators, because on Unix a backslash is a
legal filename character.

## Consequences

- A suite carrying a machine path in an identifier **no longer loads**. There
  were no committed suite files when this landed, so nothing broke; a consumer
  with one must rename it.
- `SuiteLoadResult.Suite` is now null whenever any message is an error, matching
  its documentation for the first time.
- Diagnostics are **terser**. Findings carry a code, a field and a position and
  never forward exception prose, so the JSON path that used to say which property
  failed is gone. A typed converter exception carrying an engine-composed reason
  would recover it without a filter; that is not built.
- Two mutants survive and are named in the code: a both-separator revert
  observable only on Unix, and a fail-closed fallback reported unreachable on its
  third measurement after being reachable on the first two.
- ~~Three CLI-owned messages still print an absolute path deliberately.~~
  **Superseded 2026-09-25.** Adding the trend command showed the reasoning was
  wrong. `PathGuard` had **nine** messages printing a canonical absolute path, not
  three, and the new command reached all of them — so "the tool printing it once,
  deliberately, under its own policy" was a description of three sites somebody had
  looked at rather than a policy. All nine now state their path relative to
  `--root`, and no engine exception prose is forwarded.

  One case genuinely cannot: a refusal that precedes any root, where `--root`
  itself is what failed to resolve. There is no boundary yet, so there is nothing
  to be relative to. Those messages apply the published net to the value **as
  supplied** — strictly less than the caller typed, never more — and inherit the
  net's published holes rather than pretending to cover them.

  **The general lesson is worth more than the fix.** A documented trade-off is
  scoped to the surfaces that existed when it was made. The `GET` exemption above
  was reasoned about for the Markdown document, where the net is a second layer; a
  later command printed scenario identifiers to **stderr**, where it is not. The
  concession did not change — the surface it applied to did. When a new output
  channel is added, every §V trade-off in this ADR needs re-reading rather than
  inheriting.
