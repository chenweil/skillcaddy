const fs = require('node:fs/promises');
const os = require('node:os');
const p = require('node:path');

(async () => {
  const NFD = 'café.md'.normalize('NFD');
  const base = await fs.mkdtemp(p.join(os.tmpdir(), 'cp-probe-'));
  const src = p.join(base, 'src');
  const dst = p.join(base, 'dst');
  await fs.mkdir(src);
  await fs.mkdir(dst);
  await fs.writeFile(p.join(src, NFD), 'body');
  await fs.cp(src, dst, { recursive: true });

  const sl = (await fs.readdir(src))[0];
  const dl = (await fs.readdir(dst))[0];

  const { checksumDirectory, checksumDirectoryNormalized } =
    await import('./lib/sourceTree.js');

  const sp = await checksumDirectory(src);
  const dp = await checksumDirectory(dst);
  const dpn = await checksumDirectoryNormalized(dst);

  const out = [
    'platform: ' + process.platform,
    'src readdir len: ' + sl.length + ' isNFD=' + (sl === NFD),
    'dst readdir len: ' + dl.length + ' isNFD=' + (dl === NFD),
    'cp preserved form: ' + (sl === dl),
    'src plain : ' + sp,
    'dst plain : ' + dp,
    'dst normal: ' + dpn,
    'plain match: ' + (sp === dp),
    'src plain === dst normalized: ' + (sp === dpn)
  ].join('\n');

  console.log(out);
})();
