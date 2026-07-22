# AGENTBENCH scorecard

- git: `d1b4eb83573fc3030f67de2e579d9580d7912a90`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T08:10:01.968Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 10 | 60% | 0 | 2.83 | 44581.33 | 9130.67 | 507.5 | 4553 | 8320.5 | 8.17 | 7.67 | 19091.5 |
| skill | gpt-5.4-mini | domain-reasoning | 10 | 60% | 0 | 0.33 | 15307.33 | 5034.67 | 249.83 | 4553 | 5455.33 | 4.67 | 3.67 | 11773.17 |
| skill | gpt-5.4-mini | gui-perception | 10 | 10% | 0 | 1 | 22270 | 4096 | 354 | 4553 | 6756 | 5 | 4 | 14002 |
| skill | gpt-5.4-mini | longtail | 20 | 55% | 0 | 1.27 | 26247.82 | 3584 | 364.36 | 4553 | 6390.55 | 6.36 | 5.36 | 13562.73 |
| skill | gpt-5.4-mini | reads | 10 | 100% | 0 | 0.2 | 16581.2 | 358.4 | 209.9 | 4553 | 6033.9 | 4.5 | 3.7 | 9425.5 |
| skill | gpt-5.4-mini | recovery-safety | 10 | 100% | 0 | 1.3 | 20669.6 | 3379.2 | 214.5 | 4553 | 5629.2 | 5.5 | 4.5 | 10882.9 |
| skill | gpt-5.4-mini | writes | 10 | 100% | 0 | 0 | 15443.7 | 1689.6 | 210.6 | 4553 | 5571.1 | 4.4 | 3.4 | 9587.3 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._
