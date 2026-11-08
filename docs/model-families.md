# Reviewed canonical accounting families

## Review and evidence

This is the 2026-11-08 membership review for the existing exact Copilot records
in `shared/model-information/sources/copilot-*.json`. The following table is the
family evidence ledger: it records **maintained accounting membership**, not
verified tariffs or execution compatibility. The authoring changes are only
`identity.family`; existing price, availability and lifecycle provenance is
retained, not refreshed or attributed to this review. The canonical compiler
owns every generated projection.

Membership is an explicit, finite list. There are no new aliases, wildcard
rules, prefix rules, inferred future revisions or cross-backend associations.
Product names and recorded versioned lineages support these accounting groups;
shared endpoints, similar prices or a manufacturer namespace alone do not.

| Family | Exact Copilot members | Evidence and decision |
| --- | --- | --- |
| `gpt-4o` | `gpt-4o`, `gpt-4o-mini` | [OpenAI's GPT-4o mini announcement](https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/) identifies the small GPT-4o product and explicitly compares it with GPT-4o. The existing maintained mapping records this product family. No audio/realtime or ChatGPT variants are enrolled. |
| `o3` | `o3`, `o3-mini` | [OpenAI's o3-mini announcement](https://openai.com/index/openai-o3-mini/) and the recorded `o3` mapping identify this reasoning series. The mapping separately handles pro/deep-research; neither is enrolled. |
| `gpt-5.4` | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano` | [OpenAI's mini/nano announcement](https://openai.com/index/introducing-gpt-5-4-mini-and-nano/) explicitly describes the smaller GPT-5.4 versions. Size variants belong to the accounting family, not to a common capability or reasoning-effort record. Pro and Codex are not enrolled. |
| `claude-opus-4` | `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4.8` | The recorded `claude-opus-4` lineage plus [GitHub's supported-model names](https://docs.github.com/en/copilot/reference/ai-models/supported-models) establish the versioned Opus product. No fast-mode identity is enrolled. Opus 4.6's separate staged reasoning record remains authoritative for that independent surface. |
| `claude-opus-5` | `claude-opus-5`, `claude-opus-5-5` | The recorded `claude-opus-5` lineage, GitHub's names and [Anthropic's model overview](https://platform.claude.com/docs/en/models/overview) identify this product, separate from Opus 4. |
| `claude-sonnet-4` | `claude-sonnet-4`, `claude-sonnet-4.5`, `claude-sonnet-4.6` | The recorded `claude-sonnet-4` lineage and GitHub's names identify the versioned Sonnet product, separate from Opus and from Sonnet 5. |
| `claude-sonnet-5` | `claude-sonnet-5`, `claude-sonnet-5-5` | The recorded `claude-sonnet-5` lineage, GitHub's names and Anthropic's overview identify this product. |
| `claude-fable-5` | `claude-fable-5`, `claude-fable-5-1` | The recorded `claude-fable-5` lineage and GitHub's explicit Fable 5/5.1 names identify this product, separate from Opus despite similar rates. |
| `gemini-3.1-pro` | `gemini-3.1-pro`, `gemini-3.1-pro-preview` | The two already-maintained Copilot IDs and [Google's Gemini 3.1 Pro model card](https://aistudio.google.com/docs/models/gemini-3.1-pro-preview) identify this versioned Pro product and its preview. They remain distinct exact wire identities, not aliases. Flash and customtools variants are not enrolled. |

The recorded lineage evidence is
`shared/model-information/sources/mapping.json`, reviewed at
`2026-10-08T07:12:00Z`, revision
`6412df16d67b32bf0f4c4dfea7bb2954c0665e467e1106488f4702059fc84447`,
with maintained/estimated provenance. Its native-provider API patterns are
corroborating product evidence only: this review does **not** copy those wildcard
patterns, routing metadata, backend scope or capability defaults into naming.
Official pages above were read on 2026-11-08. They corroborate product naming,
not the current availability or historical tariff of every listed Copilot ID.

## Coverage, exceptions and unknowns

Of the **56** bundled reviewed identities, **22 (39.3%)** now have membership
in **nine** families; **34 (60.7%)** remain unknown. No imported or native-backend
identity gains a family. The unknown exact IDs are:

```text
claude-haiku-4.5, claude-haiku-5.5, claude-mythos-5,
gemini-2.5-pro, gemini-3-flash, gemini-3.1-flash, gemini-3.5-flash,
gemini-3.8-flash, gemini-4-argon,
gpt-4, gpt-4.1, gpt-4.5, gpt-5-codex, gpt-5-codex-mini, gpt-5-mini,
gpt-5.1, gpt-5.2, gpt-5.2-codex, gpt-5.3-codex, gpt-5.5,
gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra,
gpt-6-astra, gpt-6-luna, gpt-6-sol, gpt-6.1-sol, gpt-6.1-terra,
mai-code-1-flash, mai-code-1.1-flash, raptor-mini,
text-embedding-3-small, text-embedding-3-small-inference, text-embedding-ada-002
```

Unknown does not mean unrelated, unsupported or unavailable. This bounded
review does not join generations, differently specialized products or
continuously updated checkpoints without a reviewed lineage decision.
Haiku 4.5/5.5 are not joined across major generations. GPT's Luna/Sol/Terra/Astra
profiles, Codex, pro/cyber/research variants, Mythos and embedding/inference
variants are not captured by any broader rule. In particular, a lookup for
`gpt-5.4-pro`, `gpt-5.4-codex`, `claude-mythos-preview` or
`gemini-3.1-pro-preview-customtools` gains no membership from its prefix.
An attempted official lookup for `gpt-5-codex-mini` returned 404; that cannot
justify associating it with `gpt-5-codex` or GPT-5 generally.

## Pricing effect and boundaries

With shipped tariffs and no overrides, ten canonical Copilot IDs lack an
applicable maintained price. Five have reviewed families: GPT-4o and o3's four
members have no priced family donors and retain backend fallback;
`gemini-3.1-pro-preview` now selects its single eligible Copilot donor,
`gemini-3.1-pro`. The other five missing-price identities remain unknown.
The remaining families can supply family medians when applicable exact prices
are absent in a request's captured scope or when provider omissions need filling.

At default scope/time, 10,000 fresh input tokens for
`gemini-3.1-pro-preview` change from **1.875 backend-estimated credits**
(46 shipped donor identities, median input USD 1.875/MTok) to
**2 family-estimated credits** (one donor, USD 2/MTok).
The family's output/reasoning median is USD 12/MTok and cache-read median is
USD 0.2/MTok; cache write remains unavailable, not zero.
These are estimates, not newly published or corrected prices.

The pricing adapter maps compiler-owned maintained Claude lookup keys back to
their canonical IDs before donor enumeration. For example,
`claude-sonnet-4-5` in the generated price projection belongs to canonical
`copilot/claude-sonnet-4.5`; a runtime observation of the latter and its maintained
price get **one** donor vote, with existing source precedence. This does not
enable separator/date folding for requests, arbitrary observations or imports.

Operator/configured/exact provider/central/maintained/imported prices and
configured defaults keep their existing authority. Eligible donor tariffs
retain existing backend associations and structured tariffs retain their
channel/deployment, freshness, effective-time, retirement and prompt-tier checks.
Legacy flat maintained prices are not promoted into new structured scoped
tariffs by this review. Explicit exact decimal medians and budget comparisons are
unchanged. Copilot membership cannot lend prices to native OpenAI/Anthropic,
OpenRouter or custom backends, or erase OpenRouter publisher namespaces.

Family membership proves neither availability, deployability, policy permission,
reasoning support, wire compatibility nor replacement eligibility. Exact IDs,
aliases, matching policies, routing, recovery, retirement, selector choices,
execution and published v1 identities remain unchanged. No staged tariff,
reasoning/translation/harness fact or compiler overlay is activated.
This does not complete #10290, #10294 or #10295.
