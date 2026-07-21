# AGENTBENCH scorecard

- git: `d1b4eb83573fc3030f67de2e579d9580d7912a90`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T07:41:59.182Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 10 | 60% | 0 | 1.33 | 39007.67 | 5888 | 457.83 | 4494 | 10007.67 | 7 | 6 | 18766 |
| skill | gpt-5.4-mini | domain-reasoning | 10 | 60% | 0 | 1.33 | 13214.67 | 1024 | 215.33 | 4494 | 5309.83 | 4.17 | 3.17 | 9493.17 |
| skill | gpt-5.4-mini | gui-perception | 10 | 10% | 0 | 3 | 52190 | 15360 | 758 | 4494 | 10841 | 9 | 8 | 25840 |
| skill | gpt-5.4-mini | longtail | 20 | 100% | 0 | 1.5 | 28755 | 3635.2 | 349.85 | 4494 | 7954.85 | 6.35 | 5.5 | 18613.5 |
| skill | gpt-5.4-mini | reads | 10 | 100% | 0 | 0.8 | 20629.2 | 1228.8 | 307.3 | 4494 | 7358.1 | 5 | 4.1 | 13035.3 |
| skill | gpt-5.4-mini | recovery-safety | 10 | 100% | 0 | 0.8 | 20299.3 | 1075.2 | 269.7 | 4494 | 6100.8 | 5.1 | 4.1 | 11347.5 |
| skill | gpt-5.4-mini | writes | 10 | 100% | 0 | 0.7 | 21622.3 | 1075.2 | 251.6 | 4494 | 7435.3 | 5.2 | 4.2 | 11140.1 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
