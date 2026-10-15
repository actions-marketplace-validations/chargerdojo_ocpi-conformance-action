/**
 * The whole implementation of the ChargerDojo GitHub Action: start a conformance run, poll it to a
 * terminal state, and turn the verdict into an exit code.
 *
 * This is the published polling recipe as executable code. The two shipped shell examples are the
 * contract it implements: `docs/public/guide/quickstart.mdx` owns the loop (a 202 is active work,
 * so keep asking until `data.status` is terminal) and `docs/public/guide/run-a-suite.mdx`
 * § Gate your build on it owns the exit codes (1 when a required check failed, 2 when we never got
 * an answer). Changing the behaviour here without changing those pages ships two contracts.
 *
 * CommonJS, and the `package.json` beside it pins it, so a `"type": "module"` added to an enclosing
 * workspace one day cannot silently change how the runner loads this file. No dependencies: a
 * JavaScript action runs the file as it is committed, with no install step, so anything beyond a
 * Node 24 built-in would have to be vendored.
 *
 * The run statuses below are the product's, not this file's. They are pinned to
 * `apps/backend/src/database/models/report-status.ts` by
 * `apps/backend/src/database/models/action-status-parity.test.ts`, which fails by name when the
 * registry gains a status this script does not classify.
 */

const fs = require('node:fs');

/** Terminal statuses that carry a graded verdict, so the counters can be read. */
const GRADED_TERMINAL_STATUSES = ['completed', 'failed'];

/**
 * Terminal statuses that carry no verdict at all.
 *
 * These say something about our service, never about the partner's endpoint, so they exit 2 with
 * the network errors rather than 1 with a broken endpoint. A run stamped `interrupted` was cut by
 * a server restart and holds no summary; treating its absent counters as zero is how a killed run
 * reads as a pass.
 */
const UNGRADED_TERMINAL_STATUSES = ['cancelled', 'interrupted'];

/** Statuses the run can still move out of, so seeing one means poll again. */
const IN_FLIGHT_STATUSES = ['queued', 'running', 'recovering', 'recovery_required'];

const TERMINAL_STATUSES = [...GRADED_TERMINAL_STATUSES, ...UNGRADED_TERMINAL_STATUSES];

/** A required check failed. The one exit code that is the partner's fault. */
const EXIT_CHECKS_FAILED = 1;
/** We never got an answer: the API refused us, or the run ended without a verdict. */
const EXIT_NO_ANSWER = 2;

const DEFAULT_BASE_URL = 'https://chargerdojo.com';
/** The API clamps `wait` to 55 because the proxy cuts an idle read at 60. */
const MAX_WAIT_SECONDS = 55;
const DEFAULT_TIMEOUT_MINUTES = 20;

/**
 * How long to wait for a rate limit that names no `Retry-After`.
 *
 * Never zero and never derived from the header alone: a 429 whose header is missing, malformed or
 * zero would otherwise be retried immediately, which spins against the ceiling that just refused
 * us and burns the whole budget in one tick.
 */
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 120_000;
/** Retries per request, so a rate limit that never lifts ends in a refusal rather than a loop. */
const MAX_RATE_LIMIT_RETRIES = 3;
/** Gap between polls, on top of the server-side long poll each one already holds open. */
const POLL_GAP_MS = 2_000;
/** Slack over the server-side `wait` before a request is considered hung rather than slow. */
const WAIT_TIMEOUT_MARGIN_SECONDS = 20;
/** Floor on a request ceiling, so a caller already past its deadline still gets one attempt. */
const MIN_REQUEST_TIMEOUT_MS = 5_000;

/** Where the app shows one run, so a failing build links straight to the evidence. */
const RUNS_PAGE_PATH = '/ocpi-testing-tool/runs';
/** The query key that page reads the run id back from. */
const RUN_QUERY_PARAM = 'run';
/** Where the conformance runs live on the public API. */
const RUNS_API_PATH = '/api/v1/testing/runs';

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function isGraded(status) {
  return GRADED_TERMINAL_STATUSES.includes(status);
}

/**
 * Milliseconds to wait after a 429, from the header when it is usable and from the default when
 * it is not. Seconds and an HTTP-date are both legal spellings of `Retry-After`.
 */
