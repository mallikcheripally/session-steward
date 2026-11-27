# Markdown handoff feasibility experiment

Research only. This directory is not part of the published package. It does not add a product button, launch an app automatically, modify native session stores, or call an AI service. Real receiving-agent trials were conducted separately through the desktop apps.

Run from the repository root with the package's supported Node version:

```sh
node experiments/handoff-feasibility/prepare.mjs
node --test experiments/handoff-feasibility/validation.test.mjs
node experiments/handoff-feasibility/scale.mjs
```

`prepare.mjs` recreates explicitly disposable synthetic cases under `.artifacts/`; do not put real data there. The scale script also recreates only its own synthetic scale outputs. Generated archives stay gitignored. Preparation does not run receiving agents or spend model usage.

Read [REPORT.md](REPORT.md) for the verdict, scope, measurements and unverified cases. Desktop results are recorded in `desktop-observations.json` and `chatgpt-desktop-result.json`. A real-agent retrieval pass is not proof of a completed coding task, a lossless native migration, or a reliable automatic launcher.

The prototype intentionally has a small format mapping. It preserves normal text and supported tool text, reports unknown/oversized/malformed content, and does not claim full production format support. The production timeline API is separately exercised to show its 1000-event cap; it must not be mistaken for a complete export API.

To repeat the receiving-agent checks, create a fresh **local desktop coding chat** in the repository workspace, paste the relevant `.artifacts/<case>/prompt.txt`, and record the final answer against `expected.json`. Do not use a regular cloud chat without an explicit file-upload workflow. Use invented data only. Do not start additional Claude trials on the user's account while its usage limit is exhausted; the user explicitly requested this.

The current cases test targeted evidence retrieval, not a representative distribution of real conversations. Ordinary repeated filler makes the important statements easier to search than a genuinely ambiguous history. Historical timestamps do not establish that every historical runtime release produced the same shape.
