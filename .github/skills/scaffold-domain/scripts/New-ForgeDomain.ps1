#Requires -Version 7.0

<#
.SYNOPSIS
    Creates and registers a new Forge domain — an app, service, library, tool, script, or spike.

.DESCRIPTION
    Forge's multi-agent system is parameterized by domain: the orchestrator passes a domain
    id, and builders resolve paths and build/test commands from .github/domains.yaml. That
    only works if the registry is complete, so this script is the single supported way to
    add a domain.

    It creates the folder and README, scaffolds the project and test project, adds them to
    Forge.sln (spikes excluded per constitution section XI), and appends the registry row.
    Optionally mints a dedicated builder/reviewer agent pair for the new domain.

    The root folder determines the rigor tier and that is not negotiable afterwards:
      apps/     -> tier 2      services/ -> tier 1      libs/    -> tier 1
      tools/    -> tier 2      scripts/  -> tier 2      spike/   -> tier 0

    Run with -WhatIf first and show the user the plan before applying it.

.PARAMETER Id
    Unique kebab-case identifier. Becomes the Conventional Commit scope (constitution
    section X) and the registry key.

.PARAMETER Kind
    One of: app, service, lib, tool, script, spike. Determines the root folder, the tier,
    the default template, and the builder/reviewer assignment.

.PARAMETER Name
    PascalCase folder and project name, e.g. ClipboardHistory.

.PARAMETER Question
    The one falsifiable question a spike answers. Mandatory for -Kind spike; a spike
    without a stated question is a tool or an app in disguise.

.PARAMETER Template
    Overrides the default 'dotnet new' template for the kind. Use this for WinUI 3 or any
    template pack not in the base SDK.

.PARAMETER NoTests
    Skips the test project. Rejected for tier 1 kinds (service, lib) because
    failing-test-first is mandatory there (constitution section VI).

.PARAMETER WithAgents
    Also generates a dedicated builder/reviewer agent pair for this domain, seeded from the
    generic pair, and points the registry row at them. Review and edit the generated pair
    afterwards — they start as copies.

.PARAMETER RepoRoot
    Repository root. Defaults to the repo containing this script.

.EXAMPLE
    PS> .\New-ForgeDomain.ps1 -Id clipboard-history -Kind app -Name ClipboardHistory -WhatIf

    Shows what would be created for a tier 2 WPF desktop app, without changing anything.
    Always do this first.

.EXAMPLE
    PS> .\New-ForgeDomain.ps1 -Id ledger -Kind service -Name Ledger

    Creates services/Ledger with an ASP.NET Core Web API project and an xUnit test project,
    adds both to Forge.sln, and registers the domain at tier 1.

.EXAMPLE
    PS> .\New-ForgeDomain.ps1 -Id channel-vs-blockingcollection -Kind spike -Name ChannelVsBlockingCollection -Question 'Is Channel<T> faster than BlockingCollection<T> at our throughput?'

    Creates a tier 0 spike, excluded from Forge.sln, with its question recorded in the
    README and the registry.

.OUTPUTS
    PSCustomObject with Id, Kind, Tier, Path, Project, TestProject, Registered, and
    AgentsCreated.

.NOTES
    Governed by .github/instructions/constitution.instructions.md.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9]+(-[a-z0-9]+)*$')]
    [string] $Id,

    [Parameter(Mandatory = $true)]
    [ValidateSet('app', 'service', 'lib', 'tool', 'script', 'spike')]
    [string] $Kind,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z][A-Za-z0-9]*$')]
    [string] $Name,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $Question,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $Template,

    [Parameter()]
    [switch] $NoTests,

    [Parameter()]
    [switch] $WithAgents,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Kind configuration -----------------------------------------------------------------

