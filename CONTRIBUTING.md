# Development

Use Node.js 22 or newer, npm, and GNU Make. The checked-in WASM payload is reused for wrapper builds; consumers do not need Make or Emscripten.

1. Run `npm ci --ignore-scripts --registry=https://registry.npmjs.org`.
2. Run `npm run build` to regenerate the ESM, CommonJS, standalone browser, and declaration artifacts in `web/release`.
3. Run `npm test` for source and embedded-WASM behavior.
4. Run `npm run test:package` to pack the repository root, install the tarball into an isolated consumer, invoke both factories, and compile ESM/CommonJS TypeScript consumers.
5. Commit generated artifacts alongside their sources. CI rejects differences after rebuilding.

`npm pack` builds automatically through `prepack`. Local `npm publish` also runs the behavioral and installed-package checks through `prepublishOnly`. The package's explicit file allowlist excludes development sources and dependencies.

See [UPSTREAM.md](UPSTREAM.md) before recompiling the embedded WASM. The native C++ API is documented in [CPP.md](CPP.md).

# npm publishing setup

The package is `@alexgorbatchev/signalsmith-stretch`. Publishing requires ownership of that npm scope.

1. If the package does not exist, run `npm login` and publish the first checked version locally with `npm publish --access public --tag next` for a prerelease, or `--tag latest` for a stable version. Complete npm's authentication prompts. Do not publish the same version again from GitHub.
2. Create the GitHub environment `npm` in `alexgorbatchev/signalsmith-stretch`.
3. In the npm package settings, configure a GitHub Actions trusted publisher with owner `alexgorbatchev`, repository `signalsmith-stretch`, workflow `release.yml`, and environment `npm`. Allow direct `npm publish`. No repository `NPM_TOKEN` is required.
4. Complete the first GitHub publication within npm's configuration validity window (currently two days); recreate an expired configuration before retrying.

The workflow uses Node.js 24 and npm's OIDC authentication. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for requirements and configuration troubleshooting.

# Release from GitHub

1. Change the root version with `npm version <version> --no-git-tag-version`, using an explicit unused version such as `1.3.3-dev.3`. This updates both manifest and lockfile. Keep the README installation tag aligned with whether the package has a stable release.
2. Run the development checks above, commit the manifest, lockfile, and generated artifacts, and push the release commit after the repository's required checks pass.
3. Create and publish a GitHub Release with tag `v<version>` pointing at that commit. Mark versions containing a prerelease suffix as a GitHub prerelease. The tagged commit must contain `.github/workflows/release.yml`.
4. Inspect the `Publish npm package` workflow. It rejects version/tag or prerelease mismatches, builds and tests the package, checks generated artifacts, and publishes stable versions to `latest` and prereleases to `next`.
5. Verify the published version with `npm view @alexgorbatchev/signalsmith-stretch@<version> version --registry=https://registry.npmjs.org`.

A tag push alone does not publish. A failed authentication requires checking the trusted publisher's exact repository, filename, environment, permissions, and expiry. Before rerunning a failed job, check npm for partial success: published versions are immutable, so an already-published version requires a new version for further changes.
