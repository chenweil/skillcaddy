# Skillcaddy

Skillcaddy manages locally acquired skill sources and selectively enables their skills in individual projects.

## Language

**Skill source**:
An external acquisition unit that contains one or more skills and retains enough origin information to be managed after download.
_Avoid_: Download, plugin

**Source identity**:
A stable name that distinguishes a skill source across downloads and upgrades independently of its physical installation path. It uses the source name by default and adds a source namespace when that name would otherwise conflict.
_Avoid_: Folder name, download URL

**Source collision**:
A destination-name conflict where Skillcaddy cannot establish that the incoming content and installed content share the same source identity. A collision is not an upgrade and never authorizes replacement.
_Avoid_: Duplicate version, update

**Source namespace**:
A disambiguating provenance label used when two skill sources have the same name. Git sources use their repository owner; archive sources use the download URL's registrable domain unless explicitly overridden.
_Avoid_: Author, hostname

**Source bucket**:
A top-level provenance classification for an acquired source. Hosted Git repositories belong to `github`, upstream archives to `official`, user-supplied local content to `personal`, and retired content to `archived`.
_Avoid_: File type, install status

**Source registry**:
Skillcaddy-owned sidecar records that preserve source identity, sanitized provenance, integrity information, and discovered skill paths without modifying acquired source content.
_Avoid_: Source manifest, package metadata

**Git source**:
A skill source acquired as a complete Git repository from a hosted Git URL. A URL pointing into a repository may identify a source focus, but does not change the repository-sized acquisition unit.
_Avoid_: GitHub skill, cloned skill

**Source focus**:
An optional path supplied with a hosted repository link that identifies the skills relevant to the current request without narrowing the acquired source.
_Avoid_: Sparse checkout, partial source

**Source credentials**:
Access credentials managed by the user's existing Git or download environment rather than stored by Skillcaddy. Persisted source provenance never contains secrets or sensitive URL parameters.
_Avoid_: Skillcaddy token, embedded password

**Archive source**:
A versioned archive acquired from a direct download URL and unpacked into the central library. It may contain one skill or a collection of related skills, and only its latest installed version is retained.
_Avoid_: ZIP skill, skill folder

**Local source**:
A skill source imported from a local archive or directory and copied into the central library so it does not depend on the original filesystem location.
_Avoid_: Linked folder, working copy

**Source acquisition**:
The download, validation, and installation of a skill source into the central library without executing source-provided code or configuring a project.
_Avoid_: Setup, enablement

**Source validation**:
Safety and discoverability checks applied before acquisition changes the central library. Safety failures reject the source, while non-security skill-format issues are reported as quality warnings.
_Avoid_: Runtime preflight, setup check

**Source upgrade**:
Replacement of an installed skill source with another valid package for the same source identity. Archive upgrades do not require Skillcaddy to infer or compare versions, and the replaced package is not retained as an active or historical copy.
_Avoid_: Side-by-side install, version copy

**Breaking source replacement**:
A source upgrade that removes or relocates a previously discovered skill path and may therefore break project links. It is distinct from version comparison and requires explicit authorization when an affected link is known.
_Avoid_: New version, content update

**Setup readiness**:
The known state of prerequisites required before an enabled skill can work in a specific scope. Acquisition alone never establishes setup readiness, and readiness never controls whether the skill can be enabled.
_Avoid_: Installed, downloaded

**Unknown setup readiness**:
The absence of a declared setup contract for a skill source. It does not imply that setup is required and does not prevent normal skill enablement.
_Avoid_: Missing setup, incomplete setup

**Setup reminder**:
Non-blocking guidance shown for a skill whose source declares unmet setup prerequisites. Its type controls whether and how prominently Skillcaddy reminds the user, never whether the skill may be enabled.
_Avoid_: Setup gate, enablement requirement

**Runtime preflight**:
A source-provided check performed when a skill is used to detect missing credentials, dependencies, or other runtime prerequisites and guide the user through them. It is outside source acquisition and enablement.
_Avoid_: Source validation, Skillcaddy setup reminder

**Enablement**:
The creation of a project-level link to a skill already present in the central library. Source acquisition never implies enablement; both occur in one workflow only when the user expresses both intents.
_Avoid_: Download, installation

**Skill**:
An Agent-facing capability rooted at a directory containing `SKILL.md`, discovered within a skill source and enabled independently per project.
_Avoid_: Library, repository