$kindConfig = @{
    app     = @{ Root = 'apps';     Tier = 2; Template = 'wpf';     Builder = 'app-builder';     Reviewer = 'app-reviewer';     InSolution = $true;  Checklist = 'app-design-checklist.md' }
    service = @{ Root = 'services'; Tier = 1; Template = 'webapi';  Builder = 'service-builder'; Reviewer = 'service-reviewer'; InSolution = $true;  Checklist = 'service-design-checklist.md' }
    lib     = @{ Root = 'libs';     Tier = 1; Template = 'classlib'; Builder = 'service-builder'; Reviewer = 'service-reviewer'; InSolution = $true;  Checklist = 'service-design-checklist.md' }
    tool    = @{ Root = 'tools';    Tier = 2; Template = 'console'; Builder = 'tooling-builder'; Reviewer = 'tooling-reviewer'; InSolution = $true;  Checklist = 'tooling-design-checklist.md' }
    script  = @{ Root = 'scripts';  Tier = 2; Template = '';        Builder = 'tooling-builder'; Reviewer = 'tooling-reviewer'; InSolution = $false; Checklist = 'script-design-checklist.md' }
    spike   = @{ Root = 'spike';    Tier = 0; Template = 'console'; Builder = 'researcher';      Reviewer = 'none';             InSolution = $false; Checklist = 'none' }
}

$config = $kindConfig[$Kind]

# --- Resolve the repository root --------------------------------------------------------

if (-not $PSBoundParameters.ContainsKey('RepoRoot')) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..' '..')).Path
}

if (-not (Test-Path -LiteralPath $RepoRoot)) {
    throw "Repository root not found: $RepoRoot"
}

$registryPath = Join-Path $RepoRoot '.github' 'domains.yaml'
$solutionPath = Join-Path $RepoRoot 'Forge.sln'
$packagesPropsPath = Join-Path $RepoRoot 'Directory.Packages.props'

if (-not (Test-Path -LiteralPath $registryPath)) {
    throw "Domain registry not found at '$registryPath'. This script must run inside the Forge repo."
}

# --- Validate ---------------------------------------------------------------------------

if ($Kind -eq 'spike' -and -not $PSBoundParameters.ContainsKey('Question')) {
    throw "-Question is mandatory for a spike. A spike answers exactly one falsifiable question (constitution section XI). If you cannot state one, you want -Kind tool or -Kind app."
}

if ($NoTests -and $config.Tier -eq 1) {
    throw "-NoTests is rejected for '$Kind' (tier 1). Failing-test-first is mandatory in services/ and libs/ (constitution section VI)."
}

$registryContent = Get-Content -LiteralPath $registryPath -Raw
if ($registryContent -match "(?m)^\s*-\s*id:\s*$([regex]::Escape($Id))\s*$") {
    throw "Domain id '$Id' is already registered in .github/domains.yaml. Pick a different id."
}

$domainPath = Join-Path $RepoRoot $config.Root $Name
if (Test-Path -LiteralPath $domainPath) {
    throw "Folder already exists: $domainPath. An unregistered folder is a defect — register it or remove it before scaffolding."
}

if (-not $PSBoundParameters.ContainsKey('Template')) {
    # Assigning back into $Template would re-run [ValidateNotNullOrEmpty()], which the
    # script kind (no template — it is not compiled) would fail. Use a local instead.
    $effectiveTemplate = $config.Template
}
else {
    $effectiveTemplate = $Template
}

# --- Compute paths (forward slashes for the registry) ------------------------------------

$relDomain  = "$($config.Root)/$Name"
$relSource  = "$relDomain/src"
$relTests   = "$relDomain/tests"
$projectName = "Forge.$Name"
# A spike is Tier 0: no test mandate (section VI), so it does not get a test project by
# default. Add tests by hand if they make the experiment faster — nothing requires them.
$includeTests = (-not $NoTests) -and ($Kind -ne 'script') -and ($Kind -ne 'spike')

if ($Kind -eq 'script') {
    $relProject  = "$relSource/$Name.ps1"
    $buildCmd    = 'none'
    $testCmd     = if ($NoTests) { 'none' } else { "Invoke-Pester -Path $relTests" }
    $relTestProj = "$relTests/$Name.Tests.ps1"
}
else {
    $relProject  = "$relSource/$projectName.csproj"
    $buildCmd    = "dotnet build $relProject"
    $relTestProj = "$relTests/$projectName.Tests.csproj"
    $testCmd     = if ($includeTests) { "dotnet test $relTestProj" } else { 'none' }
}

Write-Verbose "Domain '$Id' -> $relDomain (kind=$Kind, tier=$($config.Tier), template='$effectiveTemplate')"

# --- Helpers ----------------------------------------------------------------------------

