import {
  mkdir,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { SourceAcquisitionError, sourceCollisionError } from './sourceAcquisitionError.js';
import {
  assertSameSourceAcquisitionFacts,
  assertSourceAcquisitionDestinationAvailable
} from './sourceAcquisitionPolicy.js';
import {
  SOURCE_INSTALLING_MARKER,
  SOURCE_INSTALLING_MARKER_CONTENT
} from './sourcePolicy.js';
import { createSourceRecord } from './sourceRegistry.js';
import {
  ensureSourceDirectory,
  sourcePathExists
} from './sourceTree.js';
import {
  createManagedSourceWorkspace,
  removeManagedSourceWorkspace
} from './sourceWorkspace.js';

export const defaultSourceAcquisitionFileOperations = {
  mkdir,
  readdir,
  rename,
  rm,
  writeFile
};

export async function executeSourceAcquisition(context, acquisition) {
  const workspace = await createManagedSourceWorkspace(
    context.rootDir,
    'add-'
  );
  const fileOperations = {
    ...defaultSourceAcquisitionFileOperations,
    ...context.acquisitionFileOperations
  };
  const publishRecord = context.createSourceRecord || createSourceRecord;
  let destination;
  let installed = false;

  try {
    const candidate = await acquisition.adapter.prepare(workspace.root);
    assertSameSourceAcquisitionFacts(
      acquisition.factsFingerprint,
      acquisition.projectPlan(candidate),
      acquisition.adapter.stalePlanMessage
    );
    await assertSourceAcquisitionDestinationAvailable({
      rootDir: context.rootDir,
      plan: acquisition.plan,
      adapter: acquisition.adapter
    });
    await assertNoReservedPublicationMarker(candidate.contentRoot);
    destination = await resolveSafeDestination(
      context.rootDir,
      acquisition.plan.installPath
    );
    await installPreparedDirectory({
      preparedRoot: candidate.contentRoot,
      destination,
      fileOperations
    });
    installed = true;

    try {
      await publishRecord(
        context.rootDir,
        acquisition.adapter.buildRecord(acquisition.plan)
      );
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw sourceCollisionError(
          `Source identity was registered while applying: ${acquisition.plan.sourceId}`
        );
      }
      throw error;
    }
  } catch (error) {
    if (installed) {
      await removeFailedPublication(fileOperations, destination, error);
    }
    throw error;
  } finally {
    await removeManagedSourceWorkspace(workspace);
  }
}

async function installPreparedDirectory({
  preparedRoot,
  destination,
  fileOperations
}) {
  try {
    await fileOperations.mkdir(destination);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw sourceCollisionError(
        `Source destination was occupied while applying: ${destination}`
      );
    }
    throw error;
  }

  const markerPath = path.join(destination, SOURCE_INSTALLING_MARKER);
  try {
    await fileOperations.writeFile(
      markerPath,
      SOURCE_INSTALLING_MARKER_CONTENT,
      { flag: 'wx' }
    );
    for (const entry of await fileOperations.readdir(
      preparedRoot,
      { withFileTypes: true }
    )) {
      await fileOperations.rename(
        path.join(preparedRoot, entry.name),
        path.join(destination, entry.name)
      );
    }
    await fileOperations.rm(markerPath);
  } catch (error) {
    await removeFailedPublication(fileOperations, destination, error);
    throw error;
  }
}

async function removeFailedPublication(
  fileOperations,
  destination,
  originalError
) {
  try {
    await fileOperations.rm(destination, { recursive: true, force: true });
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'Source acquisition failed and rollback could not remove partial content'
    );
  }
}

async function resolveSafeDestination(rootDir, installPath) {
  const segments = installPath.split('/');
  const parentSegments = segments.slice(0, -1);
  try {
    const parent = await ensureSourceDirectory(rootDir, ...parentSegments);
    return path.join(parent, segments.at(-1));
  } catch (error) {
    throw new SourceAcquisitionError('source-safety', error.message);
  }
}

async function assertNoReservedPublicationMarker(contentRoot) {
  if (!await sourcePathExists(
    path.join(contentRoot, SOURCE_INSTALLING_MARKER)
  )) {
    return;
  }
  throw new SourceAcquisitionError(
    'source-validation',
    `Source contains reserved publication marker: ${SOURCE_INSTALLING_MARKER}`
  );
}
