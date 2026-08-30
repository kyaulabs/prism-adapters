# CI and Back-Merge Automation Specification

**Date:** 2026-08-29
**Status:** Approved

## Purpose

Add repository-level continuous integration and automatic back-merge pull-request creation so protected branch changes are tested before and after integration and `main` cannot silently remain ahead of `develop`.

## Scope

This change adds two independent GitHub Actions workflows:

1. read-only continuous integration for protected branches and their pull requests;
2. bounded creation of a human-merged `main` to `develop` back-merge pull request after a pull request is merged into `main`.

It does not publish releases, create tags, push branches, approve or merge pull requests, alter catalogue signing, or activate catalogue publication.

## Continuous Integration

Create `.github/workflows/ci.yml`.

The workflow runs for:

- pushes to `develop`;
- pushes to `main`;
- pull requests targeting `develop`;
- pull requests targeting `main`.

It uses a non-cancelling concurrency key derived from the workflow and ref so separate branch or pull-request runs do not cancel one another. Workflow and job permissions are read-only `contents`. The job runs on an Ubuntu-hosted runner with a ten-minute timeout, checks out the exact event revision without persisted credentials, installs Node.js 22.19.0, runs `npm ci`, and runs `npm test`.

The workflow uses the immutable checkout and setup-node action revisions already reviewed in `catalogue-signing.yml`. It receives no secrets, has no mutation permission, and does not upload artifacts, use caches, or invoke production catalogue commands.

## Back-Merge Pull Request

Create `.github/workflows/back-merge.yml`.

The workflow runs when a pull request targeting `main` is closed. Its job proceeds only when GitHub reports that the pull request was merged. It uses one non-cancelling concurrency group and grants only:

- `contents: read` for branch comparison;
- `pull-requests: write` for listing and creating pull requests.

The workflow uses the built-in `GITHUB_TOKEN`, performs no checkout, and executes no repository code. It:

1. compares `develop...main` through the GitHub API;
2. exits successfully when `main` has no commits ahead of `develop`;
3. lists open pull requests with base `develop` and head `main`;
4. exits successfully when such a pull request already exists;
5. otherwise opens one pull request titled `Back-merge main into develop` whose body states that automation opened it and human review and merge are required.

If another run creates the same pull request between inspection and creation, an explicit already-existing response is idempotent success. Comparison failure, listing failure, or any other creation failure terminates the workflow without further mutation.

The workflow never pushes a branch, updates a ref, force-pushes, approves, merges, enables auto-merge, or closes a pull request. Human maintainers remain the only merge authority.

## Repository Administration Prerequisite

A human administrator must enable the repository setting that allows GitHub Actions to create pull requests. If the setting is disabled, pull-request creation fails closed and the workflow reports the error.

The built-in token may suppress workflows that would otherwise be caused by its pull-request creation. The dedicated CI workflow tests the exact `main` head SHA through its independent push trigger before that SHA can be merged back into `develop`; ordinary pull requests trigger CI directly. Changing the back-merge authentication boundary to make generated events trigger additional workflows is outside this specification and would require separate review.

## Testing

Add workflow contract tests using Node's built-in test runner. Tests must require:

- exact CI push and pull-request branch filters;
- read-only CI permissions;
- non-cancelling concurrency;
- immutable action pins, Node.js 22.19.0, `npm ci`, and `npm test`;
- no CI secrets, artifacts, caches, or mutation permissions;
- exact back-merge trigger and merged-event gate;
- `contents: read` plus `pull-requests: write` as the back-merge authority;
- exact `main` to `develop` comparison and pull-request direction;
- no-op handling for an up-to-date branch and an existing open pull request;
- concurrent duplicate creation as idempotent success;
- fail-closed handling of other API failures;
- absence of checkout, pushes, ref updates, force operations, approvals, merges, auto-merge, and pull-request closure.

The full `npm test` suite and repository `/check` gate must pass before review.

## Acceptance Criteria

1. Every push to `develop` or `main` runs the complete locked Node test suite.
2. Every ordinary pull request targeting `develop` or `main` runs that suite before merge; an automated `main` to `develop` back-merge uses the CI result produced for its exact `main` head SHA by the independent push trigger.
3. A merged pull request into `main` causes one open `main` to `develop` back-merge pull request when `main` is ahead.
4. No pull request is created when `develop` already contains `main` or an open back-merge pull request exists.
5. Overlapping runs cannot create conflicting back-merge state; an exact duplicate race is accepted as success.
6. Automation cannot push, merge, approve, close, or otherwise integrate protected-branch changes.
7. Workflow authority is limited to read-only contents and back-merge pull-request creation.
8. Human review and merge remain required for every back-merge pull request.

## Alternatives Considered

### Dedicated GitHub App

A dedicated App token could allow generated pull-request events to trigger additional workflows. It is not selected because this first automation slice does not justify another long-lived credential, installation, custody path, and rotation procedure.

### Back-merge on every push to `main`

A raw push trigger would also observe merged changes, but the closed pull-request event provides explicit merged-PR provenance and matches Prism's established back-merge pattern. Protected `main` remains pull-request-only.

### Manual back-merges

Manual creation avoids workflow mutation authority but leaves branch synchronization dependent on memory and has already allowed `main` to remain outside `develop` history.

## Further Notes

This is repository automation, not catalogue publication. It does not change the supported-adapter catalogue, the protected signing environment, or the catalogue publication transaction.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
