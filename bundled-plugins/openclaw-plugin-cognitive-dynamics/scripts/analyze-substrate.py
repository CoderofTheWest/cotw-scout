#!/usr/bin/env python3
"""
Post-hoc substrate analysis for the cognitive dynamics experiment.

Reads the cognitive-dynamics.jsonl log and decomposes surprise into
internal (cognitive) vs external (conversational) components.

Run periodically as data accumulates:
  python3 scripts/analyze-substrate.py
"""

import json
import sys
import numpy as np
from pathlib import Path

PLUGIN_DIR = Path(__file__).parent.parent
LOG_PATH = PLUGIN_DIR / 'data' / 'agents' / 'clint' / 'cognitive-dynamics.jsonl'
NORM_PATH = PLUGIN_DIR / 'models' / 'normalization.json'

# Feature classification
INTERNAL_FEATURES = {
    'entropy_total', 'correction', 'novelConcepts', 'emotional', 'paradox',
    'qualityDecay', 'recursiveMeta', 'quietIntegration', 'quality',
    'decision_old', 'decision_new', 'decision_divergence',
    'entropy_debt', 'quality_rating', 'tension_type',
    'self_reference_ratio',
}

EXTERNAL_FEATURES = {
    'user_length', 'response_length', 'topic_shift',
    'question_density', 'user_question_marks',
    'response_to_input_ratio', 'turn_index_in_session', 'session_length_minutes',
}

BORDERLINE_FEATURES = {'shannon'}


