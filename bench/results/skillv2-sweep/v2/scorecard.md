# AGENTBENCH scorecard

- git: `de95e3681a83791bef7081d99fcdc131173fcfe2`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T05:25:18.573Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 9 | 67% | 0 | 2.33 | 49054.17 | 13994.67 | 586.17 | 4494 | 10683.17 | 8.5 | 9 | 21335.33 |
| skill | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0.33 | 8471.67 | 0 | 156.67 | 4494 | 4881.67 | 3 | 2 | 5417 |
| skill | gpt-5.4-mini | domain-reasoning | 9 | 67% | 0 | 0.67 | 15192.67 | 1450.67 | 242.67 | 4494 | 5080.17 | 5.17 | 4.17 | 9242.5 |
| skill | gpt-5.4-mini | gui-perception | 12 | 75% | 0 | 0.44 | 23033.67 | 2730.67 | 237 | 4494 | 7389.89 | 5.11 | 4.11 | 11436.22 |
| skill | gpt-5.4-mini | longtail | 18 | 78% | 0 | 1.79 | 28664.43 | 2048 | 331.07 | 4494 | 7805.79 | 6.29 | 5.29 | 12825.64 |
| skill | gpt-5.4-mini | reads | 9 | 100% | 0 | 0.78 | 16537.22 | 1649.78 | 279.56 | 4494 | 6784 | 4.56 | 3.67 | 11498.11 |
| skill | gpt-5.4-mini | recovery-safety | 15 | 100% | 0 | 1.07 | 22401.8 | 2491.73 | 349.67 | 4494 | 6957.13 | 5.73 | 4.87 | 14693.53 |
| skill | gpt-5.4-mini | writes | 24 | 96% | 0 | 0.96 | 25094.26 | 3472.7 | 316.74 | 4494 | 7647.52 | 5.91 | 5.3 | 12623.91 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
