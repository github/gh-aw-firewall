#!/usr/bin/env python3
"""
Generate paper figures from token-dataset.jsonl and workload-augment.jsonl.

Outputs PNG files to paper-data/figures/:
  fig1-overall-epoch-trend.png      -- Overall median context tokens by epoch
  fig2-per-workflow-epochs.png      -- Per-workflow median context tokens by epoch
  fig3-mcp-vs-cli-migration.png     -- MCP tool calls vs gh-CLI calls over epochs
  fig4-cache-hit-rate.png           -- Cache hit rate by epoch (all workflows)
  fig5-workload-normalized.png      -- Tokens-per-LLM-call for Smoke Copilot/Claude
"""

import json
import os
import sys
import math
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import pandas as pd
import numpy as np

# ── Paths ─────────────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).parent.parent.parent
DATA_DIR  = REPO_ROOT / 'paper-data'
FIG_DIR   = DATA_DIR / 'figures'
FIG_DIR.mkdir(exist_ok=True)

# ── Load data ─────────────────────────────────────────────────────────────────
def load_jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]

print("Loading data…")
records  = load_jsonl(DATA_DIR / 'token-dataset.jsonl')
workload = load_jsonl(DATA_DIR / 'workload-augment.jsonl')

# ── Token normalisation (matches TypeScript logic) ────────────────────────────
def normalise(r):
    inp, out = r['input_tokens'], r['output_tokens']
    cR, cW   = r['cache_read_tokens'], r['cache_write_tokens']
    if cR > inp:
        # Anthropic format: input is net-non-cached
        ctx  = inp + cR + cW + out
        rate = cR / ctx if ctx > 0 else 0
    else:
        # OpenAI/Copilot format: input includes cache reads
        ctx  = inp + cW + out
        rate = cR / inp if inp > 0 else 0
    r['context_tokens'] = ctx
    r['cache_rate']     = rate
    return r

records = [normalise(r) for r in records]

# ── DataFrames ────────────────────────────────────────────────────────────────
df = pd.DataFrame(records)
wf = pd.DataFrame(workload)
df = df.merge(wf[['run_id','gh_cli_calls','mcp_tool_calls']], on='run_id', how='left')

# Keep only epochs 0–6
df = df[df['epoch'].between(0, 6)].copy()

# Epoch labels (short)
EPOCH_LABELS = {
    0: 'E0\nbaseline',
    1: 'E1\nsg-opt-1',
    2: 'E2\nsg-opt-2',
    3: 'E3\nhaiku',
    4: 'E4\nsmoke-haiku',
    5: 'E5\ncache-align',
    6: 'E6\nrel-gate',
}
EPOCH_SHORT = {
    0: 'E0', 1: 'E1', 2: 'E2', 3: 'E3', 4: 'E4', 5: 'E5', 6: 'E6'
}

# ── Style ─────────────────────────────────────────────────────────────────────
plt.rcParams.update({
    'font.family':  'sans-serif',
    'font.size':    11,
    'axes.spines.top':   False,
    'axes.spines.right': False,
    'axes.grid':    True,
    'grid.alpha':   0.35,
    'figure.dpi':   150,
})

WORKFLOW_COLORS = {
    'Security Guard':                          '#e15759',
    'Smoke Claude':                            '#4e79a7',
    'Smoke Copilot':                           '#f28e2b',
    'Secret Digger (Claude)':                  '#59a14f',
    'Daily Copilot Token Optimization Advisor':'#b07aa1',
    'Daily Claude Token Optimization Advisor': '#76b7b2',
}

def save(name):
    path = FIG_DIR / name
    plt.savefig(path, bbox_inches='tight')
    plt.close()
    print(f"  Saved {path.relative_to(REPO_ROOT)}")


# ═══════════════════════════════════════════════════════════════════════════════
# Figure 1 – Overall median context tokens by epoch
# ═══════════════════════════════════════════════════════════════════════════════
print("Figure 1: overall epoch trend…")

