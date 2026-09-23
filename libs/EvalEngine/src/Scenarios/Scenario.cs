namespace Forge.EvalEngine.Scenarios;

/// <summary>
/// The kind of system under test that a <see cref="Scenario"/> exercises.
/// </summary>
/// <remarks>
/// The kind selects a <see cref="Abstractions.IScenarioRunner"/>. It does <b>not</b> select a
/// pipeline. Every runner produces the same kind-agnostic <see cref="Transcripts.Transcript"/>
/// and <see cref="Transcripts.Outcome"/>, and everything downstream — assertions, aggregation,
/// comparison, reporting — operates only on those two types.
/// </remarks>
public enum ScenarioKind
{
    /// <summary>
    /// A single request/response against an HTTP endpoint. This is the degenerate one-turn case
    /// of the same pipeline, not a separate code path.
    /// </summary>
    Rest,

    /// <summary>A Model Context Protocol tool invocation.</summary>
    Mcp,

    /// <summary>A multi-turn exchange with a language-model-backed system.</summary>
    Llm,

    /// <summary>
    /// A scripted interaction with a real user interface, driven through a browser.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>No runner in this build conducts one.</b>
    /// <see cref="Runners.NotImplementedUiRunner"/> reports the gap cleanly so that a mixed suite
    /// still routes, and so that a real runner can be registered later without reshaping anything
    /// around it.
    /// </para>
    /// <para>
    /// The kind needs no new transcript shape, which is the point of admitting it now rather than
    /// alongside its implementation. A UI turn's stimulus is an <i>action</i> — click this, fill
    /// that — and its response is the page state the action produced. Structurally that is the
    /// same <see cref="Transcripts.Turn"/> a request and a reply are: something sent, something
    /// observed back. Nothing downstream of
    /// <see cref="Abstractions.IScenarioRunner"/> has to learn a new vocabulary for it.
    /// </para>
    /// </remarks>
    Ui,
}

/// <summary>
/// Who the scenario is and how it is labelled. Owned by the suite author; read by every stage
/// for identification and by the reporter for display.
/// </summary>
public sealed record ScenarioIdentity
{
    /// <summary>
    /// Gets the suite-unique identifier for the scenario. It is the join key between a baseline
    /// artifact and a candidate artifact, so it must be stable across runs.
    /// </summary>
    public required string Id { get; init; }

    /// <summary>Gets the kind of system the scenario exercises.</summary>
    public required ScenarioKind Kind { get; init; }

    /// <summary>
    /// Gets the coarse family this scenario probes, used to roll results up in a report.
    /// </summary>
    public string? ProbeClass { get; init; }

    /// <summary>Gets a human-readable description of what the scenario checks.</summary>
    public string? Description { get; init; }

    /// <summary>Gets a free-form note for the suite author — provenance, caveats, links.</summary>
    public string? Note { get; init; }
}

/// <summary>
/// One evaluation scenario, composed of independently owned sub-records.
/// </summary>
/// <remarks>
/// <para>
/// This type is deliberately a <b>composition</b> rather than a flat god-object. Each sub-record
/// is owned by exactly one pipeline stage, and no stage reaches across into another stage's
/// fields:
/// </para>
/// <list type="table">
///   <listheader><term>Sub-record</term><description>Owning stage</description></listheader>
///   <item><term><see cref="Identity"/></term><description>The suite author and the reporter.</description></item>
///   <item><term><see cref="Execution"/></term><description>The runner.</description></item>
///   <item><term><see cref="Simulation"/></term><description>The participant — the simulated caller.</description></item>
///   <item><term><see cref="Grading"/></term><description>The assertion evaluators.</description></item>
///   <item><term><see cref="Selection"/></term><description>The scenario selector.</description></item>
///   <item><term><see cref="Slicing"/></term><description>Results slicing only — never execution.</description></item>
/// </list>
/// <para>
/// <b>Adding a top-level field requires naming its consuming component.</b> A field with no named
/// consumer belongs inside an existing sub-record, or nowhere.
/// </para>
/// </remarks>
public sealed record Scenario
{
    /// <summary>Gets the scenario's identity and labelling.</summary>
    public required ScenarioIdentity Identity { get; init; }

    /// <summary>Gets how the runner drives the scenario.</summary>
    public required Execution Execution { get; init; }

    /// <summary>Gets the material the simulated caller draws on. Owned by the participant.</summary>
    public Simulation Simulation { get; init; } = new();

    /// <summary>Gets what a correct result looks like. Owned by the assertion evaluators.</summary>
    public Grading Grading { get; init; } = new();

    /// <summary>Gets the inputs to scenario selection. Owned by the selector.</summary>
    public Selection Selection { get; init; } = new();

    /// <summary>Gets the free-form dimensions used to slice results. Never read during execution.</summary>
    public Slicing Slicing { get; init; } = new();
}
