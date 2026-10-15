<h1 align="center">ChargerDojo OCPI conformance</h1>

<p align="center">
  Run an OCPI conformance suite from GitHub Actions and fail the build when your partner breaks a rule.
</p>

<p align="center">
  <a href="https://github.com/chargerdojo/ocpi-conformance-action/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/chargerdojo/ocpi-conformance-action?label=release&color=2e7d32"></a>
  <a href="https://docs.chargerdojo.com/guide/run-a-suite"><img alt="Docs" src="https://img.shields.io/badge/docs-run%20a%20suite-0288d1"></a>
  <a href="https://github.com/chargerdojo/ocpi-conformance-action/blob/main/LICENSE"><img alt="Licence" src="https://img.shields.io/badge/licence-MIT-555"></a>
  <a href="https://chargerdojo.com"><img alt="ChargerDojo" src="https://img.shields.io/badge/chargerdojo.com-informational?color=555"></a>
</p>

---

This Action runs a [ChargerDojo](https://chargerdojo.com) conformance suite against an OCPI
endpoint you have registered, waits for the verdict, and turns it into an exit code. It is built
for CPOs, eMSPs and roaming hubs that want to catch a broken OCPI rule in the pull request that
introduced it, before a roaming partner finds it in production.

The suites run on ChargerDojo's servers. The Action starts a run, polls it to the end, prints the
result with a link to the full per-check report, and publishes the counts as step outputs. It has
no dependencies and nothing to install.

## Before you start

You need three things:

1. **A ChargerDojo plan with API keys.** Keys come with the Integrate plan and every plan above it.
   The free sandbox cannot create them. See [Plans and pricing](https://docs.chargerdojo.com/guide/plans).
2. **An API key in a repository or organisation secret.** Create one under **Settings**, then
   **Security**, and save it as `CHARGERDOJO_API_KEY`. See
   [Create an API key](https://docs.chargerdojo.com/guide/create-an-api-key).
3. **A registered connection.** This is the endpoint the suite tests: your partner's, your own, or
   a built-in sandbox peer. `GET https://chargerdojo.com/api/v1/connections` lists yours with their
   ids. See [Connect a partner](https://docs.chargerdojo.com/guide/connect-a-partner). Store the id
   as a repository variable, `CHARGERDOJO_CONNECTION_ID`.

## Usage

```yaml
name: OCPI conformance

on:
  pull_request:
  workflow_dispatch:

jobs:
  conformance:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: chargerdojo/ocpi-conformance-action@v1
        with:
          api_key: ${{ secrets.CHARGERDOJO_API_KEY }}
          connection_id: ${{ vars.CHARGERDOJO_CONNECTION_ID }}
```

The Action needs no checkout and no token permissions. `@v1` follows every compatible release. To
pin an exact version, use `@v1.0.0` or the commit SHA of a release.

### Run one module or scenario

```yaml
- uses: chargerdojo/ocpi-conformance-action@v1
  with:
    api_key: ${{ secrets.CHARGERDOJO_API_KEY }}
    connection_id: ${{ vars.CHARGERDOJO_CONNECTION_ID }}
    module: locations
```

`GET https://chargerdojo.com/api/v1/testing/suites` lists what can run.

### Link the report when the build fails

Every output is written before the step exits, so a later step can read them on a failing run:

```yaml
- id: ocpi
  uses: chargerdojo/ocpi-conformance-action@v1
  with:
    api_key: ${{ secrets.CHARGERDOJO_API_KEY }}
    connection_id: ${{ vars.CHARGERDOJO_CONNECTION_ID }}

- if: failure() && steps.ocpi.outputs.report_url != ''
  run: echo "::notice::OCPI report ${{ steps.ocpi.outputs.report_url }}"
```

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `api_key` | Yes | | A `cdojo_` API key. Pass it from a secret, never as a literal. |
| `connection_id` | Yes | | The registered connection to run against. |
| `module` | No | every suite | One protocol module or scenario. Omit it to run every advertised suite your plan covers for the connection's OCPI version. |
| `seed` | No | a new one | Reuse a seed to send the same requests again, down to the object ids. 1 to 128 characters. |
| `base_url` | No | `https://chargerdojo.com` | The ChargerDojo origin to call. |
| `wait` | No | `55` | Seconds each request holds the connection open waiting for the run. The API caps it at 55. |
| `timeout_minutes` | No | `20` | How long to keep polling before giving up and exiting 2. |

## Outputs

| Output | Meaning |
| --- | --- |
| `report_id` | The report this run produced. |
| `report_url` | Where to read the full per-check report. |
| `status` | The terminal run status: `completed`, `failed`, `cancelled` or `interrupted`. |
| `passed` | Checks that passed. Empty when the run was never graded. |
| `failed` | Checks that failed. Empty when the run was never graded. |

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Everything tested meets the rules OCPI requires. If a module was outside your plan or a check had nothing to grade, the log names it. | Nothing. |
| `1` | At least one required check failed. | Open the report and fix the endpoint, or tell your partner. |
| `2` | No answer: the API refused the call, the run ended without a verdict, the run graded no checks, or the timeout ran out. This says nothing about the endpoint under test. | Read the log line, then run it again. |

Exit 1 and exit 2 are different problems, and the log says which one you have. Only a failed
required check fails the build as exit 1. A warning means the endpoint declined an OCPI
recommendation, which breaks no rule, so warnings never fail the build.

## How it decides

- A `202` from the API means the run is still going. The Action keeps polling until the run
  reaches a terminal status, up to `timeout_minutes`.
- On a `429` it waits as long as `Retry-After` says, with a floor and a bounded number of retries.
- A run that ended without being graded, a run that graded zero checks, and a run that stopped
  early with nothing failing yet all exit 2. Nothing failing is true of a run that asked nothing.
- A pass discloses its scope. Modules your plan does not cover, and checks the response gave
  nothing to grade, are listed in the log as not tested.

The same rules, as a shell script you can run anywhere, are in
[Run a conformance suite](https://docs.chargerdojo.com/guide/run-a-suite#gate-your-build-on-it).

## Security

- The key reaches the script as an environment variable, never on a command line. The Action masks
  it before the first request and never prints it.
- The Action calls `base_url` and nothing else. It sends the key only there.
- It runs on the runner's Node 24 with no dependencies, so the code in this repository is all of
  it.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Help

The guide is at [docs.chargerdojo.com](https://docs.chargerdojo.com/guide/run-a-suite). For
anything else, write to [sales@chargerdojo.com](mailto:sales@chargerdojo.com).
