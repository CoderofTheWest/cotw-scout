'use strict';

/**
 * Learnable MLP predictor with online SGD.
 *
 * Architecture: Linear(67,128) → ReLU → Linear(128,128) → ReLU → Linear(128,64)
 * (67 = 64 latent + 3 input-conditioning features)
 *
 * Initialized from frozen predictor weights (transfer learning).
 * Updates weights via backpropagation after each turn.
 * Saves weights periodically to survive restarts.
 */

const fs = require('fs');
const path = require('path');

class LearnablePredictor {
    /**
     * @param {Object} initialWeights - Predictor weights JSON (from predictor_weights.json)
     * @param {Object} options
     * @param {number} options.learningRate - Initial learning rate (default 0.001)
     * @param {number} options.lrDecay - Multiplicative decay per update (default 0.9999)
     * @param {number} options.minLr - Minimum learning rate floor (default 0.00001)
     * @param {number} options.momentumCoeff - Momentum coefficient (default 0.9)
     * @param {string} options.savePath - Path to save learned weights
     * @param {number} options.saveEvery - Save weights every N updates (default 10)
     */
    constructor(initialWeights, options = {}) {
        this.lr = options.learningRate || 0.001;
        this.lrDecay = options.lrDecay || 0.9999;
        this.minLr = options.minLr || 0.00001;
        this.momentumCoeff = options.momentumCoeff || 0.9;
        this.savePath = options.savePath || null;
        this.saveEvery = options.saveEvery || 10;
        this.updateCount = 0;

        // Deep copy weights into mutable arrays
        this.layers = this._initLayers(initialWeights.layers);

        // Initialize momentum buffers (zeros)
        this.momentum = this.layers.map(layer => {
            if (layer.type !== 'linear') return null;
            return {
                weight: layer.weight.map(row => new Float64Array(row.length)),
                bias: new Float64Array(layer.bias.length),
            };
        });

        // Try to load previously saved weights
        if (this.savePath && fs.existsSync(this.savePath)) {
            try {
                this._loadWeights();
            } catch (e) {
                // Fall back to initial weights
            }
        }
    }

    _initLayers(layerDefs) {
        return layerDefs.map(def => {
            if (def.type === 'linear') {
                return {
                    type: 'linear',
                    weight: def.weight.map(row => Float64Array.from(row)),
                    bias: Float64Array.from(def.bias),
                    in_features: def.in_features,
                    out_features: def.out_features,
                    // Activations stored during forward pass for backprop
                    _input: null,
                    _output: null,
                };
            }
            return { type: def.type, _input: null, _output: null };
        });
    }

    /**
     * Forward pass with activation caching for backprop.
     * @param {Float32Array} input - Concatenated [latent, input_cond]
     * @returns {Float32Array} Predicted next latent
     */
    forward(input) {
        let x = Float64Array.from(input);
        for (const layer of this.layers) {
            layer._input = x.slice(); // Cache input for backprop
            if (layer.type === 'linear') {
                const out = new Float64Array(layer.weight.length);
                for (let i = 0; i < layer.weight.length; i++) {
                    let sum = layer.bias[i];
                    const row = layer.weight[i];
                    for (let j = 0; j < row.length; j++) {
                        sum += row[j] * x[j];
                    }
                    out[i] = sum;
                }
                layer._output = out;
                x = out;
            } else if (layer.type === 'relu') {
                const out = new Float64Array(x.length);
                for (let i = 0; i < x.length; i++) {
                    out[i] = x[i] > 0 ? x[i] : 0;
                }
                layer._output = out;
                x = out;
            }
        }
        return new Float32Array(x);
    }

    /**
     * Backpropagate MSE loss and update weights via SGD with momentum.
     * @param {Float32Array} predicted - Output of forward()
     * @param {Float32Array} target - Actual next latent from encoder
     * @returns {number} Loss (MSE)
     */
    backward(predicted, target) {
        const n = predicted.length;

        // Compute MSE loss
        let loss = 0;
        for (let i = 0; i < n; i++) {
            const d = predicted[i] - target[i];
            loss += d * d;
        }
        loss /= n;

        // Gradient of MSE: d(loss)/d(predicted) = 2*(predicted - target) / n
        let grad = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            grad[i] = 2 * (predicted[i] - target[i]) / n;
        }

        // Backprop through layers in reverse
        for (let l = this.layers.length - 1; l >= 0; l--) {
            const layer = this.layers[l];
            const mom = this.momentum[l];

            if (layer.type === 'relu') {
                // ReLU gradient: pass through if input > 0, zero otherwise
                const newGrad = new Float64Array(grad.length);
                for (let i = 0; i < grad.length; i++) {
                    newGrad[i] = layer._input[i] > 0 ? grad[i] : 0;
                }
                grad = newGrad;
            } else if (layer.type === 'linear') {
                const input = layer._input;
                const outDim = layer.weight.length;
                const inDim = layer.weight[0].length;

                // Gradient w.r.t. input (for next layer back)
                const inputGrad = new Float64Array(inDim);
                for (let j = 0; j < inDim; j++) {
                    let sum = 0;
                    for (let i = 0; i < outDim; i++) {
                        sum += layer.weight[i][j] * grad[i];
                    }
                    inputGrad[j] = sum;
                }

                // Update weights with momentum SGD
                for (let i = 0; i < outDim; i++) {
                    // Bias update
                    mom.bias[i] = this.momentumCoeff * mom.bias[i] + grad[i];
                    layer.bias[i] -= this.lr * mom.bias[i];

                    // Weight update
                    for (let j = 0; j < inDim; j++) {
                        const g = grad[i] * input[j];
                        mom.weight[i][j] = this.momentumCoeff * mom.weight[i][j] + g;
                        layer.weight[i][j] -= this.lr * mom.weight[i][j];
                    }
                }

                grad = inputGrad;
            }
        }

        // Decay learning rate
        this.lr = Math.max(this.minLr, this.lr * this.lrDecay);
        this.updateCount++;

        // Periodic save
        if (this.savePath && this.updateCount % this.saveEvery === 0) {
            this._saveWeights();
        }

        return loss;
    }

    _saveWeights() {
        try {
            const data = {
                updateCount: this.updateCount,
                lr: this.lr,
                layers: this.layers.map(layer => {
                    if (layer.type === 'linear') {
                        return {
                            type: 'linear',
                            weight: layer.weight.map(row => Array.from(row)),
                            bias: Array.from(layer.bias),
                            in_features: layer.in_features,
                            out_features: layer.out_features,
                        };
                    }
                    return { type: layer.type };
                }),
            };
            fs.writeFileSync(this.savePath, JSON.stringify(data));
        } catch (e) {
            // Silent fail — don't crash the plugin
        }
    }

    _loadWeights() {
        const data = JSON.parse(fs.readFileSync(this.savePath, 'utf-8'));
        this.updateCount = data.updateCount || 0;
        this.lr = data.lr || this.lr;
        for (let l = 0; l < this.layers.length; l++) {
            if (this.layers[l].type === 'linear' && data.layers[l]?.type === 'linear') {
                this.layers[l].weight = data.layers[l].weight.map(row => Float64Array.from(row));
                this.layers[l].bias = Float64Array.from(data.layers[l].bias);
            }
        }
    }

    getStats() {
        return {
            updateCount: this.updateCount,
            learningRate: this.lr,
        };
    }
}

module.exports = LearnablePredictor;
