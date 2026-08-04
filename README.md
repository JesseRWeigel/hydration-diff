# hydration-diff

Capture the HTML a React server render emitted, the DOM a browser built from it, the DOM at the
instant hydration began, and the tree the client render produced. Diff the four node by node, and
name the cause.

React's hydration error tells you that the trees disagreed. It does not tell you which line made
them disagree, and it does not distinguish "your component read the clock" from "an extension
inserted a div" from "the parser rewrote your markup before React ever saw it". Those are
different bugs with different fixes, and only the first one is in your code.

```
$ node bin/hydration-diff.js run nesting-div-in-p broken
nesting-div-in-p [broken]  <div> inside <p>, repaired by the HTML parser before React sees it
  server: TZ=UTC locale=en-US
  client: TZ=UTC locale=en-US

5 hydration mismatch(es).

Cause:
  Invalid HTML nesting, repaired by the parser before React saw it  [certain]
      <div> inside <p> at body[0] > div#root[0] > article[0] > p[0] > div[0]: <div> is not phrasing content, so the parser closes the paragraph before it and opens a new empty one after it.
      fix: Emit markup the parser will keep. A <p> may only contain phrasing content, and a second <p> closes the first.

First divergence in document order: body[0] > div#root[0] > article[0] > p[0] > div[0]

1. parser repair  (HTML React emitted -> DOM the browser built)
  node at body[0] > div#root[0] > article[0] > p[0] > div[0] exists only in HTML React emitted
      <div class="stat">4.2s</div>
  node at body[0] > div#root[0] > article[0] > p[0] > #text[1] exists only in HTML React emitted
       which is faster than yesterday.
  node at body[0] > div#root[0] > article[0] > div[0] exists only in DOM the browser built
      <div class="stat">4.2s</div>
  node at body[0] > div#root[0] > article[0] > #text[0] exists only in DOM the browser built
       which is faster than yesterday.
  node at body[0] > div#root[0] > article[0] > p[1] exists only in DOM the browser built
      <p></p>

2. mutation before hydration  (DOM the browser built -> DOM at hydration time)
  no difference

3. hydration mismatch  (DOM at hydration time -> what the client render produced)
  node at body[0] > div#root[0] > article[0] > p[0] > div[0] exists only in what the client render produced
      <div class="stat">4.2s</div>
  node at body[0] > div#root[0] > article[0] > p[0] > #text[1] exists only in what the client render produced
       which is faster than yesterday.
  node at body[0] > div#root[0] > article[0] > div[0] exists only in DOM at hydration time
      <div class="stat">4.2s</div>
  node at body[0] > div#root[0] > article[0] > #text[0] exists only in DOM at hydration time
       which is faster than yesterday.
  node at body[0] > div#root[0] > article[0] > p[1] exists only in DOM at hydration time
      <p></p>

After hydration and effects, React updated 5 node(s). That is a
post-hydration render, not a mismatch.

What React itself reported:
  onRecoverableError: Hydration failed because the server rendered HTML didn't match the client. As a result this tree will be regenerated on the client. This can happen if a SSR-...
      innermost component in React's stack: at div (<anonymous>)
  console.error: In HTML, %s cannot be a descendant of <%s>.\nThis will cause a hydration error.%s <div> p \n\n  <BrokenPost>\n    <article className="post">\n>     <p className="lede">\n>       <div className="sta...
```

Nothing in that component is non-deterministic. The server and the client render the identical
string. The mismatch exists because `<div>` is not phrasing content, so the browser closed the
paragraph before it and opened a fresh empty one after it, and React is comparing its tree against
a document nobody wrote. The first diff above is the one that explains it, and it is a diff React
does not perform.

## Four trees, not two

| Tree | Where it comes from |
| --- | --- |
| 1. emitted | The string `renderToString` produced on the server. |
| 2. parsed | What the browser's tree builder made of that string. A different document, if the markup is invalid. |
| 3. at hydration | The DOM at the moment `hydrateRoot` runs, after anything else touched it. |
| 4. client render | The tree the client's own render produces, as authored. |

The mismatch React reports is 3 against 4. The cause may be in 1 against 2 (the parser) or in
2 against 3 (an extension), and in both of those cases every minute spent reading the component is
wasted.

## The causes, and the fixed version of each

18 live runs, 8 of which have a real mismatch. Every cause ships a fixed
counterpart that must report nothing, because a detector that fires on everything is worth less
than no detector.

