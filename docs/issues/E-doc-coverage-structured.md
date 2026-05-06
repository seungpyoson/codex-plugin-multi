# E — Doc-coverage via structured docstrings (not grep)

**Parent epic:** EPIC-103
**Effort:** ~4 hours
**Blocked on:** nothing
**Why this exists:** v2 spec § 13 proposed `check-contracts-doc-coverage.mjs` that requires every JobRecord/external_review/error_code field to be "mentioned somewhere" in `docs/contracts/`. Both grok and gemini attacked this as theater: "passes for commented-out blocks, deprecated docs, unrelated paragraphs." Replacement: structured JSDoc-style annotations the code generator enforces.

## Acceptance criteria

1. **JSDoc tag convention** documented in `docs/contracts/README.md`. Every exported field/enum value MUST have a `@contract` tag in its source comment, e.g.:

   ```js
   /**
    * @contract job-record.field
    * @field claude_session_id
    * @doc docs/contracts/job-record.md#identity
    * @applies-to claude
    */
   ```

   Or equivalently for enum values:

   ```js
   /**
    * @contract error-code.value
    * @value step_limit_exceeded
    * @doc docs/contracts/job-record.md#error_code-enum
    * @applies-to kimi
    */
   ```

2. `scripts/ci/check-contracts-doc-coverage.mjs` exists. Parses `plugins/*/scripts/lib/*.mjs` and the canonical `scripts/lib/*.mjs` via a JS AST tool (e.g., `acorn` — second devDep, but small and stdlib-style). Extracts every:
   - String literal in arrays exported as `EXPECTED_KEYS` / `EXTERNAL_REVIEW_KEYS` / `GROK_EXPECTED_KEYS` / etc.
   - String literal value in any object literal exported as a `Object.freeze({...})` with values that look like an enum (e.g., `SOURCE_CONTENT_TRANSMISSION`).
   - String literal returned from `classifyExecution()` as the `error_code` field.

3. For each extracted value, the gate requires:
   - The corresponding source file has a `@contract` JSDoc comment that names it.
   - The `@doc` reference points to a real path that exists.
   - The `@doc` path's content (read via fs) actually contains the field name in a structured-docstring section (NOT just any text — must be in a section with a known heading pattern like `### <field-name>` or a table row beginning `\n| <field-name> |`).

4. Wired into `package.json` as `lint:contracts-doc-coverage` and into CI `lint`.

5. **Bootstrap pass:** add the `@contract` annotations for every exported field listed in Layer 1's contracts as part of this issue. The annotation count is bounded — ~41 JobRecord fields × 3 plugins (companion only — synced) + 12 external_review keys + 4 source_content_transmission values + ~12 error_code values × 3 architectures + ~22 grok-specific error_codes + ~11 api-reviewers-specific error_codes ≈ ~250 annotations total. Tedious but bounded.

## Code references

- grok's must-fix on Q11.
- gemini's blind-spot 2: "Dumb-grep illusion."
- Layer 1's docs/contracts/ have the field lists already enumerated; bootstrapping reads from those.
- `acorn` candidate: https://github.com/acornjs/acorn — pure JS, no deps. Alternative: `@babel/parser`. Smaller is better here.

## Out of scope

- Auto-generating the contracts doc from the JSDoc annotations. That's nice-to-have but adds a generator step. For this issue, annotations + manual docs are independently maintained; the gate enforces their alignment.
- TypeScript declaration files. The repo is plain `.mjs`; no TS migration as part of this.

## Why this is materially different from v2's "mention anywhere"

- The check is on the AST, not on regex matches in markdown.
- The annotation must point to a specific doc location, not "documented somewhere."
- The doc location must contain the field name in a structured section, not buried in prose.
- Three failure modes are caught that "mention anywhere" misses: (a) field renamed in code without doc update, (b) doc added but to wrong file, (c) doc has the field name but only in a deprecated/commented-out block.
