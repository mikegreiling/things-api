# AGENTBENCH scorecard

- git: `d1b4eb83573fc3030f67de2e579d9580d7912a90`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T07:53:09.349Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 10 | 90% | 0 | 1.78 | 40876.78 | 8248.89 | 446.44 | 4494 | 10149.22 | 7.78 | 7.89 | 21043.44 |
| skill | gpt-5.4-mini | gui-perception | 10 | 90% | 0 | 0.67 | 27967.44 | 1592.89 | 349.22 | 4494 | 8429 | 5.78 | 4.78 | 14232.33 |
| skill | gpt-5.4-mini | longtail | 10 | 90% | 0 | 1.33 | 24617 | 3072 | 274.67 | 4494 | 7363.33 | 5.67 | 4.67 | 12099.56 |
| skill | gpt-5.4-mini | writes | 10 | 50% | 0 | 1 | 28118.4 | 4608 | 242.8 | 4494 | 8031 | 6.4 | 5.4 | 14830.4 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