| Scenario | Cause | Broken variant | Fixed variant | Blamed site |
| --- | --- | --- | --- | --- |
| `random-during-render` | `nondeterministic-random` | 3 mismatches | clean | `scenarios/random-during-render.js:7` |
| `time-during-render` | `nondeterministic-time` | 3 mismatches | clean | `scenarios/time-during-render.js:8` |
| `env-branch` | `environment-branch` | 2 mismatches | clean | `scenarios/env-branch.js:27` |
| `locale-timezone` | `locale-or-timezone` | 2 mismatches | clean | `scenarios/locale-timezone.js:16` |
| `client-storage` | `client-only-storage` | 3 mismatches | clean | `scenarios/client-storage.js:4` |
| `nesting-div-in-p` | `invalid-nesting` | 5 mismatches | clean | structural, no call site |
| `nesting-p-in-p` | `invalid-nesting` | 3 mismatches | clean | structural, no call site |
| `extension-mutation` | `external-dom-mutation` | 1 mismatch | clean | structural, no call site |
| `control-text-separators` | control | n/a | clean | n/a |
| `control-attribute-shapes` | control | n/a | clean | n/a |

That is 7 distinct causes over 8 broken scenarios, plus 2 controls, for 10 scenarios in
total. The controls are there to catch the opposite failure: React writes `<!-- -->`
between adjacent text children and the DOM does not, and React serialises `&#x27;`, `readOnly`
and `style="color:red;font-weight:bold"` where the DOM writes `'`, `readonly` and
`style="color: red; font-weight: bold;"`. A differ that does not fold those away reports a
mismatch on almost every page.

## How the cause is found

Two structural facts and one runtime trap.

**Structural.** If tree 1 and tree 2 differ, the parser repaired something, and the specific
violation is found by walking the emitted tree against the content model (`<div>` inside `<p>`,
`<p>` inside `<p>`, `<li>` inside `<li>`, `<a>` inside `<a>`). If tree 2 and tree 3
differ, something outside the application edited the DOM, and the attribute names are matched
against known extension signatures (`data-lastpass-icon-root`, `data-gramm`,
`cz-shortcut-listen`, `data-1p-*`). Both are proofs rather than inferences.

**Runtime.** `Math.random`, `Date`, `Date.now`, `toLocaleString`, `Intl.DateTimeFormat`,
`localStorage` and `window` are replaced for the duration of the render pass, and every call is
recorded with the file, line and component stack that made it.

`typeof window` looks untrappable, since `typeof` on an undeclared binding cannot throw. But
`window` on the server is not undeclared, it is absent, and an absent global can be defined as an
accessor. `typeof window` then performs an ordinary property get, the getter records the probe,
and returning `undefined` leaves the component on the branch it would have taken anyway.

A recorded call is only reported as a cause when there is a mismatch for it to explain, and only
when it happened during the render pass. The same call inside `useEffect` is correct code and is
listed separately as "noted, not blamed".

```
$ node bin/hydration-diff.js run client-storage broken
client-storage [broken]  localStorage read during render
  server: TZ=UTC locale=en-US
  client: TZ=UTC locale=en-US

3 hydration mismatch(es).

Cause:
  Browser-only storage was read during render  [likely]
      localStorage called during render at scenarios/client-storage.js:4
      server render: 1 call(s), client render: 0 call(s)
      component stack: readTheme < BrokenShell
      fix: Read storage in an effect, or send the value from the server in a cookie.
  Browser-only storage was read during render  [likely]
      localStorage.getItem() called during render at scenarios/client-storage.js:5 (theme)
      server render: 0 call(s), client render: 1 call(s)
      component stack: readTheme < BrokenShell
      fix: Read storage in an effect, or send the value from the server in a cookie.

First divergence in document order: body[0] > div#root[0] > div[0]

1. parser repair  (HTML React emitted -> DOM the browser built)
  no difference

2. mutation before hydration  (DOM the browser built -> DOM at hydration time)
  no difference

3. hydration mismatch  (DOM at hydration time -> what the client render produced)
  attribute class at body[0] > div#root[0] > div[0]
      DOM at hydration time: shell theme-light
      what the client render produced: shell theme-dark
  attribute data-theme at body[0] > div#root[0] > div[0]
      DOM at hydration time: light
      what the client render produced: dark
  text at body[0] > div#root[0] > div[0] > p[0] > #text[0]
      DOM at hydration time: Theme: light
      what the client render produced: Theme: dark

After hydration and effects, React updated 3 node(s). That is a
post-hydration render, not a mismatch.

What React itself reported:
  onRecoverableError: Hydration failed because the server rendered text didn't match the client. As a result this tree will be regenerated on the client. This can happen if a SSR-...
      innermost component in React's stack: at p (<anonymous>)
```

