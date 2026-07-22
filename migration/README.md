# Frontmatter migration

The migration is intentionally split from any path move. It scans only the explicitly selected content directory, preserves every Markdown/MDX body byte-for-byte, and writes JSON reports under `migration/reports/`.

## Commands

The active target is the bundled `content-repo/` tree. Rebuild it once from the untouched legacy `content/` and `pipeline/` sources with:

```powershell
node migration/materialize-content-repo.js
node migration/migrate-social-images.js
```

Run migration commands from the repository root:

```powershell
node migration/frontmatter-migrate.js inventory
node migration/frontmatter-migrate.js dry-run
node migration/frontmatter-migrate.js apply --branch migration/frontmatter-contracts
node migration/frontmatter-migrate.js validate
```

With no command, the tool runs `dry-run`. Its default content directory is `content-repo`. `apply` refuses to run without an exact checked-out development branch, on a common production branch name, or while duplicate IDs remain.

Before apply, review and approve:

- `config/classification-overrides.json` for editorial classification;
- `config/taxonomy.json` for controlled values and aliases;
- `reports/id-manifest.proposed.json` for permanent IDs;
- `reports/dry-run.json` for missing descriptions, authors, dates, source metadata, topics, and ambiguous ad zones.

Unknown legacy fields remain in frontmatter and are listed in each report record. The migration does not invent verification dates, source metadata, authors, relations, audiences, or navigation values.

## Rollback

Before merge, rollback is `git switch office-rewrite`; the migration branch remains available for review. To discard only an uncommitted apply, restore the exact files listed as `migrated` in `migration/reports/apply.json` from the branch's parent commit. Do not use a broad hard reset in a dirty worktree.

Path moves and redirects are a later reviewed operation. `config/redirects.json` intentionally stays empty until URLs are proposed and approved.
