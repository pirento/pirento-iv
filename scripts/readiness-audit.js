/** `npm run audit:readiness` - checks Node version, installed dependencies and the blank .example.env template. */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { inspectExampleTemplate } from './environment-template.js';
const require = createRequire(import.meta.url);
/** Returns { project, node, checkedDependencies, findings[] }; an empty findings list means ready. */
export function auditProject(root = process.cwd()) {
  const findings = [];
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24 || major >= 27 || (major === 24 && Number(process.versions.node.split('.')[1]) < 5))
    findings.push({
      level: 'BLOCKER',
      code: 'NODE_VERSION',
      detail: `Node ${process.version} is outside required ${pkg.engines.node}`,
    });
  for (const name of Object.keys(pkg.dependencies || {})) {
    try {
      require.resolve(`${name}/package.json`, { paths: [root] });
    } catch {
      try {
        require.resolve(name, { paths: [root] });
      } catch {
        findings.push({ level: 'BLOCKER', code: 'DEPENDENCY_MISSING', detail: name });
      }
    }
  }
  const example = join(root, '.example.env');
  if (!existsSync(example))
    findings.push({ level: 'BLOCKER', code: 'ENV_TEMPLATE_MISSING', detail: '.example.env' });
  else
    for (const issue of inspectExampleTemplate(readFileSync(example, 'utf8')))
      findings.push({
        level: 'BLOCKER',
        code: issue.code,
        detail: `Environment template line ${issue.line}`,
      });
  for (const name of ['src', 'tests', 'scripts', 'server.js'])
    if (!existsSync(join(root, name)))
      findings.push({ level: 'BLOCKER', code: 'PROJECT_PATH_MISSING', detail: name });
  const ignored = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : '';
  if (!ignored.split(/\r?\n/).includes('node_modules/'))
    findings.push({ level: 'WARN', code: 'IGNORE_DEPENDENCIES', detail: 'node_modules/' });
  return {
    project: pkg.name,
    node: process.version,
    checkedDependencies: Object.keys(pkg.dependencies || {}).length,
    findings,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename || '')) {
  const result = auditProject();
  console.log(JSON.stringify(result, null, 2));
  if (result.findings.some((f) => f.level === 'BLOCKER')) process.exitCode = 1;
}