epochs = sorted(df['epoch'].unique())
stats = (
    df.groupby('epoch')['context_tokens']
    .agg(median='median', p25=lambda x: x.quantile(0.25), p75=lambda x: x.quantile(0.75), n='count')
    .reindex(epochs)
)

fig, ax = plt.subplots(figsize=(8, 4.5))

ax.fill_between(
    stats.index,
    stats['p25'] / 1e3,
    stats['p75'] / 1e3,
    alpha=0.18, color='steelblue', label='IQR (p25–p75)'
)
ax.plot(stats.index, stats['median'] / 1e3, 'o-', color='steelblue',
        linewidth=2.2, markersize=7, label='Median context tokens')

# Annotate final reduction
e0_med = stats.loc[0, 'median']
e6_med = stats.loc[6, 'median']
ax.annotate(
    f"−{100*(e0_med-e6_med)/e0_med:.1f}%",
    xy=(6, e6_med/1e3), xytext=(4.8, e6_med/1e3 + 18),
    arrowprops=dict(arrowstyle='->', color='#555'),
    fontsize=10, color='#333'
)

ax.set_xticks(epochs)
ax.set_xticklabels([EPOCH_LABELS[e] for e in epochs], fontsize=9)
ax.set_ylabel('Context tokens (thousands)')
ax.set_xlabel('Optimization epoch')
ax.set_title('Overall median context tokens per run across all workflows')
ax.set_ylim(bottom=0)
ax.legend(loc='upper right', fontsize=9)

# n labels below the p25 band (clamped so they don't go below 0)
for e in epochs:
    y = max(stats.loc[e,'p25']/1e3 - 14, 2)
    ax.text(e, y, f"n={int(stats.loc[e,'n'])}",
            ha='center', fontsize=7.5, color='#777')

plt.tight_layout()
save('fig1-overall-epoch-trend.png')


# ═══════════════════════════════════════════════════════════════════════════════
# Figure 2 – Per-workflow median context tokens by epoch
# ═══════════════════════════════════════════════════════════════════════════════
print("Figure 2: per-workflow trends…")

WORKFLOWS_MAIN = ['Security Guard', 'Smoke Claude', 'Smoke Copilot', 'Secret Digger (Claude)']

fig, ax = plt.subplots(figsize=(9, 5))

for wfname in WORKFLOWS_MAIN:
    sub = df[df['workflow'] == wfname]
    if sub.empty:
        continue
    med = sub.groupby('epoch')['context_tokens'].median() / 1e3
    color = WORKFLOW_COLORS.get(wfname, 'grey')
    ax.plot(med.index, med.values, 'o-', color=color,
            linewidth=2, markersize=6, label=wfname)

ax.set_xticks(sorted(df['epoch'].unique()))
ax.set_xticklabels([EPOCH_LABELS[e] for e in sorted(df['epoch'].unique())], fontsize=9)
ax.set_ylabel('Median context tokens (thousands)')
ax.set_xlabel('Optimization epoch')
ax.set_title('Per-workflow median context tokens by epoch')
ax.set_ylim(bottom=0)
ax.legend(fontsize=9, loc='upper right')
plt.tight_layout()
save('fig2-per-workflow-epochs.png')


# ═══════════════════════════════════════════════════════════════════════════════
# Figure 3 – MCP tool calls vs gh-CLI calls over epochs (workload migration)
# ═══════════════════════════════════════════════════════════════════════════════
print("Figure 3: MCP vs CLI migration…")

# Only epochs with workload data (epoch 0+, new format runs)
wf_df = df.dropna(subset=['gh_cli_calls', 'mcp_tool_calls']).copy()

WFLOWS_WORKLOAD = ['Security Guard', 'Smoke Claude', 'Smoke Copilot']

fig, axes = plt.subplots(1, 3, figsize=(13, 4.5), sharey=False)

