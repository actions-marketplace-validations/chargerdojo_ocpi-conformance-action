# Security

## Reporting a vulnerability

Report it privately through this repository's **Security** tab, under **Report a vulnerability**.
Do not open a public issue. If you cannot use GitHub, write to
[sales@chargerdojo.com](mailto:sales@chargerdojo.com) with "Security" in the subject.

Say which release you ran, what you saw, and how to reproduce it.

## Supported versions

Fixes ship in a new release of the newest major version and move its major tag, so `@v1` carries
them while v1 is the newest major. An older major receives no fixes once a newer one exists. A
pinned `@v1.x.y` or commit SHA does not change: move it to the latest release to pick up a fix.

## Scope

This repository is the Action: `action.yml` and `run-conformance.js`. A problem with the
ChargerDojo service itself, such as the API or the app at chargerdojo.com, is in scope too. Report
it the same way.

## How the Action handles your key

The key arrives as an environment variable, the Action masks it in the job log before its first
request, and it is sent only to `base_url`. Pass it from a secret, never as a literal in a
workflow file.
