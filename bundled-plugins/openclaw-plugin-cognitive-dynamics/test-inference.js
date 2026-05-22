#!/usr/bin/env node
'use strict';

/**
 * Validate JS MLP forward pass against PyTorch test vector.
 * Run: node test-inference.js
 */

const path = require('path');
const { forward, concat } = require('./lib/mlp');

const MODELS_DIR = path.join(__dirname, 'models');

function loadJSON(p) {
    return JSON.parse(require('fs').readFileSync(p, 'utf-8'));
}

const encoderWeights = loadJSON(path.join(MODELS_DIR, 'encoder_weights.json'));
const predictorWeights = loadJSON(path.join(MODELS_DIR, 'predictor_weights.json'));
const testData = loadJSON(path.join(MODELS_DIR, 'test_vector.json'));

// Run encoder
const normalizedInput = new Float32Array(testData.normalized_input);
const jsLatent = forward(normalizedInput, encoderWeights.layers);
const expectedLatent = new Float32Array(testData.expected_latent);

// Run predictor
const inputCond = new Float32Array(testData.input_cond_normalized);
const predictorInput = concat(jsLatent, inputCond);
const jsPrediction = forward(predictorInput, predictorWeights.layers);
const expectedPrediction = new Float32Array(testData.expected_prediction);

// Compare
function maxAbsDiff(a, b) {
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    }
    return maxDiff;
}

function meanAbsDiff(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += Math.abs(a[i] - b[i]);
    }
    return sum / a.length;
}

const latentMaxDiff = maxAbsDiff(jsLatent, expectedLatent);
const latentMeanDiff = meanAbsDiff(jsLatent, expectedLatent);
const predMaxDiff = maxAbsDiff(jsPrediction, expectedPrediction);
const predMeanDiff = meanAbsDiff(jsPrediction, expectedPrediction);

console.log('=== JS vs PyTorch Inference Validation ===');
console.log(`Encoder output (${jsLatent.length}-dim):`);
console.log(`  Max abs diff:  ${latentMaxDiff.toExponential(3)}`);
console.log(`  Mean abs diff: ${latentMeanDiff.toExponential(3)}`);
console.log(`  First 5 JS:    [${Array.from(jsLatent.slice(0, 5)).map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  First 5 PT:    [${testData.expected_latent.slice(0, 5).map(v => v.toFixed(4)).join(', ')}]`);
console.log();
console.log(`Predictor output (${jsPrediction.length}-dim):`);
console.log(`  Max abs diff:  ${predMaxDiff.toExponential(3)}`);
console.log(`  Mean abs diff: ${predMeanDiff.toExponential(3)}`);
console.log(`  First 5 JS:    [${Array.from(jsPrediction.slice(0, 5)).map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  First 5 PT:    [${testData.expected_prediction.slice(0, 5).map(v => v.toFixed(4)).join(', ')}]`);
console.log();

const TOLERANCE = 1e-4;
const pass = latentMaxDiff < TOLERANCE && predMaxDiff < TOLERANCE;
console.log(pass ? '✅ PASS — JS matches PyTorch within float32 tolerance' : '❌ FAIL — significant divergence detected');

process.exit(pass ? 0 : 1);