function retryAfterMs(header) {
  const parsed = parseRetryAfter(header);
  if (parsed === null) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.max(parsed, MIN_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
}

function parseRetryAfter(header) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds * 1000 : null;
  }
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  const delta = at - Date.now();
  return delta > 0 ? delta : null;
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The inputs a JavaScript action receives, which the runner puts in the environment as
 * `INPUT_<NAME>`. Returns a `problem` sentence rather than throwing, so every refusal reaches the
 * caller through one path.
 */
function readInputs(env) {
  const apiKey = trimmed(env.INPUT_API_KEY);
  const connectionId = trimmed(env.INPUT_CONNECTION_ID);
  if (apiKey === '') {
    return { problem: 'No API key was given. Set api_key to a cdojo_ key from a secret.' };
  }
  if (connectionId === '') {
    return {
      problem: 'No connection was given. Set connection_id to a registered connection id.',
    };
  }

  const baseInput = trimmed(env.INPUT_BASE_URL);
  const baseUrl = (baseInput === '' ? DEFAULT_BASE_URL : baseInput).replace(/\/+$/, '');

  const waitInput = Number(trimmed(env.INPUT_WAIT) || MAX_WAIT_SECONDS);
  if (!Number.isFinite(waitInput) || waitInput < 1) {
    return { problem: `wait must be a number of seconds, got "${env.INPUT_WAIT}".` };
  }
  // Clamped here as well as by the API, so the number in the URL is the number that will be
  // honoured and a reader of the log is not told we asked for something we did not get.
  const wait = Math.min(Math.round(waitInput), MAX_WAIT_SECONDS);

  const timeoutMinutes = Number(trimmed(env.INPUT_TIMEOUT_MINUTES) || DEFAULT_TIMEOUT_MINUTES);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return {
      problem: `timeout_minutes must be a positive number, got "${env.INPUT_TIMEOUT_MINUTES}".`,
    };
  }

  return {
    apiKey,
    connectionId,
    baseUrl,
    wait,
    timeoutMinutes,
    timeoutMs: timeoutMinutes * 60_000,
    module: trimmed(env.INPUT_MODULE),
    seed: trimmed(env.INPUT_SEED),
  };
}

/** So a one-minute timeout does not report itself as "1 minutes". */
function minutesLabel(count) {
  return count === 1 ? '1 minute' : `${count} minutes`;
}

/**
 * One HTTP call, retried only while the API is rate limiting us.
 *
 * Every other status, 2xx included, comes straight back to the caller: this function decides
 * nothing about the run, only about whether we were allowed to ask. Both stopping conditions are
 * needed. The attempt cap ends a ceiling that never lifts, and the deadline stops a long
 * `Retry-After` sleeping past the timeout the caller was promised.
 */
async function callWithRateLimitRetries(ctx, url, init, deadline) {
  let attempt = 0;
  for (;;) {
    // Every request carries its own ceiling, so `timeout_minutes` is a promise rather than a hope.
    // Without one a blackholed connection hangs until the consumer's job-level limit, and a poll
    // begun just inside the deadline can return a full `wait` window after it.
    //
    // Never zero or negative: a caller past the deadline still gets one honest attempt with the
    // minimum, and the loops above stop on the deadline themselves.
    const budgetMs = Math.max(
      Math.min(deadline - ctx.now(), (WAIT_TIMEOUT_MARGIN_SECONDS + MAX_WAIT_SECONDS) * 1000),
      MIN_REQUEST_TIMEOUT_MS
    );
    const response = await ctx.fetch(url, { ...init, timeoutMs: budgetMs });
    if (response.status !== 429) return response;
    if (attempt >= MAX_RATE_LIMIT_RETRIES) return response;
    const delayMs = retryAfterMs(response.headers.get('retry-after'));
    if (ctx.now() + delayMs > deadline) return response;
    attempt += 1;
    ctx.log(
      `Rate limited by the API. Waiting ${Math.round(delayMs / 1000)}s, then retry ${attempt} of ${MAX_RATE_LIMIT_RETRIES}.`
    );
    await ctx.sleep(delayMs);
  }
}