## What React actually says, measured

The premise this started from was that React names the wrong node. Measured against React 19.2,
that is mostly not true, and the honest version is narrower.

| Scenario | React's message | React's innermost frame | The actual first divergence | This tool's blame |
| --- | --- | --- | --- | --- |
| `random-during-render` | text mismatch | `at p (<anonymous>)` | `body[0] > div#root[0] > div[0] > p[0] > #text[0]` | `scenarios/random-during-render.js:7` |
| `time-during-render` | text mismatch | `at time (<anonymous>)` | `body[0] > div#root[0] > div[0] > time[0]` | `scenarios/time-during-render.js:8` |
| `env-branch` | HTML mismatch | `at article (<anonymous>)` | `body[0] > div#root[0] > section[0]` | `scenarios/env-branch.js:27` |
| `locale-timezone` | text mismatch | `at dd (<anonymous>)` | `body[0] > div#root[0] > dl[0] > dd[0] > #text[0]` | `scenarios/locale-timezone.js:16` |
| `client-storage` | text mismatch | `at p (<anonymous>)` | `body[0] > div#root[0] > div[0]` | `scenarios/client-storage.js:4` |
| `nesting-div-in-p` | HTML mismatch | `at div (<anonymous>)` | `body[0] > div#root[0] > article[0] > p[0] > div[0]` | structural |
| `nesting-p-in-p` | HTML mismatch | `at p (<anonymous>)` | `body[0] > div#root[0] > div[0] > p[0] > p[0]` | structural |
| `extension-mutation` | HTML mismatch | `at input (<anonymous>)` | `body[0] > div#root[0] > form[0] > div[0]` | structural |

Three things hold across every run, and each is a passing assertion in
`scripts/assert-scenarios.mjs` rather than a claim in prose:

1. React never names a file or a line. Not in any of the 8 failing runs.
2. React's recoverable error describes a text mismatch and says nothing about attributes.
   `client-storage` diverges on `class` and `data-theme` as well as on text, and React
   mentions neither.
3. On `extension-mutation` React's stack points at the application's own `<input>` inside its
   own `SignIn` component, for a node `SignIn` never rendered.

Credit where it is due: React 19 detects both invalid-nesting cases specifically and names them
correctly ("In HTML, `<div>` cannot be a descendant of `<p>`"). What it does not show is the
resulting tree, which is what makes the follow-on hydration error legible.

## Running it

```
npm install
npm --prefix fixtures/next-app install     # for the real-Next.js corroboration

node bin/hydration-diff.js list
node bin/hydration-diff.js run <scenario> [broken|fixed]
node bin/hydration-diff.js run-all --json

bash scripts/verify.sh
```

Requires Node 20 or newer and Python 3 (for the independent checker).

## How it is verified

- **51 unit tests** over the parser, the alignment, the cause rules and the traps.
- **18 live runs**, each a real server process and a real client process with
  their own `TZ` and locale, a real `renderToString`, and a real `hydrateRoot`. React's own
  `onRecoverableError` is captured on every run and must agree: broken variants make React
  complain, fixed variants make it silent. Where the fix is "do it after mount", the fixed variant
  must also still change the DOM once effects have run, because a fix that deleted the feature
  would otherwise pass the negative control.
- **An independent checker in Python** (`scripts/independent-check.py`) that shares no code with
  the engine. Different language, different HTML parser, different tree, different comparison. It
  re-derives every verdict, and separately checks that each reported value literally occurs in the
  raw bytes of its own side. It found a real defect on its first run: React emits `dateTime` and
  the DOM holds `datetime`.
- **A real browser.** `scripts/check-page.mjs` loads `docs/index.html` in Chromium and asserts
  on nodes only the inline script can have created, on the absence of horizontal overflow at 390px
  measured element by element, and on both dark-mode mechanisms.
- **Real Next.js.** `scripts/next-corroborate.mjs` builds and serves a Next 16 app that imports
  these same scenario modules, reads the DOM back with JavaScript disabled so what it measures is
  the parser and nothing else, confirms Chromium and jsdom build the same tree from the same
  bytes, and confirms real Next.js reports a hydration error on the broken routes and none on the
  fixed ones.
