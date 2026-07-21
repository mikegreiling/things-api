# AGENTBENCH scorecard

- git: `de95e3681a83791bef7081d99fcdc131173fcfe2`
- models: `gpt-5.4-mini`
- prompt hashes: cli=`49f40bf36ef0`
- generated: 2026-07-21T05:46:00.978Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cli | gpt-5.4-mini | compound | 9 | 67% | 0 | 1.33 | 24303.33 | 4437.33 | 350 | 280 | 7326.67 | 6.83 | 6.33 | 14678.33 |
| cli | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0 | 3381 | 0 | 88 | 280 | 2043.67 | 3 | 2 | 4889.33 |
| cli | gpt-5.4-mini | domain-reasoning | 9 | 33% | 0 | 0 | 8621.33 | 341.33 | 171 | 280 | 3083.33 | 5.33 | 4.33 | 9764.67 |
| cli | gpt-5.4-mini | gui-perception | 12 | 58% | 0 | 1.14 | 17563.57 | 2340.57 | 199.57 | 280 | 5943 | 6 | 5 | 11594.14 |
| cli | gpt-5.4-mini | longtail | 18 | 94% | 0 | 1.47 | 17692.71 | 2710.59 | 245.88 | 280 | 5769.29 | 6.24 | 5.24 | 12229.71 |
| cli | gpt-5.4-mini | reads | 9 | 89% | 0 | 0.38 | 46420.13 | 9664 | 218.13 | 280 | 10630.13 | 5 | 4 | 10442.38 |
| cli | gpt-5.4-mini | recovery-safety | 15 | 100% | 0 | 1 | 13129.53 | 1228.8 | 195.87 | 280 | 4429.53 | 5.93 | 5.07 | 10972.87 |
| cli | gpt-5.4-mini | writes | 24 | 83% | 0 | 0.6 | 19566.9 | 3609.6 | 202 | 280 | 6506.45 | 6.6 | 5.6 | 11982.15 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
