# Archived workflows

These are the upstream `latticexyz/mud` GitHub Actions workflows, kept for
reference but moved out of `.github/workflows/` so GitHub does not scan, list,
or run them (Actions only reads the `.github/workflows/` directory). The
Asphodel fork does not run upstream MUD CI (npm publish, benchmarks, e2e,
templates, etc.).

The only active workflow is `.github/workflows/deploy-test.yml` (builds the
indexer + frontend image and deploys to the test ECS services).

To restore one, move it back:

```bash
git mv .github/workflows-archive/<name>.yml .github/workflows/<name>.yml
```

Note: several of these call each other via `uses: ./.github/workflows/<name>.yml`
(workflow_call) — restore the whole set together if you need that chain.