- **Six sabotages** (`scripts/sabotage.sh`), each proved to have changed real output before any
  conclusion is drawn from it: text nodes ignored, attributes ignored, the authored parser made to
  repair like a browser, `&nbsp;` folded into an ordinary space, every text node reported as
  changed, and a cause named on every run.

## Which runtime, and why

The engine runs real `react-dom/server` and real `react-dom/client` in jsdom, and a real
Next.js 16 build in real Chromium corroborates it. Both, rather than one.

jsdom carries the engine because two processes are needed for a single capture, one with `window`
absent and one with it present, in two timezones; a browser cannot be put in the first state at
all. jsdom's parser is parse5, which implements the same specification Chromium does, and
`scripts/next-corroborate.mjs` asserts on every route that the two build an identical tree from
identical bytes rather than assuming it.

The Next.js half exists because the central claim here is about what a *browser's* parser does,
and only a browser can settle that. It runs a production build rather than `next dev`: the dev
overlay installs its own `console.error` handler and the hydration message never reaches the
page, so the check saw nothing on routes that were definitely failing.

## What is not built

- **No in-page overlay and no framework plugin.** This is a capture harness, a diff engine, a
  cause classifier and a CLI. Wiring it into a running Next.js app as a dev-mode overlay, which is
  what the original brief describes, is not done.
- **The component stack comes from JS stack frames**, not from React's owner stack, so it names
  the functions on the call path rather than the React element tree. It is accurate about the file
  and line, which is the part React omits.
- **Attribution is by call site, not by DOM node.** The tool says "this mismatch exists and
  `Math.random()` at `scenarios/x.js:7` ran during both renders". It does not prove that
  specific call produced that specific text node.
- **Eight cause categories.** `crypto.getRandomValues`, `performance.now`, `document.cookie`,
  and a `useId` collision are not trapped; a mismatch caused by one of those is reported as
  `unattributed` with the diff, rather than guessed at.
- **Streaming SSR and Suspense boundaries are not exercised.** The boundary comments are folded
  away by the normaliser, but no scenario produces one.

## Status

```
$ bash scripts/verify.sh
hydration-diff verification
  node v24.13.0, python 3.12.3, repo <repo>/hydration-diff

1. dependencies
  ok    react 19.2.8
  ok    react-dom 19.2.8
  ok    jsdom 26.1.0
  ok    playwright-core 1.58.2
  ok    next 16.2.12 (fixture)

2. unit suite
  ok    51 unit tests pass

3. live scenario runs (two processes each, real render, real hydration)
  ok    84 assertions across 18 live runs
  ok    every non-control scenario ships a broken variant and a fixed one
  ok    7 distinct causes reproduced

4. independent re-derivation (Python, shares no code with the engine)
  ok    6 passed in the independent checker

5. the page, in a real browser
  ok    wrote docs/index.html (89.8 KB, 18 runs)
  ok    19 passed in the browser page check

6. real Next.js and real Chromium
  ok    19 passed against a real Next.js build
        (real Next.js 16.2.12 production build, real Chromium 145.0.7632.6)

7. sabotage: break the engine on purpose and require the checks to notice
  ok    6 passed, 0 failed across 6 sabotages
        ..    text nodes ignored: changed 2 line(s) of real output
        ..    attributes ignored: changed 2 line(s) of real output
        ..    the authored parser repairs like a browser: changed 6 line(s) of real output
        ..    nbsp folded into an ordinary space: changed 2 line(s) of real output
        ..    every text node reported as changed: changed 2 line(s) of real output
        ..    a cause named on every run: changed 9 line(s) of real output

8. hygiene
  ok    no credential-shaped strings in tracked files
  ok    no tracked file contains a NUL byte, so the scans above could read all of them
  ok    no absolute home path in tracked files
  ok    no dependencies or build output are tracked
  ok    no tracked file is over a megabyte
  ok    LICENSE, .gitignore and README.md are present

9. the README is part of the deliverable
  ok    README.md carries a Status section with this script's success line
  ok    README states "51 unit tests", which matches this run
  ok    README states "18 live runs", which matches this run
  ok    README states "7 distinct causes", which matches this run
  ok    README states "10 scenarios", which matches this run
  ok    README contains no placeholder

  26 passed, 0 failed
  hydration-diff: all checks passed
```

## Licence

MIT.