/**
 * One call and its body, or a sentence saying why there was neither.
 *
 * A refused connection, a DNS failure and a request the ceiling above aborted all arrive here as a
 * thrown error. None of them says anything about the partner's endpoint, so each becomes the
 * no-answer exit with a plain sentence rather than a stack trace on a build log.
 */
async function callForText(ctx, url, init, deadline, what) {
  try {
    const response = await callWithRateLimitRetries(ctx, url, init, deadline);
    return { response, text: await response.text() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { problem: `Could not ${what}: ${detail}` };
  }
}

/**
 * The success envelope, or a sentence saying why the answer was not one.
 *
 * A body that is not JSON, an envelope without `success: true`, and a `data` that is absent, null,
 * a string or an array all land here rather than being read as a run. Every one of those has a
 * shape that would otherwise reach `data.status` as `undefined` and read as "not terminal yet".
 */
function readEnvelope(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { problem: 'The API answered something that is not JSON.' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { problem: 'The API answered something that is not a run.' };
  }
  if (body.success !== true) {
    const message = typeof body.message === 'string' ? body.message : 'no message';
    return { problem: `The API refused the call: ${message}` };
  }
  const { data } = body;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { problem: 'The API answered a success envelope with no run in it.' };
  }
  return { data };
}

