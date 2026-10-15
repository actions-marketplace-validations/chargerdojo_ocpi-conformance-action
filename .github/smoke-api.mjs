/**
 * A stand-in for `POST /api/v1/testing/runs` and `GET /api/v1/testing/runs/:id`, so CI can run the
 * real GitHub Action end to end without a `cdojo_` key.
 *
 * What the unit suite cannot reach is the runner itself: whether `runs.using: node24` starts the
 * file, whether the runner really supplies `INPUT_*`, and whether a step that exits non-zero still
 * publishes its outputs. Those are facts about GitHub Actions, and the only way to learn them is to
 * let the runner execute the action. Key management is what stops that being a real run, so this
 * serves the two answers the recipe is built around instead.
 *
 * Two verdicts, chosen by `--verdict`: `pass` answers a 202 and then a completed run with no
 * failures, `fail` answers a completed run with two. Nothing here grades anything. It is a fixture
 * for the CI smoke in `chargerdojo/dojo` and, published as `.github/smoke-api.mjs`, for the
 * self-test in `chargerdojo/ocpi-conformance-action`.
 */

import { createServer } from 'node:http';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? ''];
  })
);

const port = Number(args.get('port') ?? 8791);
const verdict = args.get('verdict') ?? 'pass';
const REPORT_ID = 'smoke-report';

const summary =
  verdict === 'fail'
    ? { total: 5, passed: 3, failed: 2, warned: 0 }
    : { total: 5, passed: 5, failed: 0, warned: 1 };

/** How many polls to answer as still running before settling, so the loop is actually exercised. */
let pollsLeft = 1;

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.headers.authorization !== 'Bearer cdojo_smoke') {
    return send(res, 401, { success: false, message: 'Invalid API key' });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/testing/runs') {
    return send(res, 202, {
      success: true,
      data: {
        executionId: 'smoke-execution',
        reportId: REPORT_ID,
        status: 'queued',
        seed: 'smoke',
      },
    });
  }

  if (req.method === 'GET' && url.pathname === `/api/v1/testing/runs/${REPORT_ID}`) {
    if (pollsLeft > 0) {
      pollsLeft -= 1;
      return send(res, 200, { success: true, data: { _id: REPORT_ID, status: 'running' } });
    }
    return send(res, 200, {
      success: true,
      data: { _id: REPORT_ID, status: 'completed', summary },
    });
  }

  return send(res, 404, { success: false, message: 'Report not found' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`action smoke api listening on ${port}, verdict ${verdict}\n`);
});