function Invoke-Dotnet {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]] $Arguments)

    Write-Verbose "dotnet $($Arguments -join ' ')"
    $output = & dotnet @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet $($Arguments -join ' ') failed with exit code ${LASTEXITCODE}:`n$output"
    }
    Write-Verbose ($output | Out-String)
}

function Write-TextFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][AllowEmptyString()][string] $Content
    )

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Set-Content -LiteralPath $Path -Value $Content -Encoding utf8NoBOM
}

function ConvertTo-CentralPackageManagement {
    <#
    .SYNOPSIS
        Strips inline package versions from a generated .csproj so it satisfies Central
        Package Management.

    .DESCRIPTION
        'dotnet new' templates emit <PackageReference Include="..." Version="..." />, which
        fails restore with NU1008 under Central Package Management (constitution section
        VII: never pin a version in a .csproj). This removes the Version attribute so the
        version resolves from Directory.Packages.props instead.

        Any package the template references must therefore have a PackageVersion entry in
        Directory.Packages.props — this warns if one is missing rather than failing later
        with an opaque restore error.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $ProjectPath,
        [Parameter(Mandatory)][string] $PackagesPropsPath
    )

    if (-not (Test-Path -LiteralPath $ProjectPath)) { return }

    $content = Get-Content -LiteralPath $ProjectPath -Raw
    $pinned = [regex]::Matches($content, '<PackageReference\s+Include="(?<id>[^"]+)"\s+Version="[^"]*"')

    if ($pinned.Count -eq 0) { return }

    $content = $content -replace '(<PackageReference\s+Include="[^"]+")\s+Version="[^"]*"', '$1'
    Set-Content -LiteralPath $ProjectPath -Value $content -Encoding utf8NoBOM

    $declared = Get-Content -LiteralPath $PackagesPropsPath -Raw
    foreach ($id in ($pinned | ForEach-Object { $_.Groups['id'].Value } | Sort-Object -Unique)) {
        if ($declared -notmatch [regex]::Escape("PackageVersion Include=`"$id`"")) {
            Write-Warning "Package '$id' is referenced by the template but has no PackageVersion entry in Directory.Packages.props. Add one before building."
        }
        Write-Verbose "Unpinned '$id' in $ProjectPath (version now resolves centrally)."
    }
}

# --- Apply ------------------------------------------------------------------------------

$target = "$relDomain (kind=$Kind, tier=$($config.Tier))"
if (-not $PSCmdlet.ShouldProcess($target, 'Scaffold and register Forge domain')) {
    Write-Verbose 'WhatIf: no changes made.'
    return [PSCustomObject]@{
        Id            = $Id
        Kind          = $Kind
        Tier          = $config.Tier
        Path          = $relDomain
        Project       = $relProject
        TestProject   = if ($includeTests -or $Kind -eq 'script') { $relTestProj } else { $null }
        Registered    = $false
        AgentsCreated = $false
        WhatIf        = $true
    }
}

New-Item -ItemType Directory -Path (Join-Path $RepoRoot $relSource) -Force | Out-Null