/** The message an error body carries, for a log line that says what the API actually said. */
function refusalMessage(text) {
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object' && typeof body.message === 'string') return body.message;
  } catch {
    // A non-JSON error body is normal from a proxy; fall through to the raw text.
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'no message';
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

function summaryCount(summary, field) {
  const value = summary?.[field];
  return typeof value === 'number' ? value : null;
}

/**
 * How many checks the run graded: `passed + failed`, and nothing else.
 *
 * The same arithmetic as `gradedCheckCount` in
 * `apps/frontend/src/features/testing/runs/conformanceVerdict.ts`, which is the product's one
 * verdict rule. `warned` overlaps both buckets (a warned check met every SHALL and declined a
 * SHOULD, so it is already counted) and `unobservable` is excluded because nothing graded it.
 *
 * A missing counter reads as zero here rather than as a refusal, which is deliberate: a summary
 * with neither counter graded nothing, and that is the same answer as a summary of zeroes.
 */
function gradedCheckCount(summary) {
  return (summaryCount(summary, 'passed') ?? 0) + (summaryCount(summary, 'failed') ?? 0);
}

/**
 * Turn a terminal run into an exit code.
 *
 * The order of these decisions is the product's verdict rule, not this file's opinion, and it is
 * pinned to `conformanceVerdict.ts` by the tier table in `github-action.test.ts`. Nothing failing
 * is true of a run that asked nothing, so scope is settled before grade at every step:
 *
 * - a status that carries no verdict, and a run that graded zero checks, are both `no-checks`
 *   there and the no-answer exit here;
 * - a real failure outranks everything else, which is `not-compliant`;
 * - a run that stopped EARLY with nothing failing yet is the one case the counters cannot express.
 *   It never finished asking, so the checks it did not reach are unknown rather than clean, and it
 *   belongs with the no-answer group beside `interrupted`;
 * - withheld modules and unobservable checks are `partial-coverage`: a pass, whose scope the log
 *   has to disclose or it claims more than it examined.
 */
function verdictOf(ctx, run, reportUrl) {
  const status = run.status;
  if (!isGraded(status)) {
    ctx.fail(`The run ended as "${status}" and was never graded. Run it again.`);
    return EXIT_NO_ANSWER;
  }

  const stoppedEarly = status === 'failed';
  if (stoppedEarly) {
    const reason =
      typeof run.error === 'string' && run.error !== '' ? run.error : 'no reason given';
    ctx.log(`The run stopped early: ${reason}`);
  }

  // `failed` is what the gate turns on, so its absence is a refusal rather than a zero. `passed`
  // is not: a summary carrying `failed: 3` and no passes is still a run that broke three rules,
  // and refusing it would move a real failure into the bucket the guide keeps separate.
  const failed = summaryCount(run.summary, 'failed');
  if (failed === null) {
    ctx.fail('The run reported no results to read. Treat this as no answer, not as a pass.');
    return EXIT_NO_ANSWER;
  }

  if (gradedCheckCount(run.summary) === 0) {
    ctx.fail(
      'The run graded no checks, so nothing is proved. Treat this as no answer, not a pass.'
    );
    return EXIT_NO_ANSWER;
  }

  if (failed > 0) {
    const rules = failed === 1 ? 'required check' : 'required checks';
    ctx.fail(`OCPI conformance: ${failed} ${rules} failed. Report: ${reportUrl}`);
    return EXIT_CHECKS_FAILED;
  }

  if (stoppedEarly) {
    ctx.fail(
      'The run stopped before it finished, with nothing failing yet. That is not a pass: the checks it never reached are untested. Run it again.'
    );
    return EXIT_NO_ANSWER;
  }

  const passed = summaryCount(run.summary, 'passed') ?? 0;
  const scope = untestedScope(run);
  if (scope !== '') {
    ctx.log(
      `OCPI conformance: everything tested meets the rules OCPI requires (${passed} checks passed). Not tested: ${scope}. Report: ${reportUrl}`
    );
    return 0;
  }
  ctx.log(`OCPI conformance: compliant. ${passed} checks passed. Report: ${reportUrl}`);
  return 0;
}

/**
 * What a passing run did not examine, in the words the report uses.
 *
 * Two routes to the same fact: a module the plan did not cover never ran, and an unobservable
 * check decided nothing because the peer's response carried nothing to grade or the module was
 * never advertised. Neither is the partner's fault and neither is a pass, so both are disclosed.
 */
function untestedScope(run) {
  const parts = [];
  const withheld = Array.isArray(run.withheldModules) ? run.withheldModules : [];
  if (withheld.length > 0) parts.push(withheld.join(', '));
  const unobservable = summaryCount(run.summary, 'unobservable') ?? 0;
  if (unobservable > 0) {
    parts.push(`${unobservable} ${unobservable === 1 ? 'check' : 'checks'} nothing could grade`);
  }
  return parts.join('; ');
}

/**
 * Start a run, poll it to a terminal state, publish the outputs and answer with an exit code.
 *
 * Every dependency on the outside world is in `ctx`, so the suite that covers this drives the real
 * function rather than a copy of its loop.
 */
async function runConformance(ctx) {
  const inputs = readInputs(ctx.env);
  if (inputs.problem) {
    ctx.fail(inputs.problem);
    return EXIT_NO_ANSWER;
  }

  // Masked before the key is used for anything, so a key handed in from a plain variable rather
  // than a secret is still redacted from this job's log.
  ctx.mask(inputs.apiKey);

  const headers = {
    Authorization: `Bearer ${inputs.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const body = { connectionId: inputs.connectionId };
  if (inputs.module !== '') body.module = inputs.module;
  if (inputs.seed !== '') body.seed = inputs.seed;

  const deadline = ctx.now() + inputs.timeoutMs;

  const start = await callForText(
    ctx,
    `${inputs.baseUrl}${RUNS_API_PATH}?wait=${inputs.wait}`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    deadline,
    'reach ChargerDojo to start the run'
  );
  if (start.problem) {
    ctx.fail(start.problem);
    return EXIT_NO_ANSWER;
  }
  if (!start.response.ok) {
    ctx.fail(startCallRefusal(start.response.status, start.text));
    return EXIT_NO_ANSWER;
  }
  const startedEnvelope = readEnvelope(start.text);
  if (startedEnvelope.problem) {
    ctx.fail(startedEnvelope.problem);
    return EXIT_NO_ANSWER;
  }

  let run = startedEnvelope.data;
  const reportId = typeof run.reportId === 'string' ? run.reportId : '';
  if (reportId === '') {
    ctx.fail('The API accepted the run but named no report to read. Treat this as no answer.');
    return EXIT_NO_ANSWER;
  }
  const reportUrl = `${inputs.baseUrl}${RUNS_PAGE_PATH}?${RUN_QUERY_PARAM}=${encodeURIComponent(reportId)}`;
  ctx.setOutput('report_id', reportId);
  ctx.setOutput('report_url', reportUrl);
  ctx.log(`Run started. Report: ${reportUrl}`);

  const pollUrl = `${inputs.baseUrl}${RUNS_API_PATH}/${encodeURIComponent(reportId)}?wait=${inputs.wait}`;
  while (!isTerminal(run.status)) {
    // A status in neither list means the product added one and this copy of the action predates
    // it. Refusing beats polling something that may already be settled: a consumer pinned to an
    // old release sees a sentence naming the status, not a build that hangs until its timeout.
    if (!IN_FLIGHT_STATUSES.includes(run.status)) {
      ctx.setOutput('status', String(run.status ?? ''));
      ctx.fail(
        `The API reported a run status this action does not know: "${run.status}". Treat this as no answer, and update the action.`
      );
      return EXIT_NO_ANSWER;
    }
    if (ctx.now() >= deadline) {
      ctx.setOutput('status', String(run.status ?? ''));
      ctx.fail(
        `The run was still "${run.status}" after ${minutesLabel(inputs.timeoutMinutes)}. Treat this as no answer, not as a failure.`
      );
      return EXIT_NO_ANSWER;
    }
    await ctx.sleep(POLL_GAP_MS);
    const poll = await callForText(
      ctx,
      pollUrl,
      { method: 'GET', headers },
      deadline,
      'read the run'
    );
    if (poll.problem) {
      ctx.fail(poll.problem);
      return EXIT_NO_ANSWER;
    }
    if (!poll.response.ok) {
      ctx.fail(
        `Could not read the run (HTTP ${poll.response.status}): ${refusalMessage(poll.text)}`
      );
      return EXIT_NO_ANSWER;
    }
    const envelope = readEnvelope(poll.text);
    if (envelope.problem) {
      ctx.fail(envelope.problem);
      return EXIT_NO_ANSWER;
    }
    run = envelope.data;
  }

  ctx.setOutput('status', String(run.status));
  ctx.setOutput('passed', String(summaryCount(run.summary, 'passed') ?? ''));
  ctx.setOutput('failed', String(summaryCount(run.summary, 'failed') ?? ''));
  return verdictOf(ctx, run, reportUrl);
}

/**
 * What to say about a start call the API refused.
 *
 * 503 gets its own sentence because it is a statement about our runner and never a verdict about
 * the partner, and a build log that conflates the two sends somebody to debug a working endpoint.
 */
function startCallRefusal(status, text) {
  const message = refusalMessage(text);
  if (status === 503) {
    return `ChargerDojo could not take the run right now (HTTP 503): ${message}. This says nothing about your endpoint.`;
  }
  if (status === 429) {
    return `ChargerDojo is rate limiting this account (HTTP 429): ${message}. Retry when the ceiling clears.`;
  }
  return `Could not start the run (HTTP ${status}): ${message}`;
}

/** Append one output for the workflow, the way a JavaScript action publishes them. */
function appendOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  // The heredoc form, because a report url or an error sentence can contain anything.
  const delimiter = `ghadelim_${name}_${Date.now()}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function defaultContext() {
  return {
    env: process.env,
    fetch: (url, { timeoutMs, ...init }) =>
      globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => process.stdout.write(`${line}\n`),
    fail: (line) => process.stdout.write(`::error::${line}\n`),
    mask: (secret) => process.stdout.write(`::add-mask::${secret}\n`),
    setOutput: appendOutput,
  };
}

module.exports = {
  GRADED_TERMINAL_STATUSES,
  UNGRADED_TERMINAL_STATUSES,
  IN_FLIGHT_STATUSES,
  TERMINAL_STATUSES,
  EXIT_CHECKS_FAILED,
  EXIT_NO_ANSWER,
  MAX_RATE_LIMIT_RETRIES,
  DEFAULT_RETRY_AFTER_MS,
  RUNS_PAGE_PATH,
  RUN_QUERY_PARAM,
  RUNS_API_PATH,
  MAX_WAIT_SECONDS,
  retryAfterMs,
  runConformance,
};

if (require.main === module) {
  runConformance(defaultContext())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // A thrown error here is a network failure or a bug in this file. Either way the build
      // learned nothing about the partner, so it exits with the "no answer" code.
      const detail = error instanceof Error ? error.message : String(error);
      process.stdout.write(`::error::The conformance run could not be completed: ${detail}\n`);
      process.exitCode = EXIT_NO_ANSWER;
    });
}
