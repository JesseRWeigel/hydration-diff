// Render a capture as text. The product is something a person reads while debugging, so the
// output leads with the cause and the line, then shows the diff that proves it.

import { mismatches } from './diff.js';
import { CAUSE_TITLES, CAUSE_FIXES } from './causes.js';

const clip = (s, n = 90) => {
  if (s === null || s === undefined) return '(absent)';
  const one = String(s).replace(/\n/g, '\\n');
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
};

function opLine(op, labels) {
  const where = op.path === '' ? '(root)' : op.path;
  switch (op.kind) {
    case 'text-changed':
      return [`  text at ${where}`, `      ${labels.left}: ${clip(op.left)}`, `      ${labels.right}: ${clip(op.right)}`];
    case 'attr-changed':
      return [`  attribute ${op.attr} at ${where}`, `      ${labels.left}: ${clip(op.left)}`, `      ${labels.right}: ${clip(op.right)}`];
    case 'attr-only-left':
      return [`  attribute ${op.attr} at ${where} exists only in ${labels.left}`, `      value: ${clip(op.left)}`];
    case 'attr-only-right':
      return [`  attribute ${op.attr} at ${where} exists only in ${labels.right}`, `      value: ${clip(op.right)}`];
    case 'node-only-left':
      return [`  node at ${where} exists only in ${labels.left}`, `      ${clip(op.left, 120)}`];
    case 'node-only-right':
      return [`  node at ${where} exists only in ${labels.right}`, `      ${clip(op.right, 120)}`];
    case 'tag-changed':
      return [`  element at ${where} is <${op.left}> in ${labels.left} and <${op.right}> in ${labels.right}`];
    default:
      return [`  ${op.kind} at ${where}`];
  }
}

function stage(title, result, { includeOutside = false } = {}) {
  const ops = includeOutside ? result.ops : mismatches(result);
  const lines = [];
  lines.push(`${title}  (${result.leftLabel} -> ${result.rightLabel})`);
  if (ops.length === 0) {
    lines.push('  no difference');
    return lines;
  }
  for (const op of ops) {
    const rendered = opLine(op, { left: result.leftLabel, right: result.rightLabel });
    // The scope note belongs on the heading line only; repeating it on every value line was
    // noise that made a two-line op look like two ops.
    if (op.scope === 'outside-root') rendered[0] += '   [outside the hydration root]';
    for (const line of rendered) lines.push(line);
  }
  return lines;
}

export function reportText(capture) {
  const out = [];
  const { scenario, variant, counts, analysis, react } = capture;
  out.push(`${scenario.id} [${variant}]  ${scenario.title}`);
  out.push(`  server: TZ=${capture.env.server.timeZone} locale=${capture.env.server.locale}`);
  out.push(`  client: TZ=${capture.env.client.timeZone} locale=${capture.env.client.locale}`);
  out.push('');

  if (counts.hydration === 0) {
    out.push('No hydration mismatch.');
  } else {
    out.push(`${counts.hydration} hydration mismatch(es).`);
  }
  out.push('');

  if (analysis.causes.length > 0) {
    out.push('Cause:');
    for (const cause of analysis.causes) {
      out.push(`  ${CAUSE_TITLES[cause.id] ?? cause.id}  [${cause.confidence}]`);
      for (const line of cause.evidence) out.push(`      ${line}`);
      out.push(`      fix: ${CAUSE_FIXES[cause.id] ?? 'unknown'}`);
    }
    out.push('');
  }

  if (analysis.firstDivergence) {
    out.push(`First divergence in document order: ${analysis.firstDivergence.path || '(root)'}`);
    out.push('');
  }

  out.push(...stage('1. parser repair', capture.diffs.repair));
  out.push('');
  out.push(...stage('2. mutation before hydration', capture.diffs.mutation, { includeOutside: true }));
  out.push('');
  out.push(...stage('3. hydration mismatch', capture.diffs.hydration));
  out.push('');

  // Not a stage of the comparison, but the thing people confuse with one. A correct fix moves the
  // client-only work into an effect, so the DOM changes after hydration. That change is not a
  // mismatch, and saying so out loud stops the fixed version looking like a deleted feature.
  if (counts.settled > 0) {
    out.push(`After hydration and effects, React updated ${counts.settled} node(s). That is a`);
    out.push('post-hydration render, not a mismatch.');
    out.push('');
  }

  out.push('What React itself reported:');
  if (react.recoverable.length === 0 && react.consoleErrors.length === 0) {
    out.push('  nothing');
  } else {
    for (const err of react.recoverable) {
      out.push(`  onRecoverableError: ${clip(err.message, 160)}`);
      if (err.componentStack) {
        const innermost = err.componentStack.split('\n').map((s) => s.trim()).filter(Boolean)[0];
        out.push(`      innermost component in React's stack: ${innermost}`);
      }
    }
    for (const err of react.consoleErrors.slice(0, 2)) {
      out.push(`  console.error: ${clip(err, 200)}`);
    }
  }

  if (analysis.notes.length > 0) {
    out.push('');
    out.push('Noted, not blamed:');
    for (const note of analysis.notes) {
      for (const line of note.evidence) out.push(`  ${line}`);
    }
  }

  return out.join('\n');
}
