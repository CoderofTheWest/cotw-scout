# Source Handles Test Report

- PASS: 8
- FAIL: 0
- Total: 8

| Fixture | Status | Detail |
|---|---:|---|
| archive handle parses | PASS | archive |
| digest handle parses | PASS | digest |
| file handle line range parses | PASS | file |
| tool handle parses | PASS | tool |
| bad line range fails | PASS | endLine must be greater than or equal to startLine |
| unknown type fails | PASS | unsupported handle type: memory |
| makeSourceHandle creates valid commit handle | PASS | commit:8907f7a#bundled-plugins/openclaw-plugin-continuity/lib/build1-primitives.cjs |
| source refs normalize role/hash/rank | PASS | sha256:f0f3fc7744e7f4e1facf3b55e7e9b98e89319e63f9a1151f32ff81ff8bbb9df9 |
