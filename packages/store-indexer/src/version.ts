import packageJson from "../package.json";

// Build metadata baked into the image at `docker build` time via --build-arg
// (see the repo Makefile and .github/workflows/deploy-test.yml). VERSION is our
// deploy version — version.json baseVersion plus the git patch count. GIT_SHA is
// the commit, BUILD_DATE the build timestamp. When built outside the pipeline
// (plain `pnpm dev`, upstream CI) these env vars are unset and we fall back to
// the upstream package.json version so the field is never empty.
export const versionInfo = {
  version: process.env.VERSION ?? packageJson.version,
  commit: process.env.GIT_SHA ?? "unknown",
  buildDate: process.env.BUILD_DATE ?? "unknown",
} as const;
