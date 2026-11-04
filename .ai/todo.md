# PR #116 – hooks block literal backslashes

- [x] Validate PR (open, no reviews, CI green, main unchanged since)
- [x] Confirm root cause (heredoc does not rescan HOOKS_LOCATION_BLOCK)
- [x] Simplify: drop HOOKS_XFF (always equal to XFF_DIRECT)
- [x] Tests: branch 128/0, main entrypoint 120/8 (new hooks asserts)
- [x] Live nginx in node:24-alpine: main sends "\Bearer", "\127.0.0.1"; branch sends clean values

## Review
Fix is correct and small. Rendered config byte-identical to PR head after cleanup.
Follow-up (out of scope): HOOKS_PATH is not validated before being pasted into nginx config.
