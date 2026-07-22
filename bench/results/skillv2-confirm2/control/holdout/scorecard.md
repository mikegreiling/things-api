# AGENTBENCH scorecard

- git: `4c49dc08b4b949a35e185af6d91ee0dc94721a01`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T20:54:27.059Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 10 | 100% | 0 | 0.6 | 38317.3 | 6963.2 | 408.3 | 4553 | 8821.7 | 7.5 | 7.1 | 17285.8 |
| skill | gpt-5.4-mini | gui-perception | 10 | 70% | 0 | 0.29 | 25544.71 | 3657.14 | 298.14 | 4553 | 7563.57 | 5.14 | 4.14 | 11550.14 |
| skill | gpt-5.4-mini | longtail | 10 | 90% | 0 | 1.22 | 21759.44 | 2673.78 | 287.67 | 4553 | 5806.67 | 5.56 | 4.56 | 15367 |
| skill | gpt-5.4-mini | writes | 10 | 100% | 0 | 0.7 | 18156.5 | 3072 | 223 | 4553 | 5264.1 | 5 | 4 | 10871 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
