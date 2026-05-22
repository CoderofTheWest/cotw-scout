'use strict';

/**
 * Normalization using saved training statistics.
 * Applies z-score normalization: (x - mu) / sigma
 */

class Normalizer {
    constructor(normData) {
        this.featureNames = normData.feature_names;
        this.mu = new Float32Array(normData.mu);
        this.sigma = new Float32Array(normData.sigma);
        this.inputCondNames = normData.input_cond_names;
        this.inputCondIndices = normData.input_cond_indices;
        this.inputCondMu = new Float32Array(normData.input_cond_mu);
        this.inputCondSigma = new Float32Array(normData.input_cond_sigma);
    }

    /**
     * Normalize a full state vector.
     * @param {Float32Array} raw - Raw 25-dim state vector
     * @returns {Float32Array} Normalized vector
     */
    normalizeState(raw) {
        const out = new Float32Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
            let v = (raw[i] - this.mu[i]) / this.sigma[i];
            // Clip to ±3σ to prevent outlier features from dominating the latent
            if (v > 3) v = 3;
            else if (v < -3) v = -3;
            out[i] = v;
        }
        return out;
    }

    /**
     * Extract and normalize input-conditioning features.
     * @param {Float32Array} raw - Raw 25-dim state vector (before normalization)
     * @returns {Float32Array} Normalized input-cond vector (3-dim)
     */
    normalizeInputCond(raw) {
        const out = new Float32Array(this.inputCondIndices.length);
        for (let i = 0; i < this.inputCondIndices.length; i++) {
            const idx = this.inputCondIndices[i];
            out[i] = (raw[idx] - this.inputCondMu[i]) / this.inputCondSigma[i];
        }
        return out;
    }

    /**
     * Get the index of a feature by name.
     */
    featureIndex(name) {
        return this.featureNames.indexOf(name);
    }
}

module.exports = Normalizer;