for ax, wfname in zip(axes, WFLOWS_WORKLOAD):
    sub = wf_df[wf_df['workflow'] == wfname]
    if sub.empty:
        ax.set_title(wfname)
        continue
    med_mcp = sub.groupby('epoch')['mcp_tool_calls'].median()
    med_cli = sub.groupby('epoch')['gh_cli_calls'].median()

    xs = sorted(set(med_mcp.index) | set(med_cli.index))
    mcp_vals = [med_mcp.get(e, float('nan')) for e in xs]
    cli_vals = [med_cli.get(e, float('nan')) for e in xs]

    ax.plot(xs, mcp_vals, 's--', color='#e15759', linewidth=1.8, markersize=6,
            label='MCP tool calls')
    ax.plot(xs, cli_vals, 'o-',  color='#4e79a7', linewidth=1.8, markersize=6,
            label='gh CLI calls')

    ax.set_xticks(xs)
    ax.set_xticklabels([EPOCH_SHORT[e] for e in xs], fontsize=9)
    ax.set_title(wfname, fontsize=10)
    ax.set_xlabel('Epoch')
    ax.set_ylim(bottom=0)
    if ax is axes[0]:
        ax.set_ylabel('Median calls per run')
    ax.legend(fontsize=8)

fig.suptitle('MCP tool call vs. gh-CLI subprocess call migration across epochs', fontsize=12)
plt.tight_layout()
save('fig3-mcp-vs-cli-migration.png')


# ═══════════════════════════════════════════════════════════════════════════════
# Figure 4 – Cache hit rate by epoch
# ═══════════════════════════════════════════════════════════════════════════════
print("Figure 4: cache hit rate…")

# Only Claude workflows (cache_rate is meaningful for Anthropic provider)
claude_df = df[df['workflow'].isin(['Security Guard', 'Smoke Claude', 'Secret Digger (Claude)'])]

fig, ax = plt.subplots(figsize=(8, 4.5))

for wfname in ['Security Guard', 'Smoke Claude', 'Secret Digger (Claude)']:
    sub = claude_df[claude_df['workflow'] == wfname]
    if sub.empty:
        continue
    med = sub.groupby('epoch')['cache_rate'].median() * 100
    color = WORKFLOW_COLORS.get(wfname, 'grey')
    ax.plot(med.index, med.values, 'o-', color=color,
            linewidth=2, markersize=6, label=wfname)

# Overall line
overall = df[df['workflow'].isin(['Security Guard','Smoke Claude','Secret Digger (Claude)'])]
overall_med = overall.groupby('epoch')['cache_rate'].median() * 100
ax.plot(overall_med.index, overall_med.values, 'k--',
        linewidth=1.5, markersize=4, label='All Claude (median)', alpha=0.6)

ax.set_xticks(sorted(df['epoch'].unique()))
ax.set_xticklabels([EPOCH_LABELS[e] for e in sorted(df['epoch'].unique())], fontsize=9)
ax.set_ylabel('Median cache hit rate (%)')
ax.set_xlabel('Optimization epoch')
ax.set_title('Prompt cache hit rate evolution by epoch (Claude workflows)')
ax.set_ylim(0, 105)
ax.legend(fontsize=9)
plt.tight_layout()
save('fig4-cache-hit-rate.png')


# ═══════════════════════════════════════════════════════════════════════════════
# Figure 5 – Tokens per LLM call (workload-normalized) for Smoke Copilot + Smoke Claude
# ═══════════════════════════════════════════════════════════════════════════════
print("Figure 5: workload-normalized tok/call…")

tok_df = df.dropna(subset=['gh_cli_calls']).copy()
# Filter to epochs 3+ where api_calls is tracked
tok_df = tok_df[tok_df['epoch'] >= 3].copy()
tok_df['tok_per_call'] = tok_df['context_tokens'] / tok_df['api_calls'].replace(0, float('nan'))

fig, axes = plt.subplots(1, 2, figsize=(11, 4.5), sharey=False)

