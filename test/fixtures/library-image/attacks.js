// Byte-faithful #33 attack carriers. Tests prepend a valid manifest/registry so
// rejection cannot pass merely because the library image lacks its required schema.
import { buildTar, paxRecordBlocks, rawHeaderBlock, TAR_END_OF_ARCHIVE } from '../../tarFixtures.js';

export const imageAttacks = [
  ['absolute', [{ name: '/tmp/skillcaddy-image-escape', content: 'attack' }]],
  ['traversal', [{ name: '../escape', content: 'attack' }]],
  ['nested-traversal', [{ name: 'personal/a/../../../escape', content: 'attack' }]],
  ['pax-traversal', [...paxRecordBlocks({ path: '../escape' }), { name: 'safe', content: 'attack' }]],
  ['prefix-traversal', [{ name: 'escape', prefix: '../', content: 'attack' }]],
  ['absolute-hardlink', [{ name: 'personal/alpha/link', typeflag: '1', linkname: '/etc/passwd' }]],
  ['relative-hardlink', [{ name: 'personal/alpha/link', typeflag: '1', linkname: '../outside-target.txt' }]],
  ['fifo', [{ name: 'personal/alpha/fifo', typeflag: '6' }]],
  ['char-device', [{ name: 'personal/alpha/char', typeflag: '3' }]],
  ['block-device', [{ name: 'personal/alpha/block', typeflag: '4' }]],
  ['contiguous', [{ name: 'personal/alpha/contiguous', typeflag: '7' }]],
  ['symlink-first-outside', [{ name: 'personal/alpha/link', typeflag: '2', linkname: '../../../outside' }, { name: 'personal/alpha/link/file', content: 'attack' }]],
  ['symlink-first-inside', [{ name: 'personal/alpha/link', typeflag: '2', linkname: 'dir' }, { name: 'personal/alpha/link/file', content: 'attack' }]],
  ['hardlink-to-symlink', [{ name: 'personal/alpha/link', typeflag: '2', linkname: 'SKILL.md' }, { name: 'personal/alpha/hard', typeflag: '1', linkname: 'personal/alpha/link' }]],
  ['hidden-after-end', [TAR_END_OF_ARCHIVE, ...[buildTar([{ name: 'personal/alpha/hidden', content: 'attack' }])]]],
  ['socket', [{ name: 'personal/alpha/socket', typeflag: 'S' }]],
  ['privileged-mode', [{ name: 'personal/alpha/privileged', mode: 0o4755, content: 'attack' }]],
  ['normalized-traversal', [{ name: 'personal/alpha/dir/../file', content: 'attack' }]],
  ['windows-absolute', [{ name: 'C:\\outside', content: 'attack' }]],
  ['pax-sparse', [...paxRecordBlocks({ 'GNU.sparse.name': '../escape' }), { name: 'personal/alpha/file' }]],
  ['truncated-payload', [rawHeaderBlock('personal/alpha/file', 65536)]],
  ['duplicate-manifest', [{ name: 'library-image.json', content: '{}' }]]
];