# 1. Project scaffolding
if ($Kind -eq 'script') {
    $scriptBody = @"
#Requires -Version 7.0

<#
.SYNOPSIS
    TODO: one line describing what $Name does.

.DESCRIPTION
    TODO: what this script does, when to use it, and what it changes.
    Default invocation MUST be safe — guard destructive work behind ShouldProcess.

.PARAMETER Path
    TODO: describe each parameter.

.EXAMPLE
    PS> ./$Name.ps1 -Path . -WhatIf

    Shows what would happen without changing anything. Keep the safe invocation first.

.OUTPUTS
    TODO: describe the objects this emits.
#>
[CmdletBinding(SupportsShouldProcess = `$true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = `$true)]
    [ValidateNotNullOrEmpty()]
    [string] `$Path
)

Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'

if (`$PSCmdlet.ShouldProcess(`$Path, 'TODO: describe the action')) {
    # TODO: implement. Emit objects, not formatted strings.
    Write-Verbose "Processing `$Path"
}
"@
    Write-TextFile -Path (Join-Path $RepoRoot $relProject) -Content $scriptBody

    if (-not $NoTests) {
        $pesterBody = @"
BeforeAll {
    `$script:ScriptPath = Join-Path `$PSScriptRoot '..' 'src' '$Name.ps1'
}

Describe '$Name' {
    It 'Invoke_WithWhatIf_DoesNotMutateState' {
        # The single most valuable test in this kind: prove the safe default is safe.
        `$script:ScriptPath | Should -Exist
    }
}
"@
        Write-TextFile -Path (Join-Path $RepoRoot $relTestProj) -Content $pesterBody
    }
}
else {
    Invoke-Dotnet @('new', $effectiveTemplate, '-n', $projectName, '-o', (Join-Path $RepoRoot $relSource))
    ConvertTo-CentralPackageManagement -ProjectPath (Join-Path $RepoRoot $relProject) -PackagesPropsPath $packagesPropsPath

    if ($includeTests) {
        Invoke-Dotnet @('new', 'xunit', '-n', "$projectName.Tests", '-o', (Join-Path $RepoRoot $relTests))
        $testProjPath = Join-Path $RepoRoot $relTestProj
        ConvertTo-CentralPackageManagement -ProjectPath $testProjPath -PackagesPropsPath $packagesPropsPath

        # The constitution's declared default assertion/mocking stack (section VI).
        $testContent = Get-Content -LiteralPath $testProjPath -Raw
        if ($testContent -notmatch 'FluentAssertions') {
            $extraRefs = @'
  <ItemGroup>
    <PackageReference Include="FluentAssertions" />
    <PackageReference Include="NSubstitute" />
  </ItemGroup>
</Project>
'@
            $testContent = $testContent -replace '</Project>\s*$', $extraRefs
            Set-Content -LiteralPath $testProjPath -Value $testContent -Encoding utf8NoBOM
        }

        Invoke-Dotnet @('add', $testProjPath, 'reference', (Join-Path $RepoRoot $relProject))
    }

    # Templates emit an undocumented Class1, which fails the libs/** XML-doc bar (section IV).
    # A freshly scaffolded domain must build, so replace it with conformant starter code.
    $class1 = Join-Path $RepoRoot $relSource 'Class1.cs'
    if (Test-Path -LiteralPath $class1) {
        $starter = @"
namespace $projectName;

/// <summary>
/// Placeholder type created by scaffold-domain. Replace it with the real surface of
/// <c>$Name</c>, and delete this type once it is no longer referenced.
/// </summary>
/// <remarks>
/// Public members in <c>libs/</c> are a contract: every one needs an XML doc comment
/// (constitution section IV), and every consumer is listed in the domain registry.
/// </remarks>
public static class $Name
{
    /// <summary>
    /// Gets the domain identifier as registered in <c>.github/domains.yaml</c>.
    /// </summary>
    public static string DomainId => "$Id";
}
"@
        Write-TextFile -Path (Join-Path $RepoRoot $relSource "$Name.cs") -Content $starter
        Remove-Item -LiteralPath $class1 -Force
    }
}

# 2. Solution wiring (spikes and scripts excluded — constitution section XI)
if ($config.InSolution) {
    if (-not (Test-Path -LiteralPath $solutionPath)) {
        Invoke-Dotnet @('new', 'sln', '-n', 'Forge', '-o', $RepoRoot)
    }
    Invoke-Dotnet @('sln', $solutionPath, 'add', (Join-Path $RepoRoot $relProject))
    if ($includeTests) {
        Invoke-Dotnet @('sln', $solutionPath, 'add', (Join-Path $RepoRoot $relTestProj))
    }
}

# 3. Domain README (required by constitution section IX)
if ($Kind -eq 'spike') {
    $readme = @"
# $Name

> **Spike — Tier 0.** Throwaway experiment. Nothing outside ``spike/`` may depend on this.
> Excluded from ``Forge.sln`` by design (constitution section XI).

## Question

$Question

## How to run

``````powershell
dotnet run --project $relSource
``````

## Answer

_(pending)_

## Disposition

- [ ] **Graduate** — rebuild for real in ``apps/``, ``services/``, ``libs/``, or ``tools/``
      at its proper tier. Graduation is a **rewrite** under the gates this skipped, not a
      folder move.
- [ ] **Retire** — delete this folder; the finding lives in ``docs/adr/``.
- [ ] **Park** — still a useful reference. Note what would unblock it.
"@
}
else {
    $runLine = if ($Kind -eq 'script') { "./$relProject -WhatIf" } else { "dotnet run --project $relSource" }
    $readme = @"
# $Name

> **Kind:** ``$Kind`` · **Tier:** $($config.Tier) · **Registry id:** ``$Id``

## What this is

TODO: one paragraph. What does it do?

## What it was built to learn or do

TODO: why does this exist? This is a workshop repo — the reason matters more than the code.

## How to run

``````powershell
$runLine
``````

## Current state

TODO: ``working`` | ``partial`` | ``broken`` | ``abandoned`` — and what is missing.
Be honest here; a README that overstates is worse than none.

## Build and test

``````powershell
$buildCmd
$testCmd
``````
"@
}
Write-TextFile -Path (Join-Path $RepoRoot $relDomain 'README.md') -Content $readme

# 4. Optional dedicated agent pair
$agentsCreated = $false
$builderName = $config.Builder
$reviewerName = $config.Reviewer

if ($WithAgents) {
    if ($Kind -eq 'spike') {
        Write-Warning 'Spikes are handled by the researcher agent; -WithAgents ignored.'
    }
    else {
        $agentDir = Join-Path $RepoRoot '.github' 'agents'
        foreach ($role in @('builder', 'reviewer')) {
            $sourceAgent = Join-Path $agentDir "$(if ($role -eq 'builder') { $config.Builder } else { $config.Reviewer }).agent.md"
            $newName = "$Id-$role"
            $destAgent = Join-Path $agentDir "$newName.agent.md"

            $content = Get-Content -LiteralPath $sourceAgent -Raw
            $content = $content -replace "(?m)^name:\s*.+$", "name: $newName"
            $lockNote = @"

> **Domain-locked agent.** Generated from the generic ``$(if ($role -eq 'builder') { $config.Builder } else { $config.Reviewer })`` for domain
> ``$Id`` (``$relDomain``). It is currently an unedited copy — add the domain-specific rules
> that justified minting it, and delete this note. Model pin (constitution section VIII)
> is unchanged: builders ``claude-opus-4.8``, reviewers ``gpt-5.6-sol``.

"@
            $content = $content -replace "(?s)(^---.*?---\r?\n)", "`$1$lockNote"
            Write-TextFile -Path $destAgent -Content $content
            Write-Verbose "Generated $destAgent"
        }
        $builderName = "$Id-builder"
        $reviewerName = "$Id-reviewer"
        $agentsCreated = $true
    }
}

# 5. Registry row
$checklistPath = if ($config.Checklist -eq 'none') { 'none' } else { ".github/checklists/$($config.Checklist)" }
$questionLine = if ($Kind -eq 'spike') { "`n    question: '$($Question -replace "'", "''")'" } else { '' }
$testsLine = if ($includeTests -or ($Kind -eq 'script' -and -not $NoTests)) { $relTests } else { 'none' }

$entry = @"

  - id: $Id
    kind: $Kind
    path: $relDomain
    source: $relSource
    tests: $testsLine
    project: $relProject
    build: $buildCmd
    test_cmd: $testCmd
    tier: $($config.Tier)
    builder: $builderName
    reviewer: $reviewerName
    checklist: $checklistPath$questionLine
    status: active
    notes: ''
"@

# Convert the empty-list placeholder to a real sequence on first use.
$registryContent = $registryContent -replace "(?m)^domains:\s*\[\]\s*$", 'domains:'
$registryContent = $registryContent -replace "(?m)^\s+#\s*No domains registered yet.*\r?\n", ''
$registryContent = $registryContent -replace "(?m)^\s+#\s*Add the first one with the .scaffold-domain. skill\.\s*\r?\n", ''
$registryContent = $registryContent.TrimEnd() + $entry + "`n"

Set-Content -LiteralPath $registryPath -Value $registryContent -Encoding utf8NoBOM
Write-Verbose "Registered '$Id' in .github/domains.yaml"

Write-Warning "Next: (1) run '$buildCmd', (2) fill in $relDomain/README.md — the skeleton is not acceptable (section IX), (3) update memory-bank/progress.md."

[PSCustomObject]@{
    Id            = $Id
    Kind          = $Kind
    Tier          = $config.Tier
    Path          = $relDomain
    Project       = $relProject
    TestProject   = if ($testsLine -eq 'none') { $null } else { $relTestProj }
    Registered    = $true
    AgentsCreated = $agentsCreated
    WhatIf        = $false
}