for ax, wfname in zip(axes, ['Smoke Copilot', 'Smoke Claude']):
    sub = tok_df[tok_df['workflow'] == wfname].dropna(subset=['tok_per_call'])
    if sub.empty:
        continue

    med_tpc   = sub.groupby('epoch')['tok_per_call'].median() / 1e3
    med_calls = sub.groupby('epoch')['api_calls'].median()

    xs = sorted(med_tpc.index)
    color = WORKFLOW_COLORS.get(wfname, 'grey')

    ax2 = ax.twinx()
    ax2.bar(xs, [med_calls.get(e, 0) for e in xs],
            color=color, alpha=0.18, width=0.5, label='LLM calls (right)')
    ax2.set_ylabel('Median LLM API calls', fontsize=9, color=color)
    ax2.set_ylim(bottom=0)
    ax2.tick_params(axis='y', labelcolor=color)
    ax2.spines['right'].set_visible(True)

    ax.plot(xs, [med_tpc.get(e, float('nan')) for e in xs], 'o-',
            color=color, linewidth=2.2, markersize=7, label='Tokens/call (left)')

    ax.set_xticks(xs)
    ax.set_xticklabels([EPOCH_SHORT[e] for e in xs], fontsize=9)
    ax.set_xlabel('Epoch')
    ax.set_ylabel('Context tokens per LLM call (thousands)', fontsize=9)
    ax.set_ylim(bottom=0)
    ax.set_title(wfname, fontsize=10)

    # Annotate reduction
    vals = [(e, med_tpc.get(e)) for e in xs if e in med_tpc.index]
    if len(vals) >= 2:
        _, v0 = vals[0]
        _, vn = vals[-1]
        if v0 and vn:
            pct_red = 100 * (v0 - vn) / v0
            ax.text(0.97, 0.97, f"−{pct_red:.0f}% tok/call",
                    transform=ax.transAxes, ha='right', va='top',
                    fontsize=10, color=color,
                    bbox=dict(boxstyle='round,pad=0.3', fc='white', alpha=0.7))

fig.suptitle('Workload-normalized context tokens per LLM call', fontsize=12)
plt.tight_layout()
save('fig5-workload-normalized.png')


# ═══════════════════════════════════════════════════════════════════════════════
# Figure 6 – Cost per run over time (box per epoch for runs with cost data)
# ═══════════════════════════════════════════════════════════════════════════════
print("Figure 6: cost per run…")

cost_df = df.dropna(subset=['cost_usd']).copy()
cost_df = cost_df[cost_df['cost_usd'] > 0]

if not cost_df.empty:
    fig, ax = plt.subplots(figsize=(9, 4.5))

    epochs_with_cost = sorted(cost_df['epoch'].unique())
    data_by_epoch = [cost_df[cost_df['epoch'] == e]['cost_usd'].values for e in epochs_with_cost]

    bp = ax.boxplot(data_by_epoch, positions=epochs_with_cost, widths=0.5,
                    patch_artist=True, showfliers=False,
                    medianprops=dict(color='black', linewidth=2))
    for patch in bp['boxes']:
        patch.set_facecolor('steelblue')
        patch.set_alpha(0.5)

    # Overlay mean
    means = [cost_df[cost_df['epoch'] == e]['cost_usd'].mean() for e in epochs_with_cost]
    ax.plot(epochs_with_cost, means, 'D--', color='#e15759',
            markersize=6, linewidth=1.5, label='Mean cost/run')

    ax.set_xticks(epochs_with_cost)
    ax.set_xticklabels([EPOCH_LABELS[e] for e in epochs_with_cost], fontsize=9)
    ax.set_ylabel('Cost per run (USD)')
    ax.set_xlabel('Optimization epoch')
    ax.set_title('Distribution of cost per run by epoch (runs with cost data)')
    ax.set_ylim(bottom=0)
    ax.legend(fontsize=9)
    plt.tight_layout()
    save('fig6-cost-per-run.png')
else:
    print("  Skipped fig6: no cost data")


print("\nAll figures written to paper-data/figures/")
