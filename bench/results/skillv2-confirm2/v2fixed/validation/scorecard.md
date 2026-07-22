# AGENTBENCH scorecard

- git: `4c49dc08b4b949a35e185af6d91ee0dc94721a01`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T20:17:40.987Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 10 | 60% | 0 | 1 | 33869.83 | 7424 | 361.67 | 4430 | 9935.83 | 6 | 5.17 | 15477.67 |
| skill | gpt-5.4-mini | domain-reasoning | 10 | 70% | 0 | 1.14 | 15604 | 804.57 | 235.29 | 4430 | 5704.57 | 4.71 | 3.71 | 10970.86 |
| skill | gpt-5.4-mini | gui-perception | 10 | 50% | 0 | 1.8 | 25923.2 | 4300.8 | 325 | 4430 | 8205.4 | 5.8 | 5 | 12880.2 |
| skill | gpt-5.4-mini | longtail | 20 | 90% | 0 | 1.44 | 27063.06 | 5319.11 | 373.94 | 4430 | 7824.22 | 6.22 | 5.22 | 15273.39 |
| skill | gpt-5.4-mini | reads | 10 | 100% | 0 | 0.8 | 15716.1 | 2457.6 | 259.1 | 4430 | 6086.9 | 4.7 | 3.7 | 10550.3 |
| skill | gpt-5.4-mini | recovery-safety | 10 | 100% | 0 | 1.2 | 17375 | 1894.4 | 263.7 | 4430 | 5362.9 | 5.1 | 4.1 | 11691.2 |
| skill | gpt-5.4-mini | writes | 10 | 100% | 0 | 0.7 | 13908.5 | 1075.2 | 231 | 4430 | 5234.2 | 4.5 | 3.5 | 10473.7 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
