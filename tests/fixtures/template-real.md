<!-- Keep the headings; replace the guidance under each. Short is fine, empty is not. -->

## What and why

<!-- 1-3 sentences: what changes, and the problem it solves. Link the issue if one exists. -->

## How I verified it

<!-- REQUIRED. This repo's rule: state what you ran and what it showed, not "should work".
Paste the command(s) and the relevant output lines. For example:

    cd apps/memo && npx vitest run test/
    -> Tests  165 passed (165)

If you changed shared scripts/, also: node --test 'test/*.test.ts'
If you changed shell, also: shellcheck on the changed files.
If you could NOT verify something (needs production, needs credentials), say so explicitly. -->

## Evidence

<!-- REQUIRED for UI changes: a screenshot or short screen recording of the change,
before/after where it helps. Optional for non-UI changes, but a screenshot of green
test output never hurts. Drag and drop files here. -->

## Checklist

- [ ] I ran the touched app's test suite (and the root suite if I touched `scripts/` or `test/`)
- [ ] I did not weaken or delete an existing test assertion to make this pass
- [ ] New dependencies (if any) are justified in one sentence above
- [ ] If this touches `.github/workflows/`, `scripts/lib/ci.sh`, `apps/*/scripts/build-and-deploy.sh`, or `deploy/`, I read the ask-first note in `CONTRIBUTING.md` and raised it in an issue or discussion first

<!-- New here? docs/onboarding.md is the day-one guide; docs/faq.md answers the common surprises
(first-PR checks wait for maintainer approval; merging does not deploy). -->
