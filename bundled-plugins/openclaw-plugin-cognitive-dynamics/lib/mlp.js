'use strict';

/**
 * Pure JS MLP forward pass for JEPA encoder and predictor.
 * No dependencies — just array math.
 *
 * Supports: Linear, ReLU, LayerNorm layers.
 * Weights loaded from JSON exported by export_weights.py.
 */

/**
 * Matrix-vector multiply: y = W @ x + b
 * W shape: (out, in), x shape: (in,), b shape: (out,)
 */
function linear(x, weight, bias) {
    const out = new Float32Array(weight.length);
    for (let i = 0; i < weight.length; i++) {
        let sum = bias[i];
        const row = weight[i];
        for (let j = 0; j < row.length; j++) {
            sum += row[j] * x[j];
        }
        out[i] = sum;
    }
    return out;
}

function relu(x) {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
        out[i] = x[i] > 0 ? x[i] : 0;
    }
    return out;
}

function layerNorm(x, weight, bias, eps = 1e-5) {
    const n = x.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;

    let variance = 0;
    for (let i = 0; i < n; i++) {
        const d = x[i] - mean;
        variance += d * d;
    }
    variance /= n;

    const invStd = 1.0 / Math.sqrt(variance + eps);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = (x[i] - mean) * invStd * weight[i] + bias[i];
    }
    return out;
}

/**
 * Run forward pass through a sequence of layers.
 * @param {Float32Array} input - Input vector
 * @param {Array} layers - Layer definitions from JSON
 * @returns {Float32Array} Output vector
 */
function forward(input, layers) {
    let x = input;
    for (const layer of layers) {
        switch (layer.type) {
            case 'linear':
                x = linear(x, layer.weight, layer.bias);
                break;
            case 'relu':
                x = relu(x);
                break;
            case 'layernorm':
                x = layerNorm(x, layer.weight, layer.bias, layer.eps || 1e-5);
                break;
            default:
                throw new Error(`Unknown layer type: ${layer.type}`);
        }
    }
    return x;
}

/**
 * Concatenate two Float32Arrays.
 */
function concat(a, b) {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * L2 squared distance between two vectors.
 */
function l2Squared(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return sum;
}

module.exports = { forward, concat, l2Squared, linear, relu, layerNorm };
