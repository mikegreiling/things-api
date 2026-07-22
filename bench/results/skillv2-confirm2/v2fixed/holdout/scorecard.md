# AGENTBENCH scorecard

- git: `4c49dc08b4b949a35e185af6d91ee0dc94721a01`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T20:27:32.356Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 10 | 100% | 0 | 1.2 | 37503.5 | 6656 | 468.2 | 4430 | 9431.5 | 7.8 | 7.8 | 19365.3 |
| skill | gpt-5.4-mini | gui-perception | 10 | 90% | 0 | 0.89 | 24362.89 | 1251.56 | 323 | 4430 | 8048.89 | 5.44 | 4.44 | 13117.78 |
| skill | gpt-5.4-mini | longtail | 10 | 70% | 0 | 2 | 24753.29 | 3510.86 | 311.86 | 4430 | 7418.43 | 6 | 5 | 14792.43 |
| skill | gpt-5.4-mini | writes | 10 | 100% | 0 | 0.8 | 16573.7 | 409.6 | 292.4 | 4430 | 6034.3 | 5 | 4 | 11650.8 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
