# System Patterns — Forge

Conventions that have earned their place. When a pattern here conflicts with
`.github/instructions/constitution.instructions.md`, **the constitution wins** and this file
is wrong — fix it.

## Pattern: rigor keyed to location, not to intent

**Problem.** A workshop repo needs both fast experimentation and a real bar on code that is
depended upon. Deciding rigor per-request means relitigating it every time, and the
argument is always won by whoever is in a hurry.

**Pattern.** Bind rigor to the **path**. `services/**` and `libs/**` are Tier 1;
`apps/**`, `tools/**`, `scripts/**` are Tier 2; `spike/**` is Tier 0. A change spanning
tiers takes the highest. The tier is a fact about the file, not a claim about the task.

**Consequence.** The only decision left is *where does this live*, which gets made once, at
`scaffold-domain` time, with the stakes visible.

## Pattern: agents parameterized by domain

**Problem.** A fixed builder/reviewer pair per project works when the project set is fixed.
Forge's is open-ended — a new pair per domain means an agent-file explosion and constant
drift between them.

**Pattern.** Three generic pairs (`app`, `service`, `tooling`) resolve their target from a
**domain id** passed by the orchestrator, looked up in `.github/domains.yaml`. Each pair is
still hard-scoped to exactly **one** domain per task.

**Escape hatch.** When a domain grows rules the generic agent cannot express, mint a
dedicated pair with `scaffold-domain -WithAgents` and repoint the registry row.

## Pattern: the registry as single source of truth

Every path, project file, build command, test command, tier, and agent assignment lives in
`.github/domains.yaml`. Agents **resolve** from it and never guess.

An unregistered domain is a **blocking error**, not an invitation to improvise. This is what
makes the parameterized-agent pattern safe: a builder that cannot resolve its domain stops
rather than inventing a folder layout that nobody else will expect.

## Pattern: spikes graduate by rewrite

**Problem.** The natural lifecycle of a successful experiment is "it works, ship it" —
which silently promotes code that skipped every gate into a position of dependency.

**Pattern.** A spike answers **one falsifiable question** and is registered at Tier 0.
When the question is answered, it either **graduates** — the real implementation is written
fresh in a real root under its proper tier — or **retires**, with the finding preserved in
an ADR. Moving the folder is explicitly *not* graduation.

**Enforcement.** Nothing outside `spike/` may reference anything inside it (§XI), and spikes
are excluded from `Forge.sln` so they cannot silently break the repo build.

## Pattern: reviewer independence by model family

Reviewers are strictly read-only (no `edit`, no `shell`) and run on a **different model
family** from the builder: builders on Claude, reviewers on GPT, each at the
highest version available. The orchestrator pins the **family** and passes the resolved
model explicitly on every dispatch. Relying on a default risks collapsing both roles into
one family, and then the review is just the builder agreeing with itself. A version pin
was tried first, and it drifted: by 2026-09-28 six documents named models two versions
behind the constitution.

Both roles report their model, and the reviewer fails the verdict if independence cannot be
demonstrated.

## Pattern: structured reports as the interface

Builders and reviewers communicate through **fixed-shape reports**, not prose. A builder
emits `CHANGED FILES` / `TIER` / `BUILD` / `TESTS` / `TEST-FIRST-EVIDENCE` /
`BUILDER-MODEL` / `CONSTITUTION-CHECK`; a reviewer emits `VERDICT` / `FINDINGS` with
`file:line` plus a constitution citation.

This makes the loop **gateable**: the orchestrator can mechanically refuse to advance on
`BUILD: fail` or a missing `TEST-FIRST-EVIDENCE`, without interpreting narrative.

### Forward the blocks verbatim — never paraphrase them

The orchestrator assembles what the reviewer sees, which makes it the one role nobody
reviews. **`PRE-EDIT-APPROVAL`, `BUILDER-MODEL`, `TEST-FIRST-EVIDENCE` and `MUTATION` go
across verbatim**, inside a fenced block, not summarised into a briefing.

This failed twice in one session, both times the same way: a narrative review brief that
quoted the interesting sentence and dropped the record. The reviewer correctly returned
`VERDICT: FAIL` on §VI and §VIII both times, because the artifact it was handed genuinely
lacked them — and it could not verify a claim asserted in place of evidence.

