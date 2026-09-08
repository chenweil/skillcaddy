# Library image implementation

The repository-local `source` CLI exposes the library image workflow:

```sh
npm run source -- image export /path/to/library.tar.gz
npm run source -- image import /path/to/library.tar.gz --dry-run
npm run source -- image import /path/to/library.tar.gz --yes
```

`lib/libraryImage.js` owns the export and import transaction. Export validates
the source registry, source directories, non-Git integrity baselines, repository
state, reserved markers, and entry types before packing. It writes a gzip library image
with `library-image.json` first, verifies the packed bytes, and publishes the
result through an exclusive `0600` temporary file and hard link. An existing
destination is never overwritten.

Import inflates the gzip stream into a private temporary tar, parses every header
before invoking the system tar, and rejects absolute or traversing paths,
special files, contiguous entries, unsafe links, privileged modes, malformed
metadata, and data after the end marker. Extraction uses the platform-specific
allowlist from ADR-0011 and an empty staging directory. A post-flight walk checks
inode types, realpath containment, hard-link counts, and checksum or Git HEAD
matches before any source is submitted.

Library image path segments and relative link targets are normalized to NFC before
checksum validation; collisions after normalization are rejected. On APFS, a
decomposed spelling that aliases the same inode is retained by the filesystem
but is hashed using the same NFC policy.

Sources are submitted through the existing acquisition lifecycle's `image` input
adapter. Identical installed sources are idempotent, while differing content or
install paths produce a collision and do not replace receiver bytes. If a later
source fails, the transaction reports committed, uncommitted, and unattempted
sources and preserves staging for a retry. Successful import restores only the
manifest's global and Hermes enablements (`create` and `unchanged` dispositions),
keeps receiver sidecars and aliases on conflict, and writes the producer metadata
to `.skillcaddy/library-image-import.json`. Project enablements and the
`skillcaddy-manager` enablement remains outside the library image.

Validation is intentionally layered. `test/libraryImage.test.js` exercises the
public module and CLI seams with real host tar, byte-built adversarial archives,
source collisions, Git HEAD checks, scope changes, and partial submission. Run
the complete repository checks with:

```sh
npm test
```

The cross-platform fidelity scripts under `docs/research/0034-fidelity/` remain
the target-environment check for GNU tar and filesystem-specific metadata. A
machine's own Linux or macOS runtime should run those scripts before adopting a
library image operationally.
