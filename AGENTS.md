# Project agent instructions

- Read `PRD.md` and the relevant implementation before changing behavior. Treat planned features as unimplemented until verified in code.
- Use Context7 for current documentation when working with libraries, frameworks, SDKs, APIs, CLI tools or cloud services. If it is unavailable, state the limitation and consult authoritative documentation.
- Apply available Caveman and Ponytail guidance while preserving clear explanations for safety, uncertainty and user-facing decisions.
- Write and run tests appropriate to each behavior change, including failure and authorization paths where relevant. Report checks and any gaps.
- Update local `flow.md` when implemented behavior or interactions change, and update local `decisions.md` when meaningful decisions change. Keep each file below 150 lines; preserve accurate history through concise summaries.
- Update local `plan.md` as phases progress. These three working documents are Git-ignored and may be absent in another checkout; recreate them from available evidence when needed, without inventing implementation or decisions.
- Preserve the PRD's boundaries: flight-critical functions stay outside this platform; deterministic backend policy classifies AI actions; low-risk actions may run autonomously only when explicitly allowed, while high-risk or unclassified actions require human approval. Revalidate authorization and eligibility at dispatch.
