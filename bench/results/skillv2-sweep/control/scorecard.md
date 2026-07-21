# AGENTBENCH scorecard

- git: `de95e3681a83791bef7081d99fcdc131173fcfe2`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T05:02:52.598Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 9 | 100% | 0 | 2.67 | 59901.78 | 17351.11 | 642.33 | 4553 | 10589.78 | 9.56 | 9.44 | 22220.33 |
| skill | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0 | 9090.33 | 0 | 185.33 | 4553 | 4813.33 | 3 | 2 | 7091 |
| skill | gpt-5.4-mini | domain-reasoning | 9 | 56% | 0 | 0.4 | 15715.8 | 1433.6 | 213.6 | 4553 | 5794 | 4.2 | 3.2 | 9591.8 |
| skill | gpt-5.4-mini | gui-perception | 12 | 67% | 0 | 0.13 | 18283.5 | 1792 | 244 | 4553 | 6504.63 | 4.25 | 3.38 | 8497.63 |
| skill | gpt-5.4-mini | longtail | 18 | 61% | 0 | 1.27 | 32140.82 | 6237.09 | 349.64 | 4553 | 7519.82 | 6.27 | 5.27 | 14067.09 |
| skill | gpt-5.4-mini | reads | 9 | 89% | 0 | 0.13 | 13163.5 | 320 | 202.25 | 4553 | 5724 | 3.63 | 2.63 | 8238 |
| skill | gpt-5.4-mini | recovery-safety | 15 | 100% | 0 | 0.73 | 22537.67 | 3993.6 | 257 | 4553 | 6088.53 | 5.53 | 4.53 | 10675.47 |
| skill | gpt-5.4-mini | writes | 24 | 92% | 0 | 0.5 | 24630.27 | 3514.18 | 263.73 | 4553 | 6481.82 | 5.73 | 4.82 | 11088.59 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
