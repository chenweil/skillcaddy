import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {
  buildComparison,
  parseArgs,
  summarizeCollection
} = require('../skills/skillcaddy-manager/scripts/check-conflicts.cjs');

test('parses an explicit comparison set without built-in collection names', () => {
  assert.deepEqual(
    parseArgs(['candidate', '--against', 'existing-a,existing-b']),
    { collectionId: 'candidate', against: ['existing-a', 'existing-b'] }
  );
});

test('summarizes the fields needed for semantic overlap review', () => {
  assert.deepEqual(summarizeCollection({
    id: 'review-suite',
    name: 'Review Suite',
    reason: 'Review code and architecture changes.',
    tags: ['Quality'],
    skills: ['code-review', 'architecture-review']
  }), {
    id: 'review-suite',
    name: 'Review Suite',
    description: 'Review code and architecture changes.',
    tags: ['Quality'],
    capabilities: ['code-review', 'architecture-review']
  });
});

test('compares only the current collections supplied by the caller', () => {
  const result = buildComparison([
    collection('candidate', 'Build and test applications.', ['build', 'test']),
    collection('existing-a', 'Test and debug applications.', ['test', 'debug']),
    collection('existing-b', 'Export PDF documents.', ['pdf-export'])
  ], 'candidate', ['existing-a']);

  assert.equal(result.candidate.id, 'candidate');
  assert.deepEqual(result.comparisons.map(item => item.id), ['existing-a']);
  assert.equal(result.comparisons[0].description, 'Test and debug applications.');
});

test('requires every requested comparison collection to exist', () => {
  assert.throws(
    () => buildComparison([collection('candidate', '', [])], 'candidate', ['missing']),
    /Unknown comparison collection: missing/
  );
});

function collection(id, reason, skills) {
  return { id, name: id, reason, tags: [], skills };
}
