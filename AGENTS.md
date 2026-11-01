---
created_on: 2026-10-30 20:07
last_modified: 2026-10-31 20:09
status: current
---

# Package and release instructions

Publish `@alexgorbatchev/signalsmith-stretch` from the repository root. The root `package.json` owns the version, exports, and package allowlist; `web/release` contains generated artifacts, not a separate npm package.

## Version policy

- Match the major and minor numbers of the adopted upstream web/DSP baseline recorded in `UPSTREAM.md`. Do not adopt a newer upstream version number without integrating and qualifying that baseline.
- Increment the fork's patch number for each stable release within that major/minor line, independently of upstream patch numbers. For example, `1.3.3` is followed by `1.3.4`; adopting upstream `1.4` starts the `1.4.0` line. Never reuse a published version.
- Use prerelease suffixes only for explicitly designated prereleases. Publish stable releases to `latest` and prereleases to `next`.
- Describe this as upstream-tracking versioning, not strict Semantic Versioning for the fork API. Document API changes in release notes and recommend exact version pins for controlled upgrades.
- Keep the README's primary install command on the stable channel. State when initial publication is still required; use `@next` only for optional prerelease installation.

## Required checks

Use Node.js 22 or newer, npm, and GNU Make. Run from the repository root:

1. `npm ci --ignore-scripts --registry=https://registry.npmjs.org`
2. `npm run build`
3. `npm test`
4. `npm run test:package`
5. Commit source and generated changes together, then run `git diff --exit-code -- web/release` to confirm no generated changes remain.

The build deliberately reuses checked-in WASM. Read [UPSTREAM.md](UPSTREAM.md) before changing the DSP or recompiling it. Package tests install a real tarball, check ESM/CommonJS factories, and compile both declaration formats. `npm pack` runs the build through `prepack`; local `npm publish` runs the checks through `prepublishOnly`.

## npm account setup

1. Verify ownership of the npm scope and whether the package already exists. Use `npm view @alexgorbatchev/signalsmith-stretch version --registry=https://registry.npmjs.org`; investigate authentication or network errors rather than treating every failure as an absent package.
2. For an absent package, authenticate with `npm login` and bootstrap an explicitly authorized publication from the root: `npm publish --access public --tag next` for a prerelease, or `--tag latest` for a stable version. Complete interactive authentication when required. Do not republish that version from GitHub.
3. Create the GitHub environment `npm` in `alexgorbatchev/signalsmith-stretch`.
4. Configure the npm package's GitHub Actions trusted publisher with owner `alexgorbatchev`, repository `signalsmith-stretch`, workflow filename `release.yml`, and environment `npm`. Enable direct `npm publish`. The workflow uses OIDC and does not require an `NPM_TOKEN` secret.
5. Check the current [npm trusted publishing requirements](https://docs.npmjs.com/trusted-publishers/) for setup expiry and runtime requirements. Complete the first publication before the configuration expires; recreate an expired configuration before retrying.

## Publish through GitHub

1. Choose an unused version under the version policy above and run `npm version <version> --no-git-tag-version`. Commit both `package.json` and `package-lock.json`. Verify npm availability before describing a version or channel as installable in the README.
2. Run the required checks above. Optionally verify local lifecycle behavior with `npm publish --dry-run --tag next` for a prerelease, or `--tag latest` for a stable version. A dry-run does not verify publishing credentials.
3. Push the verified release commit to the established remote and confirm its GitHub checks pass. The commit must include [.github/workflows/release.yml](.github/workflows/release.yml).
4. Publish a GitHub Release whose tag is exactly `v<package.json version>` and points at the verified commit. Mark it as a prerelease if and only if the version has a prerelease suffix. A draft release or tag push alone does not publish to npm.
5. Monitor `Publish npm package`. It validates the tag and prerelease status with [scripts/checkRelease.mjs](scripts/checkRelease.mjs), runs build and package checks on Node.js 24, rejects generated-file drift, and publishes with `next` for prereleases or `latest` for stable releases. Its `--ignore-scripts` publish flag is paired with explicit preceding checks; do not use it to bypass local validation.
6. Verify the exact version with `npm view @alexgorbatchev/signalsmith-stretch@<version> version --registry=https://registry.npmjs.org` and verify its channel with `npm view @alexgorbatchev/signalsmith-stretch dist-tags --registry=https://registry.npmjs.org`. Report the version, channel, release commit, workflow result, and any remaining setup blocker.

## Failure recovery and authorization

- Before retrying, query npm for partial success. Published versions are immutable; changes to an already-published package require a new version.
- For OIDC failures, check the exact owner, repository, workflow filename, environment, publish permission, configuration expiry, and `id-token: write` permission. Never commit tokens or credentials.
- Use existing authorization for routine task-owned commits and pushes. Do not publish release tags, GitHub Releases, npm packages, or production deployments without explicit user authorization for that publication. Once authorized, proceed without repeated confirmation.
- If account access or interactive authentication is missing, report the exact required user action and continue independent preparation. Do not claim a dry-run or passing tests proves publication.

## Behavior-change testing

For executable behavior changes, add or update meaningful behavioral tests. Require at least 90% line and function coverage across each affected first-party package's non-test source, including unexecuted files and excluding `scripts/`. Configure and document the coverage command, source scope, metrics, and exclusions; do not weaken gates or add token tests. Reproduce blocking baseline failures on the untouched base before the smallest necessary prerequisite repair.

Run `npm run test:coverage` for the executable coverage gate. It checks every first-party JavaScript source directly in `web/`, including unexecuted files, at 90% lines and functions per file. See the maintainer guide for source scope and exclusions. Preserve the existing build, behavioral, consumer, and generated-file checks.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the maintainer guide. Keep standing instructions current in place; exclude task history, progress reports, and handoff notes.