The rule the whole repo runs on is that **a claim is not evidence until something can fail
on it.** An orchestrator's summary of a gate is a claim. The block is the evidence.

**Verbatim is necessary and not sufficient — check the block is *there*.** After the two
paraphrase failures above, the orchestrator forwarded verbatim every time and was failed a
third time anyway: it forwarded, unaltered, a builder report that contained **no
`BUILDER-MODEL` and no `TEST-FIRST-EVIDENCE` at all**. The prose carried the substance —
pre-fix counts, observed exit codes, a discrimination proof — but §VIII fails on the
missing field, not on missing substance, and the reviewer was right to refuse.

The fix for fidelity did nothing about omission, and nobody looked again. This is the
under-application pattern above, in the orchestrator's own seat: a mechanism introduced,
applied to one half of the problem, and trusted thereafter. **Gate on presence before
sending, not on the intention to forward.**

## Pattern: no finding without a citation

Every review finding cites a `file:line` **and** a constitution section. A finding that
cannot be located is not raised. This kills the two failure modes of AI review — vague
stylistic grumbling, and confident hallucinated problems.

## Pattern: settle disagreements with a measurement, not an argument

**Problem.** A builder and a reviewer can both produce a plausible argument about whether
a guard fires, a test covers something, or a statistic is calibrated. Plausible arguments
are frequently wrong, and two of them cost a round each.

**Practice.** When a claim is contested, produce a number:

- **Run the mutant**, don't reason about the branch. A guard reported unreachable was
  reachable twice before a third measurement settled it. A "redundant" backstop turned out
  to be the only thing covering a duplicate-key path nobody had identified.
- **Simulate the statistic**, don't trust the derivation. A paired bootstrap returned
  `p=0.0001` where the true rejection rate was 50%; the first remedy fixed `n=2` and still
  failed at `n=6`. Only a type-I error simulation caught either.
- **Read the real output**, don't inspect the code. Three disclosure leaks were found that
  way and none by reading — including one where a finding withheld the value it was warned
  about and printed an unsanitised one in the same sentence.
