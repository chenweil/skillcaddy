# Safe library image unpacking boundary

Research resolution for [#33](https://github.com/chenweil/skillcaddy/issues/33).

## Question

When the system `tar` unpacks a library image, how do we reliably reject — before any
entry reaches staging, or during the write — absolute paths, `..` traversal, special
files, hardlink escape, and symlink-first escape?

The answer has to hold under the map's standing constraint: keep using the system `tar`
binary, add no Node tar dependency.

## Runtime versions under test

| Role | Value |
| --- | --- |
| Host OS | Darwin 25.6.0, arm64 |
| Host tar | `bsdtar 3.5.3 - libarchive 3.7.4` |
| Container OS | Ubuntu 24.04.4 LTS |
| Container tar | `tar (GNU tar) 1.35`, Debian package `1.35+dfsg-3build1` |
| Container kernel | `7.0.14-orbstack-00380-ga7e0a2dc9535`, x86_64 |
| Docker server | 29.4.0 (OrbStack) |

The Linux runtime is `linux/amd64` emulated on an arm64 host. Emulation affects
neither path handling nor inode-type policy, both of which are architecture
independent. It does affect `mknod`, which is a privilege question, and that case is
called out explicitly below.

## Method

Fixtures were generated with the repository's own `test/tarFixtures.js` builder rather
than by invoking `tar -c`. This is necessary: both tars refuse to *create* several of
the adversarial entries under test, so a fixture built by `tar` cannot express the
attack. The builder writes byte-faithful ustar/PAX headers, so the fixture declares
exactly the entry the attack needs.

Each fixture is extracted into a fresh sandbox laid out as:

```
sandbox/outside-target.txt     # escape target for relative hardlinks
sandbox/outside-dir/           # escape target for relative symlinks
sandbox/staging/               # the extraction root
```

An escape is any content appearing outside `staging/`, or any non-`file`/`directory`
inode appearing inside it.

Fixtures, runner, and probe scripts are reproducible from the commands in
[Appendix: reproducing](#appendix-reproducing).

## Results

`allowed` means the dangerous entry landed. `refused` means tar reported an error and
the entry did not land. `neutralized` means tar accepted the archive but rewrote the
entry into something harmless — the outcome that matters most here, because tar exits
`0` and gives the caller no signal.

| Escape class | bsdtar 3.5.3 | GNU tar 1.35 | Escaped staging? |
| --- | --- | --- | --- |
| Absolute path `/etc/x` | neutralized → `etc/x`, exit 0 | neutralized → `etc/x`, exit 0 | no |
| `..` traversal | refused, exit 1 | refused, exit 2 | no |
| `..` nested (`a/b/../../../x`) | refused, exit 1 | refused, exit 2 | no |
| PAX `path` override with `..` | refused, exit 1 | refused, exit 2 | no |
| USTAR `prefix` composing to `..` | refused, exit 1 | refused, exit 2 | no |
| Hardlink → `/etc/passwd` | refused (target missing), exit 1 | refused (target missing), exit 2 | no |
| Hardlink → `../outside-target.txt` | refused (`..`), exit 1 | refused (target missing), exit 2 | no |
| FIFO (`6`) | **allowed**, exit 0 | **allowed**, exit 0 | no |
| Char device (`3`) | refused (unprivileged) | refused (unprivileged) | no |
| Block device (`4`) | refused (unprivileged) | **allowed** when privileged on a native fs | no |
| Contiguous (`7`) | neutralized → regular file, exit 0 | neutralized → regular file, exit 0 | no |
| Symlink-first, target outside staging | refused, exit 1 | refused, exit 2 | no |
| Symlink-first, target inside staging | — | **followed**, wrote through the link | no |
| Hardlink → symlink → outside file | neutralized (both become symlinks) | neutralized (both become symlinks) | no |
| Entry hidden after end-of-archive marker | ignored, exit 0 | ignored, exit 0 | no |
| Pre-existing symlink in staging | — | **allowed**, wrote through it | **yes** |

Both tars document the path defenses that the table confirms. GNU tar: "File names
containing `..` can cause problems when extracting, so tar normally warns you about
such files when creating an archive, and rejects attempts to extracts such files"
([GNU tar 1.35 manual §6.10.2](https://www.gnu.org/software/tar/manual/html_section/absolute.html)).
libarchive: "By default, `tar` will not extract files containing `..` components in
their pathname [...] If neither `-U` nor `-P` is specified, `tar` will refuse to extract
the entry"
([libarchive `tar/bsdtar.1`, SECURITY](https://github.com/libarchive/libarchive/blob/master/tar/bsdtar.1)).

Five results deserve to be read carefully.

**Absolute paths produce no signal.** Both tars strip the leading `/` and extract the
member as a relative path inside staging, exiting `0`. GNU tar documents this: "When
tar extracts archive members from an archive, it strips any leading slashes (`/`) from
the member name" ([§6.10.2](https://www.gnu.org/software/tar/manual/html_section/absolute.html)).
So the image is not dangerous, but the caller cannot tell from tar's behavior that the
archive ever declared `/etc/x`. Only a header parse can distinguish "the image declared
an absolute path" from "the image declared a relative path".

**`-P` / `--absolute-names` is the one flag that must never be passed.** With `-P`, GNU
tar wrote `/etc/libimg33-absolute.txt` and placed the `..` member outside staging, both
at exit `0`. The manual is explicit: it "should be used only for trusted archives"
([§10.2 Security](https://www.gnu.org/software/tar/manual/html_section/Security.html)).
This is worth an assertion, not just an omission.

**FIFOs are created by both tars at exit 0, and no flag disables it.** This is the
clearest case where flag policy cannot close a class.

**Contiguous (`7`) is silently downgraded.** GNU tar prints "Extracting contiguous files
as regular files" and exits `0`. If we want `7` rejected rather than reinterpreted, only
our own parser can do it.

**GNU tar's symlink refusal is narrower than it looks.** When tar itself creates the
symlink member, it refuses to write a later member through it *if the target lies
outside the extraction root*, and follows it if the target lies inside. But when a
symlink already exists in staging and is not an archive member, GNU tar wrote straight
through it into a directory outside the extraction root. That is the only confirmed
escape in this study.

That escape is closed twice over in our implementation, and neither closure is a tar
flag. `prepareStaging` requires staging to be absent or empty, so no attacker-planted
symlink can pre-exist; and pre-flight rejects symlink entries outright, so tar is never
asked to create one.

## Flag support matrix

Every flag was probed by running a real extraction, not by reading `--help`. A
misspelled flag only fails at invocation time, which is exactly the failure mode that
left `LIBRARY_IMAGE_FLAG_POLICY.gnutar` empty in the first place.

| Flag | bsdtar 3.5.3 | GNU tar 1.35 | Effect |
| --- | --- | --- | --- |
| `--no-acls` | accepted | accepted | Do not restore POSIX ACLs |
| `--no-xattrs` | accepted | accepted | Do not restore extended attributes |
| `--no-same-permissions` | accepted | accepted | Apply umask; strips setuid/setgid |
| `--no-same-owner` | accepted | accepted | Do not restore archive uid/gid |
| `--no-mac-metadata` | accepted | **rejected** (exit 64) | bsdtar only |
| `--no-fflags` | accepted | **rejected** (exit 64) | bsdtar only |
| `--no-selinux` | **rejected** (exit 1) | accepted | GNU only; disables SELinux context restore |
| `--no-overwrite-dir` | **rejected** (exit 1) | accepted | GNU only; preserve metadata of existing dirs |
| `--delay-directory-restore` | **rejected** (exit 1) | accepted | GNU only; defer directory mode/mtime to end |
| `--skip-old-files` | **rejected** (exit 1) | accepted | GNU only |
| `--keep-old-files` | accepted | accepted | Error on existing files |
| `--one-top-level` | **rejected** (exit 1) | accepted | GNU only; changes layout |
| `--numeric-owner` | accepted | accepted | Only meaningful with `--same-owner` |
| `--absolute-names` | **rejected** (exit 1) | accepted | **Disables every path defense** |

`--no-same-owner` and `--no-same-permissions` matter specifically because GNU tar
changes its default by privilege: `--help` describes each as "default for ordinary
users", which is to say *not* the default for root. Confirmed as root in-container:
without `--no-same-permissions`, mode `4755` and `2755` survive extraction; with it,
both become `755`.

## Fidelity cost of the hardening flags

A representative tree (nested `.git`, empty directory, relative symlink, `755`
executable, `640` file) was packed on Linux and extracted twice, with and without the
full hardened flag set. Byte content, symlink targets, empty directories, and every
mode were identical in both runs.

`--no-same-permissions` is not free in general — it applies the umask, so `666` becomes
`644` under `umask 022`, and setuid/setgid bits are dropped. For skill sources, whose
modes are `644`, `640`, and `755`, umask `022` is a no-op. Dropping setuid is a gain,
not a loss. Whether a library image may legitimately declare setuid at all is a
decision for [#35](https://github.com/chenweil/skillcaddy/issues/35), not a flag
question.

## Recommendation

Set `LIBRARY_IMAGE_FLAG_POLICY.gnutar` to:

```js
gnutar: Object.freeze([
  '--no-selinux',
  '--no-overwrite-dir',
  '--delay-directory-restore'
])
```

| Flag | Why |
| --- | --- |
| `--no-selinux` | GNU-only counterpart to the `--no-acls` / `--no-xattrs` already in `common`; keeps an untrusted image from carrying a security context into staging. Verified to run on GNU tar 1.35. |
| `--no-overwrite-dir` | Keeps an image from rewriting the metadata of a directory it did not create. Near-inert given the empty-staging invariant, and correct if that invariant is ever relaxed. Verified to run. |
| `--delay-directory-restore` | Robustness, not security: defers directory modes so an image declaring an unwritable parent cannot make its own children fail to extract. Verified to run. |

Keep `common` as it stands — `--no-acls`, `--no-xattrs`, `--no-same-permissions`,
`--no-same-owner` are all accepted by both implementations.

Two flags are worth rejecting deliberately:

- `--absolute-names` / `-P` must never be passed, and the existing hard-closed
  allowlist should be treated as load-bearing for that reason. This research
  demonstrated a real `/etc` write with it enabled.
- `--keep-old-files` / `--skip-old-files` should stay out. Staging is empty, so they
  protect nothing, and `--keep-old-files` would turn an archive with duplicate member
  names — which tar normally resolves last-wins, and which post-flight already
  reconciles — into a hard failure.

## Cannot be solved by flags

These classes have no flag that closes them on either implementation. They must remain
the responsibility of our own header pre-flight and staging post-flight, which is where
`lib/libraryImage.js` already puts them.

1. **FIFOs and, when privileged, block devices.** Both tars create FIFOs at exit `0`.
   Only the inode-type allowlist rejects them.
2. **Contiguous type `7`.** Silently reinterpreted as a regular file by both tars. Only
   the typeflag parse can refuse it.
3. **Absolute paths.** Silently neutralized to relative by both tars at exit `0`. Only
   the header parse can see that the image declared one.
4. **Entries hidden after the end-of-archive marker.** Both tars stop reading at the
   first zero block, so the hidden member is invisible to the extractor and to any
   `tar -t` listing. Only a full-stream parse finds it.
5. **Writing through a pre-existing symlink in staging.** The one confirmed escape.
   Closed by the empty-staging invariant in `prepareStaging`, not by any flag.
6. **Hardlink identity after the fact.** Post-flight classifies inodes from `readdir`
   dirents, where a hardlink to an outside file is indistinguishable from a regular
   file. Pre-flight rejection of hardlink entries is what actually closes this;
   post-flight cannot independently confirm it without checking link counts.

All 17 adversarial fixtures were also run against our own `extractLibraryImage`. Every
one was rejected with `category: 'source-safety'` before tar was invoked, except the
mode fixture, which is accepted by design because its entries are ordinary files and
directories.

## Gap found

Pre-flight does not inspect the `mode` field at all. An image may therefore declare
`setuid`, `setgid`, or `1777` entries and pass validation. In practice the
`--no-same-permissions` flag in `common` strips those bits on both implementations, so
nothing dangerous lands today — but the guarantee currently rests on flag policy rather
than on a validated invariant, and it is not covered by a test. Whether to reject such
modes outright, normalize them, or record them as diagnostics belongs to
[#35](https://github.com/chenweil/skillcaddy/issues/35).

## Appendix: reproducing

```sh
WORK=$(mktemp -d /tmp/libimg33-XXXXXX)

# Fixtures are built with the repo's own byte-faithful tar builder,
# because both tars refuse to create several of these entries.
node "$WORK/make-fixtures.mjs" "$WORK/fixtures"

# macOS bsdtar
./run-fixtures.sh "$WORK/fixtures" "$WORK/out-bsdtar" tar "bsdtar"

# Linux GNU tar
docker run --rm -v "$WORK":/work ubuntu:24.04 \
  sh -c 'cd /work && ./run-fixtures.sh /work/fixtures /work/out-gnutar tar "GNU tar"'

# Flag acceptance, by real extraction rather than --help
./probe-flags.sh tar
docker run --rm -v "$WORK":/work ubuntu:24.04 sh -c '/work/probe-flags.sh tar'
```

Block-device creation requires both `--privileged` and a native filesystem; it does not
reproduce on a bind mount. All sandboxes live under `/tmp/libimg33-*`; no fixture ever
touches `official/`, `github/`, `personal/`, `archived/`, or `.skillcaddy/`.

## Primary sources

- [GNU tar 1.35 manual, §6.10.2 Absolute File Names](https://www.gnu.org/software/tar/manual/html_section/absolute.html) — leading-slash stripping and `..` rejection on extract; `-P` disables both.
- [GNU tar 1.35 manual, §10.2 Security](https://www.gnu.org/software/tar/manual/html_section/Security.html) — `-P` is for trusted archives only; `--overwrite` and `-h` carry comparable risk.
- [GNU tar 1.35 manual, §4.4 Options Used by --extract](https://www.gnu.org/software/tar/manual/html_section/extract-options.html) — `--overwrite` follows symlinks and removes special files in the way.
- [libarchive `tar/bsdtar.1`, SECURITY section](https://github.com/libarchive/libarchive/blob/master/tar/bsdtar.1) — the three escape mechanisms bsdtar defends, the final-path-element symlink check, and `-U` / `-P` semantics.
- [FreeBSD SA-16:31.libarchive](https://www.freebsd.org/security/advisories/FreeBSD-SA-16:31.libarchive.asc) — prior symlink and hardlink handling flaws in libarchive permitted writes outside the extraction directory; evidence that these defenses are historically fallible and should not be the only layer.
- `tar --help` from GNU tar 1.35 as installed in-container — authoritative for the exact binary under test, including the "default for ordinary users" wording on `--no-same-owner` and `--no-same-permissions`.