def main():
    norm = json.loads(NORM_PATH.read_text())
    feature_names = norm['feature_names']
    mu = np.array(norm['mu'])
    sigma = np.array(norm['sigma'])

    internal_idx = [i for i, f in enumerate(feature_names) if f in INTERNAL_FEATURES]
    external_idx = [i for i, f in enumerate(feature_names) if f in EXTERNAL_FEATURES]

    # Load entries with full vectors
    entries = []
    with open(LOG_PATH) as f:
        for line in f:
            e = json.loads(line)
            if e.get('state_vector') and e.get('latent') and e.get('predicted_frozen'):
                entries.append(e)

    if len(entries) < 2:
        print(f'Only {len(entries)} entries with full vectors. Need more data.')
        return

    print(f'Entries with full vectors: {len(entries)}')
    surprise_entries = [e for e in entries if e.get('surprise_frozen') is not None]
    print(f'Entries with surprise values: {len(surprise_entries)}')
    print()

    # === State space decomposition ===
    states = np.array([e['state_vector'] for e in entries])
    normalized = np.clip((states - mu) / sigma, -3, 3)

    internal_energy = (normalized[:, internal_idx] ** 2).sum(axis=1)
    external_energy = (normalized[:, external_idx] ** 2).sum(axis=1)
    total_energy = internal_energy + external_energy

    print('=== State Space Energy Decomposition ===')
    print(f'Mean internal energy:  {internal_energy.mean():.3f} ({internal_energy.mean()/total_energy.mean()*100:.1f}%)')
    print(f'Mean external energy:  {external_energy.mean():.3f} ({external_energy.mean()/total_energy.mean()*100:.1f}%)')
    print()

    # === Internal feature activity ===
    print('=== Internal Feature Activity ===')
    print(f'{"Feature":>28} {"NonZero":>8} {"Mean":>8} {"Std":>8} {"Max":>8}')
    print('-' * 65)
    for i in internal_idx:
        vals = states[:, i]
        nz = np.count_nonzero(vals)
        print(f'{feature_names[i]:>28} {nz:>6}/{len(vals)} {vals.mean():>8.4f} {vals.std():>8.4f} {vals.max():>8.4f}')

    print()

    if len(surprise_entries) < 2:
        print('Need more surprise entries for divergence analysis.')
        return

    # === Per-dimension latent error decomposition ===
    latents = np.array([e['latent'] for e in surprise_entries])
    predicted = np.array([e['predicted_frozen'] for e in surprise_entries])
    per_dim_se = (predicted - latents) ** 2
    mean_per_dim = per_dim_se.mean(axis=0)

    # Rank latent dimensions by error
    ranked = np.argsort(mean_per_dim)[::-1]
    total_mse = mean_per_dim.sum()

    print('=== Latent Dimension Error Ranking ===')
    print(f'Total mean surprise: {total_mse:.4f}')
    cumul = 0
    print(f'{"Rank":>4} {"Dim":>4} {"Mean SE":>10} {"% Total":>8} {"Cumul":>8}')
    print('-' * 40)
    for i in range(min(15, len(ranked))):
        d = ranked[i]
        pct = mean_per_dim[d] / total_mse * 100
        cumul += pct
        print(f'{i+1:4d} {d:4d} {mean_per_dim[d]:10.4f} {pct:7.1f}% {cumul:7.1f}%')

    # === Signed bias (systematic over/under prediction) ===
    signed_error = (predicted - latents).mean(axis=0)
    print()
    print('=== Systematic Prediction Bias ===')
    bias_ranked = np.argsort(np.abs(signed_error))[::-1]
    print(f'{"Dim":>4} {"Bias":>10} {"Direction":>10}')
    print('-' * 30)
    for i in range(min(10, len(bias_ranked))):
        d = bias_ranked[i]
        print(f'{d:4d} {signed_error[d]:+10.4f} {"over" if signed_error[d] > 0 else "under":>10}')

    # === Empirical correlation (input features vs latent errors) ===
    if len(surprise_entries) >= 4:
        from scipy import stats as sp
        states_s = np.array([e['state_vector'] for e in surprise_entries])
        norm_s = np.clip((states_s - mu) / sigma, -3, 3)
        signed_s = predicted - latents

        print()
        print('=== Feature-Error Correlation (empirical substrate divergence drivers) ===')
        print(f'{"Feature":>28} {"Mean|corr|":>10} {"Category":>10}')
        print('-' * 55)

        corrs = []
        for f in range(25):
            if np.std(norm_s[:, f]) < 1e-8:
                corrs.append(0.0)
                continue
            abs_corrs = []
            for d in range(64):
                r, _ = sp.pearsonr(norm_s[:, f], signed_s[:, d])
                abs_corrs.append(abs(r))
            corrs.append(np.mean(abs_corrs))

        ranked_f = np.argsort(corrs)[::-1]
        for i in range(25):
            f = ranked_f[i]
            cat = 'INTERNAL' if feature_names[f] in INTERNAL_FEATURES else (
                'EXTERNAL' if feature_names[f] in EXTERNAL_FEATURES else 'BORDER')
            marker = ' ***' if corrs[f] > 0.4 else ''
            print(f'{feature_names[f]:>28} {corrs[f]:10.4f} {cat:>10}{marker}')

    # === Summary ===
    print()
    print('=== SUBSTRATE DISTANCE SUMMARY ===')
    print(f'Data points: {len(surprise_entries)}')
    print(f'Mean total surprise (frozen): {np.mean([e["surprise_frozen"] for e in surprise_entries]):.3f}')
    print(f'Internal state energy: {internal_energy.mean()/total_energy.mean()*100:.1f}% of encoder input')
    print(f'External context energy: {external_energy.mean()/total_energy.mean()*100:.1f}% of encoder input')

    active_internal = sum(1 for i in internal_idx if states[:, i].std() > 0.01)
    total_internal = len(internal_idx)
    print(f'Active internal features: {active_internal}/{total_internal}')
    print(f'Entropy detectors firing: {"YES" if any(states[:, i].max() > 0 for i in [1,2,3,4,5,6,7]) else "NOT YET"}')
    print()
    if active_internal < total_internal * 0.5:
        print('⚠ Most internal features inactive. Substrate distance measurement is incomplete.')
        print('  Need substantive conversations that trigger entropy detectors.')
    else:
        print('✓ Sufficient internal feature activity for substrate comparison.')


if __name__ == '__main__':
    main()