- **Probe the primitive.** `Path.GetFileName` ignores backslashes on Unix.
  `FileSystemName.MatchesSimpleExpression` treats `\` as an escape. `FileSystemInfo.LinkTarget`
  never throws on Windows. All three were found by constructing the case.

## Pattern: the defect that keeps coming back

Roughly twenty review findings across the eval harness were one shape: **evidence from one
context treated as though it came from another.** Its commonest form is **a refusal
rendering as an absence** — a guard that fires only in the total case, a count that reads
zero when nothing was comparable, a truncated section that looks empty.

Three things reliably surface it:

1. **Enumerate, don't sample.** Fixing where a finding points leaves the next instance. The
   T15d surface was five sites by inspection and twelve by enumeration.
2. **Verify the property, not the reported case.** A builder reports the case it tested; the
   predicate usually covers less.
3. **Distrust green.** A passing test is not evidence until you know why it passes. Repeated
   causes here: testing the helper rather than the path production takes, a lock that did not
   take, a relative path that echoed relative, a conditional skip keyed on the assertion's
   own subject.

   **Any test asserting a non-zero exit must also assert the message**, or it only proves
   that *something* went wrong. A "must refuse" test passes for free when the subject
   refuses for an unrelated reason — one suite had six failures and a single pass, and the
   pass was every case exiting non-zero on a missing dependency rather than on the guard
   under test. `assert.notEqual(code, OK)` is the same defect in smaller type; a sweep to
   tighten those was claimed complete twice and was incomplete both times, and only a
   by-hand count closed it.

And a caution on fixes: `required`, a name, and a convention all look structural in a diff
and are not. Four "structural" guarantees in this work still compiled with a wrong value.
The ones that held were enforced by the compiler — a count derived from an immutable
snapshot, a type with no display-string constructor, a method with no string overload.

## Pattern: sweep from the sinks, not from the sources

A sweep driven by *"where did I use this?"* does not terminate. A sweep driven by *"what
is the complete set of things that must be covered?"* does.

Measured, repeatedly, in this repo:

- Path disclosures: three source-first passes found 16, then 22, then 25 sites and kept
  missing by scope. One sink-first pass over six sinks terminated immediately.
- Weak assertions in SizzleCraft: two source-first sweeps, both claimed complete, both
  incomplete — the second failed because a regex was keyed to one indentation and the
  count was never re-checked. A by-hand count closed it.
- Path resolvers: `assertDistinctDestinations` and `resolveInternalArtifact` were each
  introduced and then applied to one collection, leaving the rest reachable from the
  moment the first half was written.

The builder's own diagnosis, which a reviewer then confirmed from the diff, is the best
statement of it: *"some of these layers were visible earlier than I saw them."* The
sequencing was not inherent to the defect; it was an artifact of sweeping by recall.

**So: enumerate the sinks.** Every path written, every option rendered, every message
emitted. That set is finite and readable. The set of places you remember touching is
neither.

**Corollary — the newest mechanism is the least applied.** The thing introduced this round
is the thing most likely to be sitting at one call site. Check it before the older ones.

## The unifying frame: a distinction that exists in the author's head but not in the code

Four defect shapes recurred across every domain in this repo's audit, and a consuming
project named what they share. Each one is **a distinction the author was holding
mentally and never wrote down**:

| Shape | The unwritten distinction |
|---|---|
| A check that **cannot fail** | "validation ran" vs "validation reported" — `ajv.errors` was always null |
| A check that **cannot pass** | "monotonic" vs "adjacent" — every correct timeline failed |
| A guard **keyed on a symptom** | "the scene is broken" vs "this particular function is missing" |
| An **in-band sentinel** | "no file" vs "a file containing nothing" |

The last is worth stating as a rule of its own: **`null` is a poor sentinel in a function
whose purpose is distinguishing states, because it is also a legal value of the thing being
read.** Any in-band sentinel eventually collides with real data. A function that
distinguishes *absent / unreadable / malformed / present* wants a **tagged result**, not a
magic value — the fix that reserved `null` for `ENOENT` works, but only because it also
refuses every other way `null` could arrive.

**The remedy that keeps working is the same one in every case: make the invalid state
unrepresentable rather than guarded against.** Two instances landed the same afternoon —

- cleanup owned by a **handle that only exists when the open succeeded**, so a refusal
  cannot delete what it refused. A flag is something a future edit can forget to check; a
  handle that does not exist cannot be misused.
- a mutant test fixture **derived from the working one**, which throws if the method it
  removes is absent, so a reformat cannot silently produce an unmodified copy.

Contrast with what did not hold: four "structural" guarantees earlier in the same work
still compiled with a wrong value, because they were conventions — a `required` keyword, a
shared name, a matching comment. The test is not whether the guarantee is stated. It is
whether violating it fails to compile, or fails a test that cannot pass for another reason.


## Pattern: compare the strength of the evidence against the strength of the claim

The single check that would have prevented most of this repo's audit. A property you can
*verify* is not automatically the property you are *asserting*, and the gap is invisible
because the two are correlated in the ordinary case.

One feature produced five levels of it before the answer became "don't build this":

| Evidence | Actually proves | Claim it was carrying |
|---|---|---|
| `endMs - startMs === audio.durationMs` | the windows came from *some* audio | this calibration measures *this* text |
| `{words, chars, clipMs}` match | a summary matched | the narration is unchanged |
| `timingHash` verifies | nobody edited the file after sealing | the voice stage produced it |
| normalised word record matches | the service spoke *roughly* this | it spoke *exactly* this |
| `evidence` field written | the distinction was recorded | the distinction was *checked* |

Each gate was real. Each was one inferential step short. The last is the sharpest: the
field whose entire purpose was recording whether a human confirmed was written correctly
and **never read by the predicate** — the distinction lived in the artifact and not in the
decision.

**And the impossibility argument overreached too.** The conclusion "no artefact retains the
exact narration" was drawn from an enumeration of what *one stage* writes, and stated about
*every artefact in the project*. A different stage did embed it. The conclusion survived
only because it was over-determined. The builder's own diagnosis is the general form:

> The scope of the evidence was six files; the scope of the claim was the whole domain.

**When the evidence cannot reach the claim, the honest output is to refuse rather than
certify.** A tool was built to promote "unproven" lineage to "proven", found to mint false
proof on a punctuation edit, and **withdrawn** — with the impossibility written into the
message that would otherwise prompt someone to rebuild it. Refusing to certify is always
available and always honest.

## Technique: a red that is *impossible* is a stronger signal than a red that is absent

A builder was dispatched to fix five audited defects and could not write a failing test for
any of them. The defects were real — on a **different branch**. The file it had been given
did not contain the feature under repair.

It stopped rather than authoring the feature in order to fix it, and the reasoning is worth
keeping: a pre-fix red would have been red against code written minutes earlier, and a
builder that wrote its test *after* its fix would have shipped a confident, green, entirely
fictional repair.

This is not what failing-test-first is usually argued for, and it is a better argument than
the usual one. **The test's inability to fail was the signal.**

**Corollary — the danger of a semantic merge.** Two differently-shaped implementations of the
same safety mechanism do not conflict loudly; git resolves by text and neither side is wrong
at any line. One side silently wins, and in a guard that is how the guarded defect returns.
A semantic conflict in a safety mechanism is worse than a textual one, because *the merge
succeeding* is what causes the harm.

## Pattern: recognition is not coverage

A builder found a vacuous assertion in its own test — one that could never reach the code it
claimed to check — reported it unprompted, and in the same round left its exact twin two
files away, in a test it was actively editing. Its own formulation:

> **Catching a pattern once does not mean I swept for it.**

The same round it named that, it wrote an over-broad assertion in the very test fixing the
finding about over-claiming. Scoping a check to the nearest available thing rather than the
thing the property is about is the same error whether it passes or fails — *"an over-broad
assertion that happens to fail is luckier than one that happens to pass."*

So naming a defect class does not close it. Only a sweep does, and the sweep has to be
mechanical: enumerate the sinks, not the places you remember touching.


## Pattern: a permissive default is worse than no guard

`code` mode refuses to render source data matching a project's `noGoPatterns`. A missing keywas treated as "no patterns" — and the only real consuming project had never set one. So for
the only consumer that existed, a documented, named, tested frame-boundary guarantee
**guaranteed nothing**.

Its author's formulation is the durable one: **a default that makes a guard permissive is
worse than no guard, because it produces the *evidence* of protection — a named config key,
a passing test, a documented guarantee — with none of the protection.** No guard at all is
at least honest about its absence.

**Fail closed on absence for anything whose job is refusing.** Here: a missing key is
refused, and `[]` is the explicit opt-out. The project least likely to have reviewed its
source data is exactly the one that never configured the guard, so absence must not read as
permission.

**And the test could never have caught it, because the test supplied its own patterns.**
That is the sharper half:

> A test with its own fixture proves the mechanism works; it says nothing about whether it
> is switched on.

Every guard with configurable strictness needs a test for the **unconfigured** case — the
one a real project will actually be in. Otherwise the suite proves the guard functions and
is silent about whether it runs.


## Property: a fingerprint over the input is separable; over the output it is not

Slice 2 made budget suppression require proof of lineage — a hash recorded when the audiowas measured. The consuming project flagged the hazard before running it: **the stage that
records the proof also regenerates the inputs.** Re-running `voice` to satisfy a checker
rewrites the audio a 25-minute render was already encoded from.

It resolved without a re-render for one reason: **`textHash` hashes the narration text, not
the audio.** That makes the proof separable from the artifact, so the re-run calibration and
timeline could be kept while the original audio files were restored. Lineage proven,
deliverable bit-reproducible.

Had it hashed the audio, there would have been no such move — the choice would have been
between proven lineage and a reproducible deliverable, and the render cost would have
decided it.

So, when adding a provenance check: **hash the input that determines the output, not the
output.** The input is usually stable, cheap, and already in hand; the output is the
expensive thing you are trying to protect.

**Related caution:** a command that records proof is rarely read-only. *"Re-run voice to
record a fingerprint"* reads like a verification step and is a regeneration. Say so where
the instruction appears.

## Pattern: a measurement generalised one step past what it supports

The same project made this error twice, in opposite directions, and named it better than
anyone reviewing it could have:

- **Identity read as meaning.** "74% deduplicated" came from comparing consecutive frame
  byte-lengths. A deterministic renderer produces byte-identical frames at full cost; the
  true hold rate was 0% in the body. Byte-identity is not dedup.
- **Meaning read as identity.** "TTS determinism confirmed across 3+ runs" was measured on
  **timings** and stated about **bytes**. Re-running unchanged narration produced identical
  `durationMs`, identical clip durations, identical byte *lengths* — and **different content
  hashes for 5 of 8 segments**. Neural synthesis varies sub-perceptually between runs while
  landing on the same frame count.

Both were real measurements. Both were reported one inferential step further than the
evidence reached, and the step was invisible because the measured thing and the claimed
thing are correlated in the ordinary case.

**So state what was measured, not what it implies.** "Identical durations across 3 runs" is
a finding. "TTS is deterministic" is a theory about why, and it was wrong in a way that
would have silently broken any cache keyed on audio content.


## Pattern: the fix for a defect class is where the next instance appears

Three states — **absent**, **unreadable**, **malformed** — were collapsed into one, and the
one they collapsed into was the benign one: a malformed `clips.json` read as "no approved
clips", so a video shipped without its footage and nobody was told.

The fix separated all three. It introduced `readOptionalEngineJson`, which returns `null`
for an absent file **and** for a present file containing valid JSON `null` — and the caller
maps either to `{}`. A present file can therefore still suppress requested content and exit
0, which is the original defect, reachable through the new code written to remove it.

The builder was not unaware of the class. It was **actively fixing it**, in that function,
in that round. The ambiguity survived because `null` was the natural return value and the
caller's `?? {}` made it look handled.

So: **after fixing an instance, audit the fix itself for the class before moving on.** New
code written under a fresh understanding of a defect feels immune and is not. The same
round also reproduced a known false-green pattern inside the very tests written to close
it — caught only because an adjacent test failed inexplicably.

Related sentinel rule: a value that means both *"nothing here"* and *"something here whose
value is nothing"* is not a sentinel, it is a collision. Reserve the sentinel for one
meaning and reject the other explicitly.

**Sharper variant — a guard keyed on a symptom expires when the symptom does.** One
fixture took four rounds, and the third was this: a probe recorded page errors but examined
them *only when a particular function was undefined*. That condition was true while the
stub was completely broken, which is how the stub defect was found in the first place.
Fixing the stub made the function defined, the precondition stopped holding, the recorded
error was never read, and two tests went green against a scene that still threw on
initialisation. **The fix disarmed the check that had caught the bug.**

So when a guard's condition refers to the broken state rather than to the property being
guarded, fixing the break silently retires the guard. Write the condition against the
invariant — *any page error means the scene is not operable* — not against the symptom that
happened to be present when you wrote it.

None of these four rounds was carelessness: each defect was invisible until the layer
beneath it was fixed, and the builder found two of the three itself by following evidence
rather than expectation. The generalisable part is the ordering, not the vigilance.


## Pattern: an inconsistent convention is worse than a uniformly wrong one

Five `SIZZLECRAFT_*` knobs; three read the environment first and override as documented,two read config first so the environment variable is unreachable in any real project — a
fallback wearing an override's name. Found by a consumer whose half-fps draft silently
rendered at 30.

The defect is not the inversion. **It is that the two knobs which silently do nothing are
indistinguishable from the three that work**, and there is no stated rule, so the next knob
added is a coin flip. The consumer put it best: *three-out-of-five is exactly the ratio that
makes copying a neighbour feel safe.*

A uniformly wrong rule gets found and fixed once. An inconsistent one recruits every future
author into perpetuating whichever half they happened to read, and each of them has
local evidence that they were right.

So the remedy is never "fix the odd one out". **State the rule where the next author will
read it, make every instance obey it, and add a test that fails when a new instance does
not.** A rule that is written but not enforceable decays back to precedent-by-proximity.

The same hazard in miniature: two sibling files used `??` and `||` for the same knob.
Neither is wrong locally, and that is precisely why it survived.

**Corollary for measurement:** a figure obtained through a knob that may not move is not a
figure. A worker-cap sweep of 6/10/14 came back suspiciously flat, and the right response
was to verify the knob reached the pool before trusting or discarding the result. It did;
the measurement stood. Suspecting the instrument is cheap compared to carrying a false
number.


## Pattern: a finding not carried into the dispatch does not exist

Three defects in one file were reported by a consuming project, triaged, and recorded in a
merge plan with a decision on each. The next round then rewrote **313 lines of that same
file** without being told about any of them — because the plan lived in the orchestrator's
notes and the brief did not repeat it. Two of the three survived the rewrite, and one was
**pinned by a new test asserting the defective behaviour**.

The orchestrator is the only role nobody reviews, and its failures are all of this shape:
something known, not transmitted. Twice it was a report block paraphrased; once it was a
block never checked for presence; here it was a triage decision that never reached the
agent who could act on it.

**The dispatch is the artifact. Notes are not.** Before sending a brief, re-read every open
finding for the files it touches and put them in the brief, even when you are sure you will
remember.

**Corollary — a test that pins a defect is worse than no test.** It converts the defect
into a requirement, and makes the correct fix arrive as a failing build. Whoever fixes it
has to argue past your test first, and a less careful consumer would simply have conformed
to it.

**The two failures need different remedies, and the consumer who hit both insisted on
separating them.** A finding missing from a brief simply does not get fixed — the remedy is
a dispatch checklist. A test asserting the wrong behaviour actively *obstructs* the fix —
the remedy is that **a test written to pin behaviour must cite why that behaviour is
correct.** A pinning test with no stated justification is indistinguishable from a pinned
defect, and the second costs far more than the first.

## Technique: identical output across inputs that should differ is a signal

Contributed by the first consuming project, and it earned its place twice in one week from
opposite directions:

- **As a symptom.** Four preview frames rendered at four different timestamps came back
  byte-identical. The segment was rendering **completely blank** — a wrapper carried the
  "hidden until revealed" class, and the reveal trigger targeted a *field*, which cannot
  reveal its own hidden ancestor. Every trigger resolved, animated, and reported success
  against an invisible element. Nothing errored.
- **As the thing being measured.** A "74% deduplicated" figure came from comparing
  consecutive frame byte-lengths. A deterministic renderer produces byte-identical frames
  at full cost; the true hold rate was 0% in the body. Only an NTFS hardlink count proves
  a frame was actually held.

Same tell, opposite polarity, correct to investigate both times.

It also extends the session's dominant defect one step: a **render** that could not fire is
indistinguishable from one that succeeded, exactly as a **check** that cannot fire is
indistinguishable from one that passed. The class is not limited to validation.


## Pattern: validating a value is not validating its calibration

Bounding a value and pinning it to the input it was derived  from are **different checks,and the second cannot be obtained from the first.**

The case that proved it: a music bed gain of `1.50` is in range for a generated bed at
−43.1 dB RMS *and* for a licensed master at −11.4 dB — 31.7 dB apart, same in-range
number, correct for one and ~10 dB hot for the other. Swapping the source silently
invalidated the gain. Range validation protected against a bad value and was blind to a
stale one.

**Put the check where the source changes, not where the value is parsed.** The fix pins
the gain to a SHA-256 of the music file and refuses when the hash moves, with an explicit
re-confirm flag that re-pins after re-measuring. An affordance to re-pin matters: a check
with no cheap way to satisfy it gets routed around.

This is the dominant defect class of the whole audit in its purest form — **a value that is
individually valid and wrong in context.** Related instances: a path that is well-formed
and points somewhere else; a coverage figure that is accurate and from a different run; a
help string that is true of one command and rendered under another.

Note also what did *not* catch it. Narration-silent-window checks confirmed the bed was
**present** and said nothing about its **level**; they stayed green through the entire
failure. A check that measures presence cannot answer a question about degree.

## Pattern: plan mode must be answerable when the pipeline is not

A planning or dry-run path has to stay runnable against inputs that are **stubbed, absent,
or not yet rendered** — that is the entire point of it. Anything that decodes, probes or
resolves real media belongs *after* the plan branch, or behind a tolerant path.

Found by running, not reading: a remux stage probed media durations *before* its plan/exit
branch, so a no-flag plan exited non-zero on a stubbed input. Caught by a test asserting
that a no-flag run writes nothing and exits zero — against a stub file, which is exactly
why it caught it.

The plan must also not imply an outcome it could not compute. Where a value could not be
determined, print `UNDECIDED` **and the reason** rather than planning as though the
default applied.

**Corollary, discovered by a consumer rather than designed:** plan output turned out to be
worth more as a *dry-run diagnostic* than as a safety property. `8 segments, 154,757 bytes,
output EXISTS` is a free correctness check before a 25-minute render. Treat rich plan
output on expensive stages as a feature to design deliberately, not a by-product of a
guard rail.

**And keep two things distinct.** A *known* authoring error — a highlight addressing a
field that does not exist — is a hard build failure, because the author can fix it now. A
check that genuinely could not run reports `NOT evaluated` with its reason. Degrading the
first into the second buries a fixable mistake in a log nobody reads.

## Pattern: a set closed by construction must fail closed when it grows

The gain pin recorded the knobs that existed when it was written: source, hash and
`musicGain`. `--ceiling` arrived a round later, and the pin did not notice. **The
enumeration was not the error. The error was that nothing could fail when the set grew.**
The pin was correct when written and silently stale afterwards, the same shape as a
symptom-keyed guard.

The fix is a **registration point**, `mix-parameters.mjs`:
- It declares every parameter that reaches the mix.
- It scans the final filter graph and stops the run on any numeric token the registry
  cannot classify.
- A pinned parameter that is declared but never used also stops the run.
- A lock missing any registered parameter is refused as predating the set. It is never
  back-filled, because back-filling would certify a value nobody checked.

Publish the registry's blind spots alongside it. It cannot see a change that contains no
digit, anything outside `-filter_complex`, or whether `pinned` was set correctly. Its first
review still found `volume=.5` escaping the scan: a leading-dot decimal that the lookbehind
excluded. **A classify-or-refuse scanner is only as closed as its tokenizer.**

## Pattern: a recorded distinction that nothing reads is worse than no record

Old gain locks carried no `evidence` field, and the predicate never read one. The
distinction existed in the *schema* and in nobody's code path, and its presence invited
every reader to assume something checked it. **If a field exists in an artifact, something
must read it or it must not be written.** A schema is a promise about what is checked.

Its companion: **a confirmation step defends against forgetting, not against being wrong.**
The bed shipped ~24 dB hot under a confirmed pin. Confirmation proves someone agreed; only
a measurement proves they were right.

## Pattern: silence must be declared, never inferred from absence

Segment duration came from TTS. A deliberately silent segment and one not yet synthesised
were therefore the **same state**: no clip. The survey found five crash sites and six that
silently did the wrong thing.

The fix makes silence an authored fact:
- `silence` is declared in the timing schema, with a **required** `caption`.
- The caption becomes the accessibility cue, e.g. `[music]`.
- Concat fills declared silence and refuses undeclared holes.

The general form is *absence is not permission*, and it recurred the same week: an
envelope with no lineage binding is refused as UNBOUND rather than treated as current.

## Pattern: a modelled number beside measured ones reads as measured

The ducking plan printed a 0.67 dB gaps shortfall, taken from a one-pole model, next to
measured levels. The consumer measured 0.05–0.11 dB, because ffmpeg's release is faster
than the model. The number was fine *as a model*. It was wrong as a presentation, because a
figure in a column of measurements inherits their authority. **Label the provenance on the
line, not in a footnote.**

Siblings:
- **An instruction that names a target is checkable; one that names a setting is not.**
  "Duck by 11 dB" can be measured against the output. "Threshold 0.02" can only be obeyed.
  Solve the setting from the target, then measure the target.
- **Measure the claim where it is observable.** Duck depth cannot be read from the mix,
  because speech masks the bed it ducks. Measure it on the isolated bed, rendered through
  the same graph.
- **A hypothesis that looks sound needs the same measurement as one that does not.**
  Slowing the release to reduce pumping looked like free headroom. Measured, it cost
  2–9 dB of the gaps target.

## Pattern: a lane is covered only if its check has been seen to fail

The video coach's brief told its rubric author that the engine "already measures and fails
on" five lanes, so the rubric left them alone. The engines that drew the reviewed rounds
were checked only afterwards:
- text contrast was never computed, because a template-literal escape mangled the colour
  regex and every red channel parsed as `NaN` (C-14);
- graphics contrast was never measured;
- legibility was only logged;
- overflow was checked for the safe box alone;
- overlaps within a segment were not checked at all.

The brief's lane list had been written without running any of those checks. From outside,
**a check that never fires looks exactly like a check that always passes.** So before one
component leaves a lane to another, feed that lane's check a known-bad input and watch it
fail. The audit that found C-14 also found tests that stay green with the code they guard
deleted (B-8, B-9). Mutation is the same move, applied to a test.

## Pattern: a zero needs a positive control of the same shape

A count from a command whose failure mode is empty output cannot tell *nothing matched*
from *nothing ran*. The consumer session measured two instances in one week:
- an unquoted `A..B` revision range returned 0 in both directions. Quoted, it returned 0
  with `HEAD` on the left and 5 with the branch on the left. So a control run with `HEAD`
  on the left passes while the bug is live; only the other direction can detect it;
- a session-store query for PowerShell calls returned 0 rows. The control showed the store
  held nothing for that session at all: a zero that meant *not auditable*, read as
  *clean*, in the audit built to catch zeros that mean nothing ran.

**Any count derived from a command whose failure mode is empty output needs a positive
control of the same shape**: the same command, arguments and direction, run where it must
return more than zero. Asserting exit status is not a substitute; the broken range exits 0.

## Pattern: provenance names the page read, not the work cited

The rubric author read four papers' abstracts on repository records such as ERIC and
PsychArchives. When it regenerated its source list, it swapped in each paper's DOI, kept
the label "fetched", and declared every URL "carried forward". A DOI and a repository
record can name the same paper, but only one of them was read, and all four "fetched"
labels now point at the other.
**A provenance label is a claim about an instance, not a class.** "Fetched" must name the
exact page whose text was read. The only check is mechanical: join each claim to the tool
log by URL, following redirects.

The sibling: a promise to re-send something "unchanged" is also a claim, so diff it. The
re-sent source tail had dropped an entry and gained journal details it never had.

## Pattern: pre-register before you look — the commit order is the proof

The coach backtest commits the rubric, the coach and the scoring rules first, then every
input by hash. Only after that is the log that holds the answers read. Each committed hash
fixes an output before the next step exists, which is all the order has to prove, so the
outputs themselves can stay out of git.

Some contamination cannot be removed. The orchestrator knew the answers when it wrote the
brief. That goes in the protocol as a disclosure, not an argument, because a
pre-registration that hides its leaks certifies them.

## Pattern: a deferral's grade is a claim

When a report says *"found, not fixed — safe direction"*, the severity is doing as much
work as the finding, and it needs the same evidence.

A `validate-timing` type gap was reported as safe because a bad value produced a spurious
failure. True for a segment in the middle of a list. For the **final** segment there is
nothing after it to compare against, so the contiguity check could not fire, the budget
went `NaN`, and the verifier **exited 0 on malformed input** — a verifier that passes
garbage, reported as harmless.

The reasoning was sound about the case in view and silent about the boundary. Deferrals
get graded from the middle of a set; the ends behave differently.

Also worth separating honestly: *a test I could not write* and *a test I wrote that does
not discriminate* are different admissions. An envelope test that substituted a directory
could not distinguish the new behaviour from the old, because the check it replaced also
returned true for a directory — offered as covering the neighbour, when it was the same
square.

## Pattern: written artifacts outlive the session

Agent memory resets. The repo's memory does not. So:

- Every investigation ends in an **ADR** (`docs/adr/`) — the decision *and* the evidence.
- Every domain has a **README** saying what it is for and its honest current state.
- `memory-bank/progress.md` is the domain ledger; `docs/adr/` is the rationale.

"I learned how the API is shaped" is a README. "We will use X over Y because Z" is an ADR.

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Domain id (registry, commit scope) | kebab-case | `clipboard-history` |
| Domain folder | PascalCase | `apps/ClipboardHistory` |
| .NET project | `Forge.<Name>` | `Forge.ClipboardHistory` |
| Test project | `Forge.<Name>.Tests` | `Forge.ClipboardHistory.Tests` |
| Test method | `<Method>_<Scenario>_<ExpectedOutcome>` | `GetById_UnknownId_ReturnsNotFound` |
| PowerShell script | `Verb-PascalNoun.ps1`, approved verb | `New-ForgeDomain.ps1` |
| ADR | `NNNN-kebab-title.md`, sequential | `0001-multi-agent-orchestration-...md` |
| Spike folder | kebab-case, names the question | `spike/channel-vs-blockingcollection` |
| PR title into `main` | `<type>(<domain-id>): <imperative subject>` | `feat(ledger): add idempotent posting` |

## Default stacks for a new domain

| Kind | Project | Tests |
|---|---|---|
| app | WPF (`-Template winui` or similar to override) | xUnit + FluentAssertions + NSubstitute |
| service | ASP.NET Core Web API | xUnit + FluentAssertions + NSubstitute |
| lib | classlib | xUnit + FluentAssertions + NSubstitute |
| tool | console | xUnit + FluentAssertions + NSubstitute |
| script | PowerShell 7 | Pester v5 |

Never introduce a second framework into a domain that already has one.
