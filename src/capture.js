// Run one scenario end to end and produce the record everything else reads.
//
// The two renders happen in two processes on purpose. A single process cannot have `window`
// absent and present at once, cannot be in two timezones, and cannot be honest about a
// `localStorage` guard. Two processes can, and the cost is a few hundred milliseconds.

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './html.js';
import { diffTrees, mismatches } from './diff.js';
import { classify } from './causes.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');

const ROOT_ID = 'root';

// Both sides default to the same locale and timezone, so a scenario that is not about locale
// cannot accidentally get its mismatch from one.
const BASE_ENV = { TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

function run(script, args, { env, input }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [join(repoRoot, script), ...args],
      { env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${script} ${args.join(' ')} failed: ${err.message}\n${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(new Error(`${script} produced unparseable output: ${parseErr.message}\n${stdout.slice(0, 400)}`));
        }
      },
    );
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

const wrapRoot = (html) => `<body><div id="${ROOT_ID}">${html}</div></body>`;

function hasRoot(node) {
  if (node.t === 'el' && node.attrs.id === ROOT_ID) return true;
  return (node.children ?? []).some(hasRoot);
}

export async function captureScenario(scenario, variant) {
  const serverEnv = { ...BASE_ENV, ...(scenario.serverEnv ?? {}) };
  const clientEnv = { ...BASE_ENV, ...(scenario.clientEnv ?? {}) };

  const server = await run('runner/render-server.mjs', [scenario.id, variant], { env: serverEnv });
  const client = await run(
    'runner/render-client.mjs',
    [scenario.id, variant],
    { env: clientEnv, input: server.html },
  );

  const emittedTree = parse(wrapRoot(server.html));
  const parsedTree = parse(client.parsedBody);
  const preHydrationTree = parse(client.preHydrationBody);
  const clientTree = parse(wrapRoot(client.clientRender));
  const postHydrationTree = parse(client.postHydrationBody);

  // Every diff below is scoped to the element with id="root", and an op outside it is reported as
  // harmless. That makes a tree with no #root in it silently clean, which is exactly what
  // happened the first time this ran: the client captured `body.innerHTML` while the server side
  // was wrapped in `<body>`, the two roots never aligned, every op landed outside the root, and a
  // scenario with a live React hydration error reported "no difference". Assert the shape.
  for (const [name, tree] of Object.entries({
    emitted: emittedTree, parsed: parsedTree, preHydration: preHydrationTree,
    client: clientTree, postHydration: postHydrationTree,
  })) {
    if (!hasRoot(tree)) {
      throw new Error(
        `${scenario.id}/${variant}: the ${name} tree has no element with id="${ROOT_ID}". ` +
        'Every diff is scoped to that element, so without it the comparison is vacuous.',
      );
    }
    const top = tree.children.filter((c) => c.t === 'el');
    if (top.length !== 1 || top[0].tag !== 'body') {
      throw new Error(
        `${scenario.id}/${variant}: the ${name} tree does not start at <body> ` +
        `(found ${top.map((c) => c.tag).join(', ') || 'nothing'}). The two sides would not align.`,
      );
    }
  }

  const repair = diffTrees(emittedTree, parsedTree, {
    leftLabel: 'HTML React emitted',
    rightLabel: 'DOM the browser built',
    rootId: ROOT_ID,
  });
  const mutation = diffTrees(parsedTree, preHydrationTree, {
    leftLabel: 'DOM the browser built',
    rightLabel: 'DOM at hydration time',
    rootId: ROOT_ID,
  });
  const hydration = diffTrees(preHydrationTree, clientTree, {
    leftLabel: 'DOM at hydration time',
    rightLabel: 'what the client render produced',
    rootId: ROOT_ID,
  });
  const settled = diffTrees(preHydrationTree, postHydrationTree, {
    leftLabel: 'DOM at hydration time',
    rightLabel: 'DOM after hydration and effects',
    rootId: ROOT_ID,
  });

  const analysis = classify({
    repairDiff: repair,
    mutationDiff: mutation,
    hydrationDiff: hydration,
    emittedTree,
    preHydrationTree,
    serverRecords: server.records,
    clientRecords: client.records,
  });

  return {
    scenario: {
      id: scenario.id,
      title: scenario.title,
      cause: scenario.cause ?? null,
      summary: scenario.summary,
      fix: scenario.fix,
      control: scenario.control === true,
    },
    variant,
    env: { server: server.env, client: client.env },
    html: {
      serverEmitted: server.html,
      parsedBody: client.parsedBody,
      preHydrationBody: client.preHydrationBody,
      clientRender: client.clientRender,
      postHydrationBody: client.postHydrationBody,
    },
    diffs: { repair, mutation, hydration, settled },
    counts: {
      repair: mismatches(repair).length,
      mutation: mismatches(mutation).length,
      mutationAnywhere: mutation.ops.length,
      hydration: mismatches(hydration).length,
      settled: mismatches(settled).length,
    },
    analysis,
    react: client.hydration,
    records: { server: server.records, client: client.records },
  };
}

export { ROOT_ID };
